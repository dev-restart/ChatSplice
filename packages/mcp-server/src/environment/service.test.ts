import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';
import { inspectProjectEnvironment } from './service.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cs-env-'));
  const root = join(directory, 'project');
  const bin = join(directory, 'tools');
  await mkdir(root);
  await mkdir(bin);
  const repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
  const service = new WorkspaceService(repository);
  const workspace = await service.register({ root_path: root });
  const input = (cwd = '.') =>
    ProjectExecInputSchema.parse({
      workspace_id: workspace.workspace_id,
      workspace_binding: `wb_${'a'.repeat(64)}`,
      request_id: 'environment-inspect-1',
      cwd,
      operation: { kind: 'environment' },
    });
  const inspect = (cwd = '.', signal = new AbortController().signal, searchPath = bin) =>
    inspectProjectEnvironment(service, input(cwd), {
      signal,
      searchPath,
      browserProbe: async () => ({ state: 'missing', launch_verified: false }),
    });
  return {
    root,
    bin,
    inspect,
    async close() {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('project environment inspection', () => {
  it('reports absent optional manifests and locks as missing without an invalid-manifest issue', async () => {
    const context = await fixture();
    try {
      const result = await context.inspect();
      expect(result.files).toHaveLength(19);
      expect(result.files.every((file) => file.state === 'missing')).toBe(true);
      expect(result.node).toMatchObject({
        package_manager: null,
        selection: 'not_applicable',
        lockfile_path: null,
      });
      expect(result.issues).not.toContain('manifest_invalid');
      expect(result.issues).not.toContain('runtime_missing');
      expect(result.issues).not.toContain('lockfile_missing');
    } finally {
      await context.close();
    }
  });

  it('keeps a normal Node project free of invalid-manifest issues for other ecosystems', async () => {
    const context = await fixture();
    try {
      await writeFile(join(context.root, 'package.json'), '{"packageManager":"pnpm@10.33.2"}');
      await writeFile(join(context.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      const result = await context.inspect();
      const present = result.files.filter((file) => file.state === 'present');
      expect(present.map((file) => file.path)).toEqual(['package.json', 'pnpm-lock.yaml']);
      expect(result.files.filter((file) => file.state === 'missing')).toHaveLength(17);
      expect(result.node.lockfile_path).toBe('pnpm-lock.yaml');
      expect(result.issues).not.toContain('manifest_invalid');
      expect(result.issues).not.toContain('lockfile_missing');
    } finally {
      await context.close();
    }
  });

  it('keeps directories, existing or dangling symbolic links and hard links invalid', async () => {
    const context = await fixture();
    const manifest = join(context.root, 'package.json');
    try {
      await mkdir(join(context.root, 'Cargo.toml'));
      const directory = await context.inspect();
      expect(directory.files.find((file) => file.path === 'Cargo.toml')?.state).toBe('invalid');
      expect(directory.issues).toContain('manifest_invalid');
      const inside = join(context.root, 'manifest-source.json');
      const outside = join(context.bin, 'manifest-source.json');
      for (const target of [inside, outside]) {
        await writeFile(target, '{"scripts":{"check":"private-linked-command"}}');
      }
      for (const target of [inside, outside, join(context.root, 'absent-manifest.json')]) {
        await symlink(target, manifest);
        const result = await context.inspect();
        expect(result.files.find((file) => file.path === 'package.json')?.state).toBe('invalid');
        expect(result.node.scripts).toEqual([]);
        expect(result.issues).toContain('manifest_invalid');
        expect(JSON.stringify(result)).not.toContain('private-linked-command');
        await rm(manifest);
      }
      await link(inside, manifest);
      const hardLinked = await context.inspect();
      expect(hardLinked.files.find((file) => file.path === 'package.json')?.state).toBe('invalid');
      expect(hardLinked.node.scripts).toEqual([]);
      expect(hardLinked.issues).toContain('manifest_invalid');
    } finally {
      await context.close();
    }
  });

  it('reports declared manager, script names and missing lock/runtime without returning manifest values', async () => {
    const context = await fixture();
    try {
      await writeFile(
        join(context.root, 'package.json'),
        JSON.stringify({
          packageManager: 'pnpm@10.33.2',
          scripts: { check: 'private-command-with-token' },
          privateValue: 'private-value',
        }),
      );
      const result = await context.inspect();
      expect(result.node).toMatchObject({
        package_manager: 'pnpm',
        selection: 'declared',
        scripts: ['check'],
        lockfile_path: null,
      });
      expect(result.issues).toEqual(
        expect.arrayContaining([
          'lockfile_missing',
          'package_manager_missing',
          'runtime_missing',
          'browser_missing',
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain(context.root);
    } finally {
      await context.close();
    }
  });

  it('finds the nearest ancestor lockfile in a monorepo while retaining local script scope', async () => {
    const context = await fixture();
    try {
      await mkdir(join(context.root, 'apps/web'), { recursive: true });
      await writeFile(
        join(context.root, 'apps/web/package.json'),
        '{"scripts":{"build":"command"}}',
      );
      await writeFile(join(context.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      const result = await context.inspect('apps/web');
      expect(result.node).toMatchObject({
        package_manager: 'pnpm',
        selection: 'lockfile',
        lockfile_path: 'pnpm-lock.yaml',
        scripts: ['build'],
      });
      expect(result.issues).not.toContain('lockfile_missing');
    } finally {
      await context.close();
    }
  });

  it('does not substitute a different manager lockfile for a declared manager', async () => {
    const context = await fixture();
    try {
      await writeFile(join(context.root, 'package.json'), '{"packageManager":"npm@11"}');
      await writeFile(join(context.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      expect((await context.inspect()).node).toMatchObject({
        package_manager: 'npm',
        selection: 'declared',
        lockfile_path: null,
      });
    } finally {
      await context.close();
    }
  });

  it('distinguishes malformed and oversized manifests without running scripts', async () => {
    const context = await fixture();
    try {
      for (const [content, state] of [
        ['{bad', 'invalid'],
        ['x'.repeat(65537), 'too_large'],
      ]) {
        await writeFile(join(context.root, 'package.json'), content!);
        const result = await context.inspect();
        expect(result.files[0]!.state).toBe(state);
        expect(result.issues).toContain('manifest_invalid');
      }
    } finally {
      await context.close();
    }
  });

  it('bounds scripts and PATH discovery and reports executable presence without launching versions', async () => {
    const context = await fixture();
    try {
      await writeFile(join(context.bin, 'node'), 'not an executable program');
      await chmod(join(context.bin, 'node'), 0o755);
      await writeFile(join(context.bin, 'uv'), 'unreadable tool');
      await chmod(join(context.bin, 'uv'), 0o644);
      await writeFile(
        join(context.root, 'package.json'),
        JSON.stringify({
          scripts: Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [`script${i}`, 'never run']),
          ),
        }),
      );
      const result = await context.inspect(
        '.',
        undefined,
        [context.bin, ...Array.from({ length: 70 }, (_, i) => `/missing-tools-${i}`)].join(':'),
      );
      expect(result.tools.find((tool) => tool.name === 'node')?.state).toBe('found');
      expect(result.tools.find((tool) => tool.name === 'uv')?.state).toBe('unreadable');
      expect(result.node.scripts).toHaveLength(32);
      expect(result.node.scripts_truncated).toBe(true);
      expect(result.path_scan_truncated).toBe(true);
      expect(result.browser.launch_verified).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('stops before inspecting when cancelled and rejects a non-directory cwd', async () => {
    const context = await fixture();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(context.inspect('.', controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await writeFile(join(context.root, 'file.txt'), 'file');
      await expect(context.inspect('file.txt')).rejects.toThrow('must be a directory');
    } finally {
      await context.close();
    }
  });

  it('reports Go and Elixir runtimes without executing project manifests or demanding unnecessary locks', async () => {
    const context = await fixture();
    try {
      await writeFile(join(context.root, 'go.mod'), 'module example.test/project\n');
      await writeFile(join(context.root, 'mix.exs'), 'raise "must not execute during inspection"');
      const missing = await context.inspect();
      expect(missing.issues).toContain('runtime_missing');
      expect(missing.issues).not.toContain('lockfile_missing');
      for (const name of ['go', 'elixir', 'erl', 'mix', 'sh', 'bash']) {
        await writeFile(join(context.bin, name), 'not executable content');
        await chmod(join(context.bin, name), 0o755);
      }
      const present = await context.inspect();
      expect(present.issues).not.toContain('runtime_missing');
      expect(present.issues).not.toContain('lockfile_missing');
      expect(present.files).toHaveLength(19);
      expect(present.tools).toHaveLength(17);
      expect(present.tools.find((tool) => tool.name === 'elixir')?.state).toBe('found');
      expect(present.tools.find((tool) => tool.name === 'go')?.state).toBe('found');
      expect(JSON.stringify(present)).not.toContain('must not execute');
    } finally {
      await context.close();
    }
  });
});
