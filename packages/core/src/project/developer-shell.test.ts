import { existsSync } from 'node:fs';
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { executeProjectOperation } from './pi-execution.js';
import { shellQuote } from './pi-sandbox.js';
import { nodeRuntimeVersionSupported } from './pi-trusted.js';

describe('developer shell sandbox', () => {
  let temporaryDirectory: string;
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'cs-shell-'));
    root = join(temporaryDirectory, 'workspace');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: root })).workspace_id;
  });
  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function run(
    command: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ output: string; exitCode: number | null }> {
    let output = '';
    const result = await executeProjectOperation(
      service,
      ProjectExecInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: `wb_${'a'.repeat(64)}`,
        request_id: 'shell-test-request',
        operation: { kind: 'shell', command, network: 'local', ...extra },
        timeout_ms: 30_000,
      }),
      {
        onOutput: (chunk) => {
          output += chunk;
        },
      },
    );
    return { output, exitCode: result.exit_code };
  }

  const mac = it.skipIf(process.platform !== 'darwin' || !nodeRuntimeVersionSupported());
  mac(
    'permits existing internal aliases, refuses external aliases and denies new hard links',
    async () => {
      await writeFile(join(root, 'note.txt'), 'source');
      const result = await run('ln note.txt new-alias.txt');
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('source');
      await link(join(root, 'note.txt'), join(root, 'existing-alias.txt'));
      expect(await run('cat existing-alias.txt')).toEqual({ exitCode: 0, output: 'source' });
      await link(join(root, 'note.txt'), join(temporaryDirectory, 'external-alias.txt'));
      await expect(run('printf STARTED')).rejects.toThrow('inside the workspace');
    },
  );
  mac('runs a non-Node shell command without an external Node on PATH', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const result = await run('printf SHELL_READY');
      expect(result).toEqual({ exitCode: 0, output: 'SHELL_READY' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  mac('runs dependency hooks when the developer shell permits external network', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'network-install-fixture',
        version: '1.0.0',
        private: true,
        scripts: { postinstall: 'node hook.cjs' },
      }),
    );
    await writeFile(join(root, 'hook.cjs'), "require('node:fs').writeFileSync('hook.txt','ran')");
    const result = await run('npm install --offline --no-audit --no-fund', { network: 'enabled' });
    expect(result.exitCode, result.output).toBe(0);
    expect(await readFile(join(root, 'hook.txt'), 'utf8')).toBe('ran');
  });

  mac('consumes project configuration and executes without a package manifest', async () => {
    await writeFile(join(root, '.env'), 'fixture-config');
    const result = await run(
      `node -e ${shellQuote("console.log(require('node:fs').readFileSync('.env','utf8'));require('node:fs').writeFileSync('built.txt','built')")}`,
    );
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain('fixture-config');
    expect(await readFile(join(root, 'built.txt'), 'utf8')).toBe('built');
  });
  mac('supports finite stdin and preserves non-zero exits', async () => {
    expect(await run('cat; exit 7', { stdin: 'finite-input\n' })).toEqual({
      output: 'finite-input\n',
      exitCode: 7,
    });
  });
  mac('confines writes even when a command targets an absolute outside path', async () => {
    const outside = join(temporaryDirectory, 'outside.txt');
    const result = await run(
      `node -e ${shellQuote(`try{require('node:fs').writeFileSync(${JSON.stringify(outside)},'escape');process.exit(9)}catch(error){console.log(error.code)}`)}`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/EPERM|EACCES/);
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  mac(
    'creates and uses a project-local Python virtual environment',
    async () => {
      const result = await run('python3 -m venv .venv && .venv/bin/python -c "print(21*2)"');
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('42');
    },
    40_000,
  );
  const uvInstalled = (process.env.PATH ?? '')
    .split(delimiter)
    .some((directory) => existsSync(join(directory, 'uv')));
  for (const installer of ['pip', 'uv'] as const) {
    it.skipIf(
      process.platform !== 'darwin' ||
        !nodeRuntimeVersionSupported() ||
        (installer === 'uv' && !uvInstalled),
    )(
      `installs a local Python wheel with ${installer} and preserves it across jobs`,
      async () => {
        const wheelName = 'fixture-1.0-py3-none-any.whl';
        const metadata = {
          'fixture.py': 'answer = 42\n',
          'fixture-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: fixture\nVersion: 1.0\n',
          'fixture-1.0.dist-info/WHEEL':
            'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
          'fixture-1.0.dist-info/RECORD': '',
        };
        const setup = await run('python3 -', {
          stdin: `import json, zipfile\nfiles = json.loads(${JSON.stringify(JSON.stringify(metadata))})\nwith zipfile.ZipFile(${JSON.stringify(wheelName)}, 'w') as archive:\n    for name, content in files.items():\n        archive.writestr(name, content)\n`,
        });
        expect(setup.exitCode, setup.output).toBe(0);
        const installCommand =
          installer === 'uv'
            ? `uv venv --python python3 .venv && uv pip install --python .venv/bin/python --no-index ${wheelName}`
            : `python3 -m venv .venv && .venv/bin/python -m pip install --disable-pip-version-check --no-index ${wheelName}`;
        const installed = await run(installCommand);
        expect(installed.exitCode, installed.output).toBe(0);
        expect(await run('.venv/bin/python -c "import fixture; print(fixture.answer)"')).toEqual({
          exitCode: 0,
          output: '42\n',
        });
      },
      40_000,
    );
  }
  mac('uses an installed Rust toolchain without inheriting the user HOME', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "developer_shell_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(join(root, 'src', 'main.rs'), 'fn main() {}\n');
    const result = await run('cargo check --offline');
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Finished');
  });
  mac('keeps writable Corepack state private and follows the shell network policy', async () => {
    const command = `node -e ${shellQuote("const fs=require('node:fs');const path=require('node:path');if(process.env.COREPACK_HOME!==path.join(process.env.HOME,'corepack-cache'))process.exit(2);fs.mkdirSync(process.env.COREPACK_HOME,{recursive:true});fs.writeFileSync(path.join(process.env.COREPACK_HOME,'fixture'),'private');console.log(process.env.COREPACK_ENABLE_NETWORK)")}`;
    expect(await run(command, { network: 'enabled' })).toEqual({
      exitCode: 0,
      output: '1\n',
    });
    expect(
      await run(`node -e ${shellQuote('console.log(process.env.COREPACK_ENABLE_NETWORK)')}`),
    ).toEqual({ exitCode: 0, output: '0\n' });
  });
  mac('reuses a cached pinned pnpm and its hooks in successive private shell caches', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'cached-manager-fixture',
        version: '1.0.0',
        private: true,
        packageManager: 'pnpm@10.33.2',
        scripts: { postinstall: 'node hook.cjs' },
      }),
    );
    await writeFile(
      join(root, 'hook.cjs'),
      "require('node:fs').appendFileSync('hooks.txt','ran\\n')",
    );
    for (let job = 0; job < 2; job += 1) {
      const result = await run(
        'COREPACK_ENABLE_NETWORK=0 corepack pnpm install --offline --ignore-pnpmfile --config.manage-package-manager-versions=false',
        { network: 'enabled' },
      );
      expect(result.exitCode, result.output).toBe(0);
    }
    expect(await readFile(join(root, 'hooks.txt'), 'utf8')).toBe('ran\nran\n');
  });
  mac('runs project dependency lifecycle hooks through the developer command path', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'developer-install-fixture',
        version: '1.0.0',
        private: true,
        scripts: { postinstall: 'node postinstall.cjs' },
      }),
    );
    await writeFile(
      join(root, 'postinstall.cjs'),
      "require('node:fs').writeFileSync('postinstall-result.txt','hook-ran')",
    );
    const result = await run('npm install --offline --no-audit --no-fund');
    expect(result.exitCode, result.output).toBe(0);
    expect(await readFile(join(root, 'postinstall-result.txt'), 'utf8')).toBe('hook-ran');
  });
});
