import { homedir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_NETWORK_SANDBOX_PROFILE } from './development-sandbox.js';

/** Developer commands can consume project configuration; writes remain project-local. */
export function shellSandboxProfile(network: boolean): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-link)',
    '(deny file-write*)',
    '(allow file-write* (subpath (param "WORKSPACE")) (subpath (param "RUNTIME"))',
    '  (subpath (param "CARGO_HOME"))',
    '  (subpath (param "CARGO_TOOL_HOME")))',
    '(deny file-read-data file-map-executable)',
    '(allow file-read-data file-map-executable',
    '  (subpath (param "WORKSPACE")) (subpath (param "RUNTIME"))',
    '  (subpath (param "CARGO_HOME"))',
    '  (subpath (param "CARGO_TOOL_HOME"))',
    '  (subpath (param "NODE_RUNTIME_ROOT")) (subpath (param "COREPACK_CACHE"))',
    '  (subpath (param "USER_NVM")) (subpath (param "USER_UV"))',
    '  (subpath (param "USER_LOCAL_BIN")) (subpath (param "USER_RUSTUP"))',
    '  (subpath (param "USER_CARGO_BIN")) (subpath (param "USER_PYENV"))',
    '  (subpath "/opt/homebrew") (subpath "/usr/local")',
    '  (subpath "/Library/Developer") (subpath "/Library/Apple")',
    '  (subpath "/Library/Frameworks")',
    '  (subpath "/Applications/Xcode.app/Contents/Developer")',
    '  (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")',
    '  (subpath "/private/etc") (subpath "/private/var/db/timezone")',
    '  (subpath "/dev") (literal "/"))',
    '(allow file-write-data (literal "/dev/null"))',
    // Shared dependency state must not persist Cargo configuration or credentials.
    '(deny file-read-data file-map-executable file-write* file-link',
    '  (regex (string-append "^" (regex-quote (param "CARGO_HOME")) #"/(config([.]toml)?|credentials([.]toml([.]enc)?)?)$"))',
    '  (regex (string-append "^" (regex-quote (param "CARGO_TOOL_HOME")) #"/(config([.]toml)?|credentials([.]toml([.]enc)?)?)$"))',
    '  (subpath (param "USER_SSH")) (subpath (param "USER_GNUPG"))',
    '  (subpath (param "USER_AWS")) (subpath (param "USER_CODEX"))',
    '  (subpath (param "USER_PI")) (subpath (param "USER_CHATSPLICE")))',
    network ? '(allow network*)' : LOCAL_NETWORK_SANDBOX_PROFILE,
  ].join('\n');
}

export function shellRuntimeParameters(): string[] {
  const roots = {
    USER_NVM: '.nvm',
    USER_UV: '.local/share/uv',
    USER_LOCAL_BIN: '.local/bin',
    USER_RUSTUP: '.rustup',
    USER_CARGO_BIN: '.cargo/bin',
    USER_PYENV: '.pyenv',
  };
  return Object.entries(roots).flatMap(([key, path]) => ['-D', `${key}=${join(homedir(), path)}`]);
}
