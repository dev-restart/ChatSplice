import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EDITOR_MAX_DOCUMENT_BYTES } from '@chatsplice/protocol';
import type {
  WorkspaceEditorFile,
  WorkspaceEditorReadInput,
  WorkspaceEditorSaveInput,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';
import { assertRealParent, readCheckedFile } from './checked-file.js';
import { resolveExistingWorkspaceFile } from './path-policy.js';

/** Full-file owner editor limit. The MCP preview limit remains unchanged. */
export const MAX_WORKSPACE_EDITOR_FILE_BYTES = EDITOR_MAX_DOCUMENT_BYTES;

/** A save was based on bytes that are no longer current. */
export class WorkspaceEditorConflictError extends ChatSpliceError {
  public constructor(message: string) {
    super('BAD_REQUEST', message);
    this.name = 'WorkspaceEditorConflictError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\u0000')) {
      throw new Error('NUL byte');
    }
    return content;
  } catch {
    throw new ChatSpliceError(
      'UNSUPPORTED_ENCODING',
      'The workspace editor supports valid UTF-8 text files only.',
    );
  }
}

function assertUserWorkspace(workspaceService: WorkspaceService, workspaceId: string): void {
  if (workspaceService.getRecord(workspaceId).kind !== 'user') {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The workspace editor is available only for registered user workspaces.',
    );
  }
}

async function readEditorFile(
  workspaceService: WorkspaceService,
  workspaceId: string,
  path: string,
): Promise<{ bytes: Buffer; dev: number; ino: number; mode: number }> {
  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    workspaceId,
    path,
    'workspace editor',
  );
  const checked = await readCheckedFile(canonicalTarget, MAX_WORKSPACE_EDITOR_FILE_BYTES);
  return {
    bytes: checked.bytes,
    dev: checked.metadata.dev,
    ino: checked.metadata.ino,
    mode: checked.metadata.mode & 0o777,
  };
}

export async function readWorkspaceEditorFile(
  workspaceService: WorkspaceService,
  input: WorkspaceEditorReadInput,
): Promise<WorkspaceEditorFile> {
  assertUserWorkspace(workspaceService, input.workspace_id);
  const checked = await readEditorFile(workspaceService, input.workspace_id, input.path);
  return {
    workspace_id: input.workspace_id,
    path: input.path,
    content: decodeUtf8(checked.bytes),
    sha256: sha256(checked.bytes),
  };
}

async function saveWorkspaceEditorFileUnlocked(
  workspaceService: WorkspaceService,
  input: WorkspaceEditorSaveInput,
): Promise<WorkspaceEditorFile> {
  assertUserWorkspace(workspaceService, input.workspace_id);
  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.path,
    'workspace editor',
  );
  const source = await readCheckedFile(canonicalTarget, MAX_WORKSPACE_EDITOR_FILE_BYTES);
  decodeUtf8(source.bytes);
  const previousSha256 = sha256(source.bytes);
  if (previousSha256 !== input.expected_sha256) {
    throw new WorkspaceEditorConflictError(
      'The file changed after the editor read. Read this exact file once more and retry.',
    );
  }

  const encoded = Buffer.from(input.content, 'utf8');
  const encodedContent = decodeUtf8(encoded);
  if (encodedContent !== input.content) {
    throw new ChatSpliceError(
      'UNSUPPORTED_ENCODING',
      'The workspace editor accepts well-formed UTF-8 text only.',
    );
  }
  if (encoded.byteLength > MAX_WORKSPACE_EDITOR_FILE_BYTES) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      `The edited file exceeds the ${MAX_WORKSPACE_EDITOR_FILE_BYTES} byte editor limit.`,
    );
  }

  const temporaryPath = join(
    dirname(canonicalTarget),
    `.chatsplice-editor-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const temporaryHandle = await open(temporaryPath, 'wx', source.metadata.mode & 0o777);
  try {
    await temporaryHandle.writeFile(encoded);
    await temporaryHandle.sync();
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await temporaryHandle.close();
  }

  try {
    await chmod(temporaryPath, source.metadata.mode & 0o777);
    await assertRealParent(canonicalTarget);
    const current = await readCheckedFile(canonicalTarget, MAX_WORKSPACE_EDITOR_FILE_BYTES);
    if (
      current.metadata.dev !== source.metadata.dev ||
      current.metadata.ino !== source.metadata.ino ||
      sha256(current.bytes) !== previousSha256
    ) {
      throw new WorkspaceEditorConflictError(
        'The file changed while the editor save was prepared. Read it again and retry.',
      );
    }
    await rename(temporaryPath, canonicalTarget);
    const written = await readCheckedFile(canonicalTarget, MAX_WORKSPACE_EDITOR_FILE_BYTES);
    const writtenSha256 = sha256(written.bytes);
    if (writtenSha256 !== sha256(encoded)) {
      throw new WorkspaceEditorConflictError(
        'The file changed immediately after the editor save. Read it again before continuing.',
      );
    }
    const writtenContent = decodeUtf8(written.bytes);
    return {
      workspace_id: input.workspace_id,
      path: input.path,
      content: writtenContent,
      sha256: writtenSha256,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function saveWorkspaceEditorFile(
  workspaceService: WorkspaceService,
  input: WorkspaceEditorSaveInput,
): Promise<WorkspaceEditorFile> {
  return workspaceService.withOperation(input.workspace_id, () =>
    saveWorkspaceEditorFileUnlocked(workspaceService, input),
  );
}
