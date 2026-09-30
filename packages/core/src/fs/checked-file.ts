import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ChatSpliceError } from '../errors.js';

/** Reject aliases and bound the actual read, including a file that grows after stat. */
export async function readCheckedFile(
  path: string,
  maximumBytes: number,
): Promise<{ bytes: Buffer; metadata: Stats }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new ChatSpliceError(
      'PATH_NOT_FILE',
      'Only regular files without symbolic or hard links are supported.',
    );
  }
  if (metadata.size > maximumBytes)
    throw new ChatSpliceError('BAD_REQUEST', 'The file exceeds the bounded source limit.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.nlink !== 1) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'The file changed while its path was verified. Retry.',
      );
    }
    const buffer = Buffer.alloc(Math.min(maximumBytes + 1, Math.max(metadata.size + 1, 4096)));
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maximumBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maximumBytes + 1 - size),
        null,
      );
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      size += bytesRead;
    }
    if (size > maximumBytes)
      throw new ChatSpliceError('BAD_REQUEST', 'The file exceeds the bounded source limit.');
    return { bytes: Buffer.concat(chunks), metadata };
  } finally {
    await handle.close();
  }
}

export async function assertRealParent(path: string): Promise<void> {
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'The file parent changed during the operation.',
    );
  }
}
