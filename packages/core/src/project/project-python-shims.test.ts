import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { developmentCommandPath } from './development-tools.js';
import { prepareProjectPythonShims } from './project-python-shims.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(prefix = 'cs-project-python-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const runtime = join(root, 'runtime');
  const cargoHome = join(root, 'cargo-home');
  const selectedBin = join(root, 'selected-multi-tool-bin');
  await Promise.all(
    [workspace, runtime, cargoHome, selectedBin].map((path) => mkdir(path, { recursive: true })),
  );
  return { root, workspace, runtime, cargoHome, selectedBin };
}

async function executable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
}

function run(command: string, path: string, cwd: string, args: string[] = []): string {
  const result = spawnSync(command, args, {
    cwd,
    env: { PATH: path },
    encoding: 'utf8',
    timeout: 3_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// Each case spawns several freshly written executables synchronously; under a
// parallel full-suite run macOS first-exec checks exceed the 5s default.
describe('project Python command shims', { timeout: 20_000 }, () => {
  it('runs project Python ahead of a selected multi-tool bin without changing selected Node or Rust', async () => {
    const { root, workspace, runtime, cargoHome, selectedBin } = await fixture();
    const venvBin = join(workspace, '.venv', 'bin');
    for (const name of ['python', 'python3', 'pip', 'pip3']) {
      await executable(join(venvBin, name), `printf '%s' 'project-${name}'`);
      await executable(join(selectedBin, name), `printf '%s' 'wrong-host-${name}'`);
    }
    for (const name of ['node', 'rustc']) {
      await executable(join(selectedBin, name), `printf '%s' 'selected-${name}'`);
      await executable(join(venvBin, name), `printf '%s' 'wrong-venv-${name}'`);
    }
    const shimDirectory = await prepareProjectPythonShims(runtime, workspace);
    expect(shimDirectory).toBeDefined();
    if (shimDirectory === undefined) throw new Error('Expected project Python shims.');
    const path = [
      shimDirectory,
      developmentCommandPath(selectedBin, workspace, cargoHome, '/usr/bin:/bin'),
    ].join(delimiter);

    for (const name of ['python', 'python3', 'pip', 'pip3'])
      expect(run(name, path, root)).toBe(`project-${name}`);
    for (const name of ['node', 'rustc']) expect(run(name, path, root)).toBe(`selected-${name}`);
    expect((await readdir(shimDirectory)).sort()).toEqual(['pip', 'pip3', 'python', 'python3']);
    expect((await stat(shimDirectory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(shimDirectory))
      expect((await stat(join(shimDirectory, name))).mode & 0o777).toBe(0o700);
  });

  it('keeps the venv invocation path and literal arguments through spaces, apostrophes and shell syntax', async () => {
    const { root, workspace, runtime } = await fixture("cs-python path's $(false) ");
    const interpreter = join(root, 'installed interpreter');
    await executable(interpreter, 'printf "%s\\n" "$0" "$1"');
    const python = join(workspace, '.venv', 'bin', 'python3');
    await mkdir(dirname(python), { recursive: true });
    await symlink(interpreter, python);
    const shimDirectory = await prepareProjectPythonShims(runtime, workspace);
    if (shimDirectory === undefined) throw new Error('Expected the symlinked Python shim.');
    const argument = "value with spaces, an apostrophe ' and $(false)";
    expect(run('python3', `${shimDirectory}${delimiter}/usr/bin:/bin`, root, [argument])).toBe(
      `${python}\n${argument}\n`,
    );
  });

  it('leaves Node-only projects usable when a venv is absent or its path is not a directory', async () => {
    const { workspace, runtime } = await fixture();
    await expect(prepareProjectPythonShims(runtime, workspace)).resolves.toBeUndefined();
    expect(await readdir(runtime)).toEqual([]);
    await writeFile(join(workspace, '.venv'), 'not a virtual environment');
    await expect(prepareProjectPythonShims(runtime, workspace)).resolves.toBeUndefined();
    expect(await readdir(runtime)).toEqual([]);
  });

  it('skips broken, non-executable and non-file entries without hiding other valid Python commands', async () => {
    const { workspace, runtime, root } = await fixture();
    const bin = join(workspace, '.venv', 'bin');
    await mkdir(join(bin, 'python'), { recursive: true });
    await symlink(join(root, 'missing-python'), join(bin, 'python3'));
    await writeFile(join(bin, 'pip'), '#!/bin/sh\nexit 1\n', { mode: 0o600 });
    await executable(join(bin, 'pip3'), "printf '%s' 'project-pip3'");
    const shimDirectory = await prepareProjectPythonShims(runtime, workspace);
    if (shimDirectory === undefined) throw new Error('Expected the valid pip3 shim.');
    expect(await readdir(shimDirectory)).toEqual(['pip3']);
    expect(run('pip3', `${shimDirectory}${delimiter}/usr/bin:/bin`, root)).toBe('project-pip3');
  });
});
