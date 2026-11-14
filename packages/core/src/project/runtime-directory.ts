import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSpliceError } from '../errors.js';

function invalidRuntime(message: string): never {
  throw new ChatSpliceError('BAD_REQUEST', message);
}

/** Short per-job paths leave room for macOS Unix sockets without granting all of /tmp. */
export async function createProjectRuntimeDirectory(kind: 'exec' | 'run'): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) invalidRuntime('The private runtime owner could not be determined.');
  const requestedParent = platform() === 'darwin' ? '/private/tmp' : tmpdir();
  const parent = await realpath(requestedParent);
  if (platform() === 'darwin' && parent !== requestedParent) {
    invalidRuntime('The macOS private runtime parent must be canonical.');
  }
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (parentMetadata.uid !== 0 && parentMetadata.uid !== uid) ||
    ((parentMetadata.mode & 0o022) !== 0 && (parentMetadata.mode & 0o1000) === 0)
  ) {
    invalidRuntime('The private runtime parent is not a trusted directory.');
  }
  const directory = await mkdtemp(join(parent, kind === 'exec' ? 'cs-e-' : 'cs-r-'));
  let created: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    created = await lstat(directory);
    if (
      !created.isDirectory() ||
      created.isSymbolicLink() ||
      created.uid !== uid ||
      (created.mode & 0o777) !== 0o700
    ) {
      invalidRuntime('The job runtime must be a private 0700 directory owned by the current user.');
    }
    if ((await realpath(directory)) !== directory) {
      invalidRuntime('The job runtime may not traverse a symbolic link.');
    }
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== created.dev ||
      current.ino !== created.ino ||
      current.uid !== uid ||
      (current.mode & 0o777) !== 0o700
    ) {
      invalidRuntime('The job runtime changed while it was being prepared.');
    }
    return directory;
  } catch (error) {
    // Nothing has executed in this directory yet. Remove only the same empty,
    // owned directory; never recursively delete an unverified replacement.
    if (created?.isDirectory() && !created.isSymbolicLink() && created.uid === uid) {
      try {
        const currentParent = await lstat(parent);
        const current = await lstat(directory);
        if (
          currentParent.dev === parentMetadata.dev &&
          currentParent.ino === parentMetadata.ino &&
          !currentParent.isSymbolicLink() &&
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.uid === uid &&
          current.dev === created.dev &&
          current.ino === created.ino
        ) {
          await rmdir(directory);
        }
      } catch {
        // Preserve the original validation failure if the empty path changed.
      }
    }
    throw error;
  }
}
