import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { ProjectRunInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { runWorkspaceProjectTask } from './run-task.js';
import { resolveTrustedExecutable } from './pi-trusted.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;
const BUN_AVAILABLE = (process.env.PATH ?? '')
  .split(delimiter)
  .some((path) => existsSync(join(path, 'bun')));

describe('runWorkspaceProjectTask', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-project-run-'));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10.0.0',
        scripts: {
          check: 'node -e "console.log(process.env.CHATSPLICE_TEST_SECRET || \'clean\')"',
          test: "node -e \"require('node:fs').readFileSync('.env', 'utf8')\"",
          lint: 'node -e "setInterval(() => {}, 1000)"',
          typecheck: 'node -e "process.stdout.write(\'x\'.repeat(120000))"',
        },
      }),
      'utf8',
    );
    await writeFile(join(workspaceRoot, '.env'), 'DO_NOT_EXPOSE=this-value\n', 'utf8');
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('allows dependency files linked entirely inside the workspace', async () => {
    if (process.platform !== 'darwin') return;
    await mkdir(join(workspaceRoot, 'node_modules/esbuild/bin'), { recursive: true });
    await mkdir(join(workspaceRoot, 'node_modules/@esbuild/darwin-arm64/bin'), { recursive: true });
    const binary = join(workspaceRoot, 'node_modules/esbuild/bin/esbuild');
    await writeFile(binary, 'fixture binary');
    await link(binary, join(workspaceRoot, 'node_modules/@esbuild/darwin-arm64/bin/esbuild'));
    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'check',
        timeout_ms: 10_000,
      }),
    );
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('runs only an existing allowlisted script with a sanitized environment on macOS', async () => {
    if (process.platform !== 'darwin') return;
    process.env.CHATSPLICE_TEST_SECRET = 'must-not-leak';
    try {
      const result = await runWorkspaceProjectTask(
        service,
        ProjectRunInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          task: 'check',
          timeout_ms: 10_000,
        }),
      );
      expect(result).toMatchObject({ task: 'check', exit_code: 0, timed_out: false });
      expect(result.stdout).toContain('clean');
      expect(result.stdout).not.toContain('must-not-leak');
    } finally {
      delete process.env.CHATSPLICE_TEST_SECRET;
    }
  });

  it('rejects commands that are not declared as an allowlisted root script', async () => {
    if (process.platform !== 'darwin') return;
    await expect(
      runWorkspaceProjectTask(
        service,
        ProjectRunInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          task: 'build',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('runs cached pnpm root checks and nested pnpm scripts without writing to the shared Corepack cache', async () => {
    if (process.platform !== 'darwin') return;
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'pnpm@10.33.2',
        scripts: {
          check: 'pnpm run fixture',
          fixture: 'node -e "console.log(\'nested-pnpm-check-passed\')"',
        },
      }),
      'utf8',
    );

    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'check',
        timeout_ms: 10_000,
      }),
    );

    expect(result).toMatchObject({ command: 'pnpm run check', exit_code: 0, timed_out: false });
    expect(result.stdout).toContain('nested-pnpm-check-passed');
    expect(result.stderr).not.toContain('EPERM');
  });

  it.skipIf(process.platform !== 'darwin' || !BUN_AVAILABLE)(
    'runs Bun root checks without an external Node executable on PATH',
    async () => {
      const bunPath = (process.env.PATH ?? '')
        .split(delimiter)
        .map((path) => join(path, 'bun'))
        .find(existsSync);
      if (bunPath === undefined) throw new Error('Bun disappeared from PATH.');
      const bun = await resolveTrustedExecutable(bunPath, workspaceRoot);
      await writeFile(join(temporaryDirectory, 'outside-secret.txt'), 'BUN_OUTSIDE_SECRET');
      await writeFile(
        join(workspaceRoot, 'check.ts'),
        `import { readFileSync } from 'node:fs';
let blocked = 0;
for (const path of ['.env', '../outside-secret.txt']) {
  try { readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') blocked += 1;
  }
}
if (blocked !== 2) process.exit(9);
console.log('bun-only-check-passed');\n`,
      );
      await writeFile(
        join(workspaceRoot, 'package.json'),
        JSON.stringify({
          private: true,
          packageManager: 'bun@1.2.15',
          scripts: { check: 'bun check.ts' },
        }),
      );
      const originalPath = process.env.PATH;
      process.env.PATH = [dirname(bun.path), '/usr/bin', '/bin'].join(delimiter);
      try {
        const result = await runWorkspaceProjectTask(
          service,
          ProjectRunInputSchema.parse({
            workspace_id: workspaceId,
            workspace_binding: WORKSPACE_BINDING,
            task: 'check',
            timeout_ms: 10_000,
          }),
        );
        expect(result, result.stdout + result.stderr).toMatchObject({
          command: 'bun run check',
          exit_code: 0,
          timed_out: false,
        });
        expect(result.stdout).toContain('bun-only-check-passed');
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  it.each(['symbolic', 'hard'] as const)(
    'rejects a %s-linked package manifest before running a check',
    async (kind) => {
      if (process.platform !== 'darwin') return;
      const manifestPath = join(workspaceRoot, 'package.json');
      const externalPath = join(temporaryDirectory, 'external-package.json');
      await rename(manifestPath, externalPath);
      if (kind === 'symbolic') await symlink(externalPath, manifestPath);
      else await link(externalPath, manifestPath);

      await expect(
        runWorkspaceProjectTask(
          service,
          ProjectRunInputSchema.parse({
            workspace_id: workspaceId,
            workspace_binding: WORKSPACE_BINDING,
            task: 'check',
            timeout_ms: 10_000,
          }),
        ),
      ).rejects.toMatchObject({ code: 'PATH_NOT_FILE' });
    },
  );

  it('denies package scripts access to common workspace secret files', async () => {
    if (process.platform !== 'darwin') return;
    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'test',
        timeout_ms: 10_000,
      }),
    );
    expect(result.exit_code).not.toBe(0);
    expect(result.stdout).not.toContain('DO_NOT_EXPOSE');
    expect(result.stderr).not.toContain('this-value');
  });

  it('denies workspace env variants and private-key files at nested paths', async () => {
    if (process.platform !== 'darwin') return;
    const envSecret = 'ENV_LOCAL_SECRET_MUST_NOT_LEAK';
    const privateKeySecret = 'PRIVATE_KEY_SECRET_MUST_NOT_LEAK';
    await mkdir(join(workspaceRoot, 'keys'));
    await writeFile(join(workspaceRoot, '.env.local'), envSecret, 'utf8');
    await writeFile(join(workspaceRoot, 'keys', 'deploy.pem'), privateKeySecret, 'utf8');
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10.0.0',
        scripts: {
          build:
            "node -e \"const fs=require('node:fs');const paths=['.env.local','keys/deploy.pem'];let denied=0;for(const path of paths){try{process.stdout.write(fs.readFileSync(path,'utf8'));}catch(error){if(error.code==='EPERM'||error.code==='EACCES')denied+=1;}}if(denied!==paths.length)process.exit(1);console.log('blocked:'+denied);\"",
        },
      }),
      'utf8',
    );

    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'build',
        timeout_ms: 10_000,
      }),
    );

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('blocked:2');
    expect(result.stdout).not.toContain(envSecret);
    expect(result.stdout).not.toContain(privateKeySecret);
    expect(result.stderr).not.toContain(envSecret);
    expect(result.stderr).not.toContain(privateKeySecret);
  });

  it('denies package scripts access to files outside the workspace and private runtime', async () => {
    if (process.platform !== 'darwin') return;
    const outsideSecret = 'OUTSIDE_WORKSPACE_SECRET_MUST_NOT_LEAK';
    await writeFile(join(temporaryDirectory, 'outside-secret.txt'), outsideSecret, 'utf8');
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10.0.0',
        scripts: {
          build:
            "node -e \"process.stdout.write(require('node:fs').readFileSync('../outside-secret.txt', 'utf8'))\"",
        },
      }),
      'utf8',
    );

    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'build',
        timeout_ms: 10_000,
      }),
    );

    expect(result.exit_code).not.toBe(0);
    expect(result.stdout).not.toContain(outsideSecret);
    expect(result.stderr).not.toContain(outsideSecret);
  });

  it('terminates a package script at the requested timeout', async () => {
    if (process.platform !== 'darwin') return;
    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'lint',
        timeout_ms: 1_000,
      }),
    );
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
  });

  it('bounds package-script output instead of returning an unlimited tool result', async () => {
    if (process.platform !== 'darwin') return;
    const result = await runWorkspaceProjectTask(
      service,
      ProjectRunInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        task: 'typecheck',
        timeout_ms: 10_000,
      }),
    );
    expect(result.exit_code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(96 * 1024);
  });
});
