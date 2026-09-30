import { createHash } from 'node:crypto';

import type { FsReadInput, FsReadResult } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';
import { resolveExistingWorkspaceFile } from './path-policy.js';

import { readCheckedFile } from './checked-file.js';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_LINES = 2_000;
function truncateUtf8(input: string, maxBytes: number): { text: string; truncated: boolean } {
  let byteCount = 0;
  let output = '';
  for (const character of input) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteCount + characterBytes > maxBytes) {
      return { text: output, truncated: true };
    }
    output += character;
    byteCount += characterBytes;
  }
  return { text: output, truncated: false };
}

function logicalLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

export async function readWorkspaceFile(
  workspaceService: WorkspaceService,
  input: FsReadInput,
): Promise<FsReadResult> {
  const workspace = workspaceService.getRecord(input.workspace_id);
  const { canonicalTarget } = await resolveExistingWorkspaceFile(
    workspaceService,
    input.workspace_id,
    input.path,
    'fs.read',
  );

  const { bytes } = await readCheckedFile(canonicalTarget, MAX_SOURCE_BYTES);

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ChatSpliceError(
      'UNSUPPORTED_ENCODING',
      'fs.read supports valid UTF-8 text files only in Milestone 0.',
    );
  }

  const allLines = logicalLines(decoded);
  const firstLine = input.start_line ?? 1;
  const requestedEndLine = input.end_line ?? allLines.length;
  const cappedEndLine = Math.min(requestedEndLine, firstLine + MAX_OUTPUT_LINES - 1);
  const selectedLines = allLines.slice(firstLine - 1, cappedEndLine);
  const selectedText = selectedLines.join('\n');
  const byteLimited = truncateUtf8(selectedText, input.max_bytes);
  const returnedLineCount = logicalLines(byteLimited.text).length;
  const actualEndLine = returnedLineCount === 0 ? 0 : firstLine + returnedLineCount - 1;
  const lineTruncated = cappedEndLine < requestedEndLine || requestedEndLine < allLines.length;

  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.display_name,
    path: input.path,
    content: byteLimited.text,
    start_line: firstLine,
    end_line: actualEndLine,
    total_lines: allLines.length,
    bytes_returned: Buffer.byteLength(byteLimited.text, 'utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    truncated: byteLimited.truncated || lineTruncated,
  };
}
