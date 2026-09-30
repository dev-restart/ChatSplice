import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FsEditInput, FsEditResult } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';
import { resolveExistingWorkspaceFile } from './path-policy.js';

import { assertRealParent, readCheckedFile } from './checked-file.js';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ChatSpliceError(
      'UNSUPPORTED_ENCODING',
      'fs.edit supports valid UTF-8 text files only.',
    );
  }
}

function exactMatchIndices(content: string, needle: string): number[] {
  const indices: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) break;
    indices.push(index);
    offset = index + needle.length;
  }
  return indices;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/gu, '\n');
}

function normalizeNewlinesWithRawOffsets(value: string): {
  normalized: string;
  rawOffsets: number[];
} {
  let normalized = '';
  const rawOffsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    rawOffsets.push(index);
    if (value[index] === '\r' && value[index + 1] === '\n') {
      normalized += '\n';
      index += 1;
    } else {
      normalized += value[index];
    }
  }
  rawOffsets.push(value.length);
  return { normalized, rawOffsets };
}

async function editWorkspaceFileUnlocked(
  workspaceService: WorkspaceService,
  input: FsEditInput,
): Promise<FsEditResult> {
  const workspace = workspaceService.getRecord(input.workspace_id);
  if (workspace.kind !== 'user') {
    throw new ChatSpliceError('BAD_REQUEST', 'fs.edit is available only for user workspaces.');
  }
  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.path,
    'fs.edit',
  );
  const { bytes: sourceBytes, metadata: checkedStat } = await readCheckedFile(
    canonicalTarget,
    MAX_SOURCE_BYTES,
  );

  const previousSha256 = sha256(sourceBytes);
  if (previousSha256 !== input.expected_sha256) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'The file changed after fs.read. Read this exact file once more and retry with the new sha256.',
    );
  }

  const decoded = decodeUtf8(sourceBytes);
  let edited = decoded;
  let replacements = 0;
  for (const edit of input.edits) {
    const oldText = normalizeNewlines(edit.old_text);
    const newText = normalizeNewlines(edit.new_text);
    const { normalized, rawOffsets } = normalizeNewlinesWithRawOffsets(edited);
    const matchIndices = exactMatchIndices(normalized, oldText);
    const count = matchIndices.length;
    if (count === 0) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'An fs.edit old_text value no longer matches the current file. Re-read the exact range and retry once.',
      );
    }
    if (!edit.replace_all && count !== 1) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `An fs.edit old_text value matched ${count} locations. Provide a larger unique block or set replace_all explicitly.`,
      );
    }
    const selectedIndices = edit.replace_all ? matchIndices : matchIndices.slice(0, 1);
    for (const matchIndex of [...selectedIndices].reverse()) {
      const rawStart = rawOffsets[matchIndex];
      const rawEnd = rawOffsets[matchIndex + oldText.length];
      const matchedRawText = edited.slice(rawStart, rawEnd);
      const replacement = matchedRawText.includes('\r\n')
        ? newText.replace(/\n/gu, '\r\n')
        : newText;
      edited = `${edited.slice(0, rawStart)}${replacement}${edited.slice(rawEnd)}`;
    }
    replacements += selectedIndices.length;
  }

  const encoded = Buffer.from(edited, 'utf8');
  if (encoded.byteLength > MAX_SOURCE_BYTES) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      `The edited file exceeds the ${MAX_SOURCE_BYTES} byte direct-edit limit. Split the change into smaller edits.`,
    );
  }

  const temporaryPath = join(
    dirname(canonicalTarget),
    `.chatsplice-edit-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const temporaryHandle = await open(temporaryPath, 'wx', checkedStat.mode & 0o777);
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
    await chmod(temporaryPath, checkedStat.mode & 0o777);
    await assertRealParent(canonicalTarget);
    const current = await readCheckedFile(canonicalTarget, MAX_SOURCE_BYTES);
    if (
      current.metadata.ino !== checkedStat.ino ||
      current.metadata.dev !== checkedStat.dev ||
      sha256(current.bytes) !== previousSha256
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'The file changed while the edit was prepared. Read it again.',
      );
    }
    await rename(temporaryPath, canonicalTarget);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.display_name,
    path: input.path,
    previous_sha256: previousSha256,
    sha256: sha256(encoded),
    replacements,
    bytes_written: encoded.byteLength,
  };
}

export function editWorkspaceFile(
  workspaceService: WorkspaceService,
  input: FsEditInput,
): Promise<FsEditResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    editWorkspaceFileUnlocked(workspaceService, input),
  );
}
