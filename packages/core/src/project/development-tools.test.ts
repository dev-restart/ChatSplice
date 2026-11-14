import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { developmentCommandPath, developmentToolEnvironment } from './development-tools.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cs-dev-tools-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const cargoHome = join(root, 'project-cache');
  const firstJob = join(root, 'job-one');
  const secondJob = join(root, 'job-two');
  await Promise.all(
    [workspace, cargoHome, firstJob, secondJob].map((path) => mkdir(path, { recursive: true })),
  );
  return { root, workspace, cargoHome, firstJob, secondJob };
}

async function executable(path: string, marker: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${marker}'\n`);
  await chmod(path, 0o700);
}

function requiredPath(environment: NodeJS.ProcessEnv, name: string): string {
  const path = environment[name];
  if (path === undefined) throw new Error(`Missing development environment path: ${name}`);
  return path;
}

function runTool(
  command: string,
  path: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync(command, [], {
    cwd,
    env: { ...environment, PATH: path },
    encoding: 'utf8',
    timeout: 3_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('shared development tool environment', () => {
  it('reuses installed tools and dependency caches after the previous job runtime is deleted', async () => {
    const { root, workspace, cargoHome, firstJob, secondJob } = await fixture();
    const first = developmentToolEnvironment(firstJob, workspace, cargoHome);
    const second = developmentToolEnvironment(secondJob, workspace, cargoHome);
    const command = 'cs-retained-tool-fixture';
    await executable(join(requiredPath(first, 'GOBIN'), command), 'installed-in-first-job');
    for (const key of ['UV_CACHE_DIR', 'npm_config_cache', 'GOMODCACHE', 'MIX_HOME', 'HEX_HOME']) {
      const cache = requiredPath(first, key);
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'retained-fixture.txt'), `cached-${key}`);
    }
    await writeFile(join(firstJob, 'private-job-marker'), 'ephemeral');
    await rm(firstJob, { recursive: true });

    const path = developmentCommandPath(undefined, workspace, cargoHome, '/usr/bin:/bin');
    expect(runTool(command, path, root, second)).toBe('installed-in-first-job');
    for (const key of ['UV_CACHE_DIR', 'npm_config_cache', 'GOMODCACHE', 'MIX_HOME', 'HEX_HOME']) {
      expect(await readFile(join(requiredPath(second, key), 'retained-fixture.txt'), 'utf8')).toBe(
        `cached-${key}`,
      );
    }
    expect(requiredPath(second, 'XDG_CONFIG_HOME')).not.toBe(
      requiredPath(first, 'XDG_CONFIG_HOME'),
    );
    expect(requiredPath(second, 'XDG_DATA_HOME')).not.toBe(requiredPath(first, 'XDG_DATA_HOME'));
    await expect(readFile(join(firstJob, 'private-job-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps installed Cargo and Go tools plus other language caches after a dependency-cache repair', async () => {
    const { root, workspace, cargoHome: toolHome, firstJob, secondJob } = await fixture();
    const repairedHome = join(root, 'repaired-dependencies');
    await mkdir(repairedHome);
    await executable(join(toolHome, 'bin', 'cs-cargo-tool'), 'retained-cargo-tool');
    await executable(join(toolHome, 'development-tools', 'bin', 'cs-go-tool'), 'retained-go-tool');
    const before = developmentToolEnvironment(firstJob, workspace, toolHome);
    const after = developmentToolEnvironment(secondJob, workspace, repairedHome, toolHome);
    const path = developmentCommandPath(
      undefined,
      workspace,
      repairedHome,
      '/usr/bin:/bin',
      toolHome,
    );
    expect(runTool('cs-cargo-tool', path, root, after)).toBe('retained-cargo-tool');
    expect(runTool('cs-go-tool', path, root, after)).toBe('retained-go-tool');
    expect(after.CARGO_HOME).toBe(repairedHome);
    expect(after.CARGO_INSTALL_ROOT).toBe(toolHome);
    for (const key of [
      'UV_CACHE_DIR',
      'PIP_CACHE_DIR',
      'npm_config_cache',
      'GOMODCACHE',
      'MIX_HOME',
      'HEX_HOME',
    ]) {
      expect(after[key]).toBe(before[key]);
    }
  });

  it.each(['node', 'rustc'])(
    'executes the selected %s before an inherited installation',
    async (command) => {
      const { root, workspace, cargoHome } = await fixture();
      const selected = join(root, 'selected-toolchain', 'bin');
      const inherited = join(root, 'other-toolchain', 'bin');
      await executable(join(selected, command), 'selected-toolchain');
      await executable(join(inherited, command), 'wrong-inherited-toolchain');
      await executable(join(workspace, '.venv', 'bin', command), 'wrong-project-shadow');

      const path = developmentCommandPath(
        [selected, '/usr/bin', '/bin'].join(delimiter),
        workspace,
        cargoHome,
        [inherited, '/usr/bin', '/bin'].join(delimiter),
      );
      expect(runTool(command, path, root)).toBe('selected-toolchain');
    },
  );

  it('uses the project virtual environment for an unpinned developer shell command', async () => {
    const { root, workspace, cargoHome } = await fixture();
    const inherited = join(root, 'host-python', 'bin');
    await executable(join(workspace, '.venv', 'bin', 'python3'), 'project-python');
    await executable(join(inherited, 'python3'), 'wrong-host-python');
    const path = developmentCommandPath(undefined, workspace, cargoHome, inherited);
    expect(runTool('python3', path, root)).toBe('project-python');
  });

  it('does not execute relative or control-character PATH entries ahead of a valid directory', async () => {
    const { root, workspace, cargoHome } = await fixture();
    const command = 'cs-path-filter-fixture';
    const relative = 'relative-tools';
    const control = join(root, 'invalid\npath');
    const trusted = join(root, 'trusted-tools');
    await executable(join(root, relative, command), 'wrong-relative-tool');
    await executable(join(control, command), 'wrong-control-path-tool');
    await executable(join(trusted, command), 'valid-tool');

    const path = developmentCommandPath(
      `.${delimiter}${relative}${delimiter}${control}`,
      workspace,
      cargoHome,
      ['', relative, control, trusted, trusted].join(delimiter),
    );
    expect(runTool(command, path, root)).toBe('valid-tool');
    expect(path.split(delimiter).filter((entry) => entry === trusted)).toHaveLength(1);
  });

  it('keeps inherited credentials and runtime injection settings out of child environments', async () => {
    const { workspace, cargoHome, firstJob } = await fixture();
    const forbidden = ['AWS_ACCESS_KEY_ID', 'NPM_TOKEN', 'OPENAI_API_KEY', 'PYTHONPATH'];
    for (const name of forbidden) vi.stubEnv(name, 'host-secret-fixture');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/host/credential-bearing.gitconfig');
    const environment = developmentToolEnvironment(firstJob, workspace, cargoHome);
    for (const name of forbidden) expect(environment[name]).toBeUndefined();
    expect(environment.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(environment.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(environment.GIT_TERMINAL_PROMPT).toBe('0');

    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        'printf "%s\\n" "${AWS_ACCESS_KEY_ID-unset}" "${NPM_TOKEN-unset}" "${OPENAI_API_KEY-unset}" "${PYTHONPATH-unset}"',
      ],
      { env: environment, encoding: 'utf8', timeout: 3_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('unset\nunset\nunset\nunset\n');
  });
});
