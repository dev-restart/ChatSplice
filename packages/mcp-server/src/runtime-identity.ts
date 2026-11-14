import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeIdentity {
  readonly build_id: string;
  readonly run_id: string;
}

export interface RuntimeCodePath {
  readonly label: string;
  readonly path: string;
}

const MAX_CODE_FILES = 2_048;
const MAX_DIRECTORY_ENTRIES = 8_192;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const CODE_EXTENSION = /\.(?:cjs|mjs|js|ts)$/u;
const EXCLUDED_EXTENSION = /(?:\.test\.(?:cjs|mjs|js|ts)|\.d\.ts)$/u;
let cachedIdentity: RuntimeIdentity | undefined;

/** Hash the deployed code bytes, without including machine-specific absolute paths. */
export function hashRuntimeCodePaths(paths: readonly RuntimeCodePath[]): string {
  if (paths.length === 0 || paths.length > 16) {
    throw new Error('Runtime identity requires a bounded, nonempty code path list.');
  }
  const labels = paths.map(({ label }) => label);
  if (
    new Set(labels).size !== labels.length ||
    labels.some((label) => !/^[a-z0-9_-]{1,64}$/u.test(label))
  ) {
    throw new Error('Runtime identity code labels must be unique and bounded.');
  }
  const hash = createHash('sha256').update('chatsplice-runtime-code-v1\n');
  let entriesRead = 0;
  let filesRead = 0;
  let bytesRead = 0;

  function visit(label: string, rootPath: string, codePath: string, depth: number): void {
    if (depth > MAX_DEPTH || ++entriesRead > MAX_DIRECTORY_ENTRIES) {
      throw new Error('Runtime identity code discovery exceeded its limit.');
    }
    const entry = lstatSync(codePath);
    if (entry.isSymbolicLink()) {
      throw new Error('Runtime identity code paths must not contain symbolic links.');
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(codePath).sort()) {
        visit(label, rootPath, join(codePath, name), depth + 1);
      }
      return;
    }
    if (!entry.isFile()) {
      throw new Error('Runtime identity encountered an unsupported code entry.');
    }
    if (!CODE_EXTENSION.test(codePath) || EXCLUDED_EXTENSION.test(codePath)) {
      return;
    }
    if (
      ++filesRead > MAX_CODE_FILES ||
      entry.size > MAX_FILE_BYTES ||
      bytesRead + entry.size > MAX_TOTAL_BYTES
    ) {
      throw new Error('Runtime identity code bytes exceeded their limit.');
    }
    const descriptor = openSync(codePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino ||
        opened.size !== entry.size
      ) {
        throw new Error('Runtime identity code changed while being opened.');
      }
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) {
          throw new Error('Runtime identity code changed while being read.');
        }
        offset += count;
      }
      const end = fstatSync(descriptor);
      if (
        readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 ||
        end.size !== opened.size ||
        end.mtimeMs !== opened.mtimeMs
      ) {
        throw new Error('Runtime identity code changed while being read.');
      }
      const codeName = relative(rootPath, codePath).split('\\').join('/') || basename(codePath);
      hash.update(JSON.stringify([label, codeName, bytes.length]));
      hash.update('\n');
      hash.update(bytes);
      hash.update('\n');
      bytesRead += bytes.length;
    } finally {
      closeSync(descriptor);
    }
  }

  for (const { label, path } of [...paths].sort((left, right) =>
    left.label.localeCompare(right.label),
  )) {
    const before = filesRead;
    visit(label, path, path, 0);
    if (filesRead === before) {
      throw new Error('Runtime identity code path contains no executable code.');
    }
  }
  return hash.digest('hex');
}

/** Cached per process so an on-disk rebuild cannot relabel a daemon already running. */
export function getRuntimeIdentitySync(): RuntimeIdentity {
  if (cachedIdentity !== undefined) {
    return cachedIdentity;
  }
  const modulePath = fileURLToPath(import.meta.url);
  let paths: RuntimeCodePath[];
  if (/^runtime-identity\.(?:js|ts|mjs|cjs)$/u.test(basename(modulePath))) {
    const requireFromRuntime = createRequire(import.meta.url);
    paths = [
      { label: 'mcp-server', path: dirname(modulePath) },
      { label: 'core', path: dirname(requireFromRuntime.resolve('@chatsplice/core')) },
      { label: 'protocol', path: dirname(requireFromRuntime.resolve('@chatsplice/protocol')) },
    ];
  } else {
    // package-daemon.mjs replaces import.meta.url with the executing CJS bundle URL.
    // All three workspace packages and the execution SDK are bundled in that file.
    paths = [{ label: 'daemon-bundle', path: modulePath }];
  }
  cachedIdentity = Object.freeze({ build_id: hashRuntimeCodePaths(paths), run_id: randomUUID() });
  return cachedIdentity;
}

export async function getRuntimeIdentity(): Promise<RuntimeIdentity> {
  return getRuntimeIdentitySync();
}
