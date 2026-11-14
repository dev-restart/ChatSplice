import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { ChatSpliceError } from '../errors.js';

const MAX_ANCESTOR_PROFILE_BYTES = 64 * 1024;
const PROTECTED_PATHS_MARKER = '(deny file-read-data file-map-executable file-write*';

/** Local development needs listeners even while dependency downloads stay offline. */
export const LOCAL_NETWORK_SANDBOX_PROFILE = [
  '(deny network*)',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow system-socket (socket-domain AF_UNIX))',
  '(allow network-bind (local unix-socket (subpath (param "WORKSPACE"))))',
  '(allow network-bind (local unix-socket (subpath (param "RUNTIME"))))',
  '(allow network-outbound (remote unix-socket (subpath (param "WORKSPACE"))))',
  '(allow network-outbound (remote unix-socket (subpath (param "RUNTIME"))))',
].join('\n');

const DEVELOPMENT_IO_PROFILE = [
  // Read local host mappings without changing the command's network policy.
  '(allow file-read-data (literal "/private/etc/hosts"))',
  '(allow pseudo-tty)',
  '(allow file-read* file-read-data file-write* file-ioctl (literal "/dev/ptmx"))',
  '(allow file-read* file-read-data file-write* file-ioctl',
  '  (require-all',
  '    (regex #"^/dev/ttys[0-9]+$")',
  '    (extension "com.apple.sandbox.pty")))',
  // Only the fresh job-private tree may supply a hard-link source. The
  // surrounding file-write policy still governs the destination. Project,
  // cache, reference and host sources retain the blanket file-link denial.
  '(allow file-link (subpath (param "RUNTIME")))',
].join('\n');

/** Installed runtimes are shared by every command, including children of Node/Rust checks. */
export function developmentToolReadRoots(userHome = homedir()): string[] {
  return [
    '/opt/homebrew',
    '/usr/local',
    '/Library/Developer',
    '/Library/Frameworks',
    '/Applications/Xcode.app/Contents/Developer',
    ...[
      '.nvm/versions',
      '.local/share/uv',
      '.local/bin',
      '.rustup',
      '.cargo/bin',
      '.pyenv',
      '.asdf',
      '.local/share/mise',
      '.bun/bin',
      '.volta',
      'sdk',
    ].map((path) => join(userHome, path)),
  ];
}

/** Build tools may inspect their own repository but cannot alter or execute its control files. */
export function structuredGitReadOnlyProfile(parameter = 'WORKSPACE'): string {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(parameter)) {
    throw new ChatSpliceError('BAD_REQUEST', 'Invalid repository sandbox parameter.');
  }
  const root = `(regex-quote (param "${parameter}"))`;
  const git = '[.][gG][iI][tT]';
  return [
    '(deny file-write* file-map-executable file-link',
    `  (regex (string-append "^" ${root} #"/([^/]+/)*${git}(/|$)")))`,
    '(deny file-read-data',
    `  (regex (string-append "^" ${root} #"/([^/]+/)*${git}/([hH][oO][oO][kK][sS]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS]([.][^/]*)?)(/|$)")))`,
  ].join('\n');
}

/** Permit descriptor traversal; this grants ancestor directory names, not sibling file contents. */
export function ancestorDirectoryReadProfile(canonicalRoots: readonly string[]): string {
  const directories = new Set<string>();
  for (const root of canonicalRoots) {
    if (!isAbsolute(root) || root.length > 4096 || /\p{Cc}/u.test(root)) {
      throw new ChatSpliceError('BAD_REQUEST', 'Execution ancestor paths must be absolute.');
    }
    for (let directory = dirname(root); ; directory = dirname(directory)) {
      directories.add(directory);
      if (directory === '/') break;
    }
  }
  if (directories.size === 0) return '';
  const literals = [...directories].map((directory) => `(literal ${JSON.stringify(directory)})`);
  const profile = `\n(allow file-read-data (require-all (vnode-type DIRECTORY) (require-any ${literals.join(' ')})))`;
  if (Buffer.byteLength(profile, 'utf8') > MAX_ANCESTOR_PROFILE_BYTES) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'Execution ancestor directory rules exceed the limit.',
    );
  }
  return profile;
}

/**
 * Add command-only capabilities before the existing protected-path denials.
 * Metadata/toolchain inspection must keep using its separate restricted profile.
 */
export function developmentSandboxProfile(
  baseProfile: string,
  canonicalRoots: readonly string[],
): string {
  const position = baseProfile.indexOf(PROTECTED_PATHS_MARKER);
  if (position < 0) {
    throw new ChatSpliceError('BAD_REQUEST', 'The execution sandbox profile is incomplete.');
  }
  const runtimeRoots = developmentToolReadRoots();
  const runtimeReads = [
    '(allow file-read-data file-map-executable',
    ...runtimeRoots.map((root) => `  (subpath ${JSON.stringify(root)})`),
    ')',
  ].join('\n');
  const development = `${DEVELOPMENT_IO_PROFILE}\n${runtimeReads}${ancestorDirectoryReadProfile([...canonicalRoots, ...runtimeRoots])}`;
  return `${baseProfile.slice(0, position)}${development}\n${baseProfile.slice(position)}`;
}
