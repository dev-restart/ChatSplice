import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_MANIFEST_BYTES, validateCargoConfiguration } from './pi-trusted.js';

describe('project Cargo configuration validation', () => {
  let temporaryDirectory: string;
  let root: string;
  let cwd: string;
  let cargoDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'cs-cargo-config-')));
    root = join(temporaryDirectory, 'workspace');
    cwd = join(root, 'native');
    cargoDirectory = join(root, '.cargo');
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('accepts ordinary project target, linker, wrapper and Rust flag settings', async () => {
    await mkdir(cargoDirectory);
    await writeFile(
      join(cargoDirectory, 'config.toml'),
      `
[build]
target-dir = "target-native"
rustc-wrapper = "./scripts/rustc-wrapper"
rustflags = ["--cfg", "project_native"]
[target.aarch64-apple-darwin]
linker = "cc"
runner = "./scripts/run-test"
[net]
offline = true
`,
    );
    await expect(validateCargoConfiguration(cwd, root)).resolves.toBeUndefined();
  });

  it('accepts bounded legacy and nested project configuration files', async () => {
    await mkdir(cargoDirectory);
    await writeFile(join(cargoDirectory, 'config'), '[build]\njobs = 2\n');
    await mkdir(join(cwd, '.cargo'));
    await writeFile(join(cwd, '.cargo', 'config.toml'), '[env]\nPROJECT_MODE = "native"\n');
    await expect(validateCargoConfiguration(cwd, root)).resolves.toBeUndefined();
  });

  it('does not inspect configuration or credentials above the bound project root', async () => {
    await mkdir(join(temporaryDirectory, '.cargo'));
    await writeFile(join(temporaryDirectory, '.cargo', 'config.toml'), Buffer.from([0xff]));
    await writeFile(join(temporaryDirectory, '.cargo', 'credentials'), 'outside-project');
    await expect(validateCargoConfiguration(cwd, root)).resolves.toBeUndefined();
  });

  it.each(['credentials', 'credentials.toml', 'credentials.toml.enc'])(
    'rejects project %s without accepting it as configuration',
    async (name) => {
      await mkdir(cargoDirectory);
      await writeFile(join(cargoDirectory, 'config.toml'), '[build]\njobs = 1\n');
      await writeFile(join(cargoDirectory, name), 'fixture-credential');
      await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Workspace Cargo credentials'),
      });
    },
  );

  it('rejects a symbolic .cargo directory', async () => {
    const externalDirectory = join(temporaryDirectory, 'external-cargo');
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, 'config.toml'), '[build]\njobs = 1\n');
    await symlink(externalDirectory, cargoDirectory);
    await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects a symbolic configuration file', async () => {
    await mkdir(cargoDirectory);
    const externalFile = join(temporaryDirectory, 'external-config.toml');
    await writeFile(externalFile, '[build]\njobs = 1\n');
    await symlink(externalFile, join(cargoDirectory, 'config.toml'));
    await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('regular, single-link file'),
    });
  });

  it('rejects a directory in place of a configuration file', async () => {
    await mkdir(join(cargoDirectory, 'config.toml'), { recursive: true });
    await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('regular, single-link file'),
    });
  });

  it.each(['config', 'config.toml'])('rejects invalid UTF-8 in %s', async (name) => {
    await mkdir(cargoDirectory);
    await writeFile(join(cargoDirectory, name), Buffer.from([0x5b, 0xff, 0x5d]));
    await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('valid UTF-8'),
    });
  });

  it('rejects a configuration file above the existing bounded reader limit', async () => {
    await mkdir(cargoDirectory);
    await writeFile(
      join(cargoDirectory, 'config.toml'),
      Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20),
    );
    await expect(validateCargoConfiguration(cwd, root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('bounded file-size limit'),
    });
  });
});
