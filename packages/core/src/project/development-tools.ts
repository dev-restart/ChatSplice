import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Keep selected Node/Rust first while making installed child-language tools discoverable. */
export function developmentCommandPath(
  selectedPath: string | undefined,
  workspaceRoot: string,
  cargoHome: string,
  inheritedPath: string | undefined = process.env.PATH,
  cargoToolHome: string = cargoHome,
): string {
  const directories = [
    ...(selectedPath ?? '')
      .split(delimiter)
      .filter((path) => !['/usr/bin', '/bin', '/usr/sbin', '/sbin'].includes(path)),
    join(workspaceRoot, '.venv', 'bin'),
    join(workspaceRoot, '.local', 'bin'),
    join(cargoHome, 'bin'),
    join(cargoToolHome, 'bin'),
    join(cargoToolHome, 'development-tools', 'bin'),
    ...(inheritedPath ?? '').split(delimiter),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(directories.filter((path) => isAbsolute(path) && !/\p{Cc}/u.test(path)))].join(
    delimiter,
  );
}

/** All mutable language state is project-local or under the validated private project cache. */
export function developmentToolEnvironment(
  runtimeDirectory: string,
  workspaceRoot: string,
  cargoHome: string,
  cargoToolHome: string = cargoHome,
): NodeJS.ProcessEnv {
  const cache = join(cargoToolHome, 'development-tools');
  return {
    CARGO_HOME: cargoHome,
    CARGO_INSTALL_ROOT: cargoToolHome,
    RUSTUP_HOME: join(homedir(), '.rustup'),
    RUSTUP_AUTO_INSTALL: '0',
    // HOME stays job-private; installed shim managers need their explicit data roots.
    PYENV_ROOT: join(homedir(), '.pyenv'),
    ASDF_DATA_DIR: join(homedir(), '.asdf'),
    MISE_DATA_DIR: join(homedir(), '.local', 'share', 'mise'),
    MISE_CACHE_DIR: join(cache, 'mise'),
    MISE_CONFIG_DIR: join(runtimeDirectory, 'mise-config'),
    VOLTA_HOME: join(homedir(), '.volta'),
    XDG_CACHE_HOME: join(cache, 'xdg-cache'),
    XDG_CONFIG_HOME: join(runtimeDirectory, 'xdg-config'),
    XDG_DATA_HOME: join(runtimeDirectory, 'xdg-data'),
    UV_CACHE_DIR: join(cache, 'uv'),
    UV_PYTHON_INSTALL_DIR: join(workspaceRoot, '.python'),
    UV_LINK_MODE: 'copy',
    PIP_CACHE_DIR: join(cache, 'pip'),
    PYTHONNOUSERSITE: '1',
    npm_config_cache: join(cache, 'npm'),
    npm_config_prefix: join(workspaceRoot, '.local'),
    npm_config_store_dir: join(cache, 'pnpm-store'),
    npm_config_package_import_method: 'copy',
    GOPATH: join(cache, 'go'),
    GOMODCACHE: join(cache, 'go', 'pkg', 'mod'),
    GOCACHE: join(cache, 'go-build'),
    GOBIN: join(cache, 'bin'),
    GOENV: 'off',
    MIX_HOME: join(cache, 'mix'),
    HEX_HOME: join(cache, 'hex'),
    MIX_INSTALL_DIR: join(cache, 'mix-installs'),
    REBAR_CACHE_DIR: join(cache, 'rebar'),
    CLANG_MODULE_CACHE_PATH: join(cache, 'clang-modules'),
    SWIFT_MODULECACHE_PATH: join(cache, 'swift-modules'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
