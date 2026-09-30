import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  FsDeleteInput,
  FsDeleteResult,
  FsMkdirInput,
  FsMkdirResult,
  FsRenameInput,
  FsRenameResult,
  FsWriteInput,
  FsWriteResult,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';
import { resolveExistingWorkspaceFile, resolveNewWorkspacePath } from './path-policy.js';

import { assertRealParent, readCheckedFile } from './checked-file.js';

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertUserWorkspace(
  workspaceService: WorkspaceService,
  workspaceId: string,
): {
  displayName: string;
} {
  const workspace = workspaceService.getRecord(workspaceId);
  if (workspace.kind !== 'user') {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'Direct filesystem mutation is available only for user workspaces.',
    );
  }
  return { displayName: workspace.display_name };
}

async function assertDestinationAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ChatSpliceError('BAD_REQUEST', 'The destination path already exists.');
}

async function readVerifiedRegularFile(
  canonicalTarget: string,
  expectedSha256: string,
  operation: string,
): Promise<{ mode: number; dev: number; ino: number; sha256: string }> {
  const { bytes, metadata: checkedStat } = await readCheckedFile(
    canonicalTarget,
    MAX_TEXT_FILE_BYTES,
  );

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ChatSpliceError(
      'UNSUPPORTED_ENCODING',
      `${operation} supports valid UTF-8 text files only.`,
    );
  }

  const currentSha256 = sha256(bytes);
  if (currentSha256 !== expectedSha256) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      `The file changed after fs.read. Read it again before calling ${operation}.`,
    );
  }
  return {
    mode: checkedStat.mode & 0o777,
    dev: checkedStat.dev,
    ino: checkedStat.ino,
    sha256: currentSha256,
  };
}

async function writeTemporaryFile(
  targetPath: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const temporaryPath = join(
    dirname(targetPath),
    `.chatsplice-write-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const handle = await open(temporaryPath, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, mode);
  return temporaryPath;
}

async function writeWorkspaceFileUnlocked(
  workspaceService: WorkspaceService,
  input: FsWriteInput,
): Promise<FsWriteResult> {
  const workspace = assertUserWorkspace(workspaceService, input.workspace_id);
  const encoded = Buffer.from(input.content, 'utf8');
  if (encoded.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      `The new content exceeds the ${MAX_TEXT_FILE_BYTES} byte direct-mutation limit.`,
    );
  }

  if (input.mode === 'create') {
    const { targetPath } = await resolveNewWorkspacePath(
      workspaceService,
      input.workspace_id,
      input.path,
      'fs.write',
    );
    await assertDestinationAbsent(targetPath);
    const temporaryPath = await writeTemporaryFile(targetPath, encoded, 0o644);
    try {
      await assertRealParent(targetPath);
      await link(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ChatSpliceError('BAD_REQUEST', 'The destination path already exists.');
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return {
      workspace_id: input.workspace_id,
      workspace_name: workspace.displayName,
      path: input.path,
      mode: input.mode,
      previous_sha256: null,
      sha256: sha256(encoded),
      bytes_written: encoded.byteLength,
    };
  }

  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.path,
    'fs.write',
  );
  const source = await readVerifiedRegularFile(canonicalTarget, input.expected_sha256, 'fs.write');
  const temporaryPath = await writeTemporaryFile(canonicalTarget, encoded, source.mode);
  try {
    await assertRealParent(canonicalTarget);
    await readVerifiedRegularFile(canonicalTarget, source.sha256, 'fs.write');
    await rename(temporaryPath, canonicalTarget);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.displayName,
    path: input.path,
    mode: input.mode,
    previous_sha256: source.sha256,
    sha256: sha256(encoded),
    bytes_written: encoded.byteLength,
  };
}

async function makeWorkspaceDirectoryUnlocked(
  workspaceService: WorkspaceService,
  input: FsMkdirInput,
): Promise<FsMkdirResult> {
  const workspace = assertUserWorkspace(workspaceService, input.workspace_id);
  const { targetPath } = await resolveNewWorkspacePath(
    workspaceService,
    input.workspace_id,
    input.path,
    'fs.mkdir',
  );
  await assertDestinationAbsent(targetPath);
  await assertRealParent(targetPath);
  await mkdir(targetPath, { mode: 0o755 });
  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.displayName,
    path: input.path,
    created: true,
  };
}

async function renameWorkspaceFileUnlocked(
  workspaceService: WorkspaceService,
  input: FsRenameInput,
): Promise<FsRenameResult> {
  const workspace = assertUserWorkspace(workspaceService, input.workspace_id);
  if (input.source_path === input.destination_path) {
    throw new ChatSpliceError('BAD_REQUEST', 'Source and destination paths must be different.');
  }
  const { canonicalTarget: sourcePath } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.source_path,
    'fs.rename',
  );
  const source = await readVerifiedRegularFile(sourcePath, input.expected_sha256, 'fs.rename');
  const { targetPath: destinationPath } = await resolveNewWorkspacePath(
    workspaceService,
    input.workspace_id,
    input.destination_path,
    'fs.rename',
  );
  await assertDestinationAbsent(destinationPath);
  await assertRealParent(sourcePath);
  await assertRealParent(destinationPath);
  await readVerifiedRegularFile(sourcePath, source.sha256, 'fs.rename');
  await link(sourcePath, destinationPath);
  try {
    await unlink(sourcePath);
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    throw error;
  }
  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.displayName,
    source_path: input.source_path,
    destination_path: input.destination_path,
    sha256: source.sha256,
  };
}

async function deleteWorkspaceFileUnlocked(
  workspaceService: WorkspaceService,
  input: FsDeleteInput,
): Promise<FsDeleteResult> {
  const workspace = assertUserWorkspace(workspaceService, input.workspace_id);
  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.path,
    'fs.delete',
  );
  const source = await readVerifiedRegularFile(canonicalTarget, input.expected_sha256, 'fs.delete');
  await assertRealParent(canonicalTarget);
  await readVerifiedRegularFile(canonicalTarget, source.sha256, 'fs.delete');
  await unlink(canonicalTarget);
  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.displayName,
    path: input.path,
    deleted_sha256: source.sha256,
  };
}

export function writeWorkspaceFile(
  workspaceService: WorkspaceService,
  input: FsWriteInput,
): Promise<FsWriteResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    writeWorkspaceFileUnlocked(workspaceService, input),
  );
}

export function makeWorkspaceDirectory(
  workspaceService: WorkspaceService,
  input: FsMkdirInput,
): Promise<FsMkdirResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    makeWorkspaceDirectoryUnlocked(workspaceService, input),
  );
}

export function renameWorkspaceFile(
  workspaceService: WorkspaceService,
  input: FsRenameInput,
): Promise<FsRenameResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    renameWorkspaceFileUnlocked(workspaceService, input),
  );
}

export function deleteWorkspaceFile(
  workspaceService: WorkspaceService,
  input: FsDeleteInput,
): Promise<FsDeleteResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    deleteWorkspaceFileUnlocked(workspaceService, input),
  );
}
