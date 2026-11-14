import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsListInputSchema, FsSearchInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { listWorkspacePaths, searchWorkspaceText } from './discover-workspace.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

describe('workspace discovery', () => {
  let temporaryDirectory: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-discovery-'));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(join(workspaceRoot, 'src', 'nested'), { recursive: true });
    await mkdir(join(workspaceRoot, 'node_modules', 'package'), { recursive: true });
    await writeFile(join(workspaceRoot, 'README.md'), '# Discovery fixture\n', 'utf8');
    await writeFile(
      join(workspaceRoot, 'src', 'view.ts'),
      "export const widget = 'Needle';\n",
      'utf8',
    );
    await writeFile(
      join(workspaceRoot, 'src', 'nested', 'helper.ts'),
      "export const helper = 'needle';\n",
      'utf8',
    );
    await writeFile(join(workspaceRoot, 'node_modules', 'package', 'noisy.ts'), 'Needle\n', 'utf8');
    await writeFile(join(workspaceRoot, '.env'), 'TOKEN=Needle\n', 'utf8');
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('lists one directory without exposing secret paths', async () => {
    const result = await listWorkspacePaths(
      service,
      FsListInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
      }),
    );

    expect(result.entries).toEqual([
      { path: 'node_modules', type: 'directory' },
      { path: 'README.md', type: 'file' },
      { path: 'src', type: 'directory' },
    ]);
    expect(result.entries.some((entry) => entry.path === '.env')).toBe(false);
    expect(result.has_more).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('supports bounded recursive glob discovery and ordinary pagination', async () => {
    const first = await listWorkspacePaths(
      service,
      FsListInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        recursive: true,
        glob: '**/*.ts',
        limit: 1,
      }),
    );
    const second = await listWorkspacePaths(
      service,
      FsListInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        recursive: true,
        glob: '**/*.ts',
        limit: 1,
        offset: first.next_offset ?? 0,
      }),
    );

    expect(first.entries).toHaveLength(1);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(1);
    expect(second.entries).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect([...first.entries, ...second.entries].map((entry) => entry.path).sort()).toEqual([
      'src/nested/helper.ts',
      'src/view.ts',
    ]);
  });

  it('returns literal matches with source positions and respects case sensitivity', async () => {
    const exact = await searchWorkspaceText(
      service,
      FsSearchInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'src',
        glob: '**/*.ts',
        query: 'Needle',
      }),
    );
    const insensitive = await searchWorkspaceText(
      service,
      FsSearchInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: 'src',
        glob: '**/*.ts',
        query: 'NEEDLE',
        case_sensitive: false,
      }),
    );

    expect(exact.matches).toEqual([
      expect.objectContaining({ path: 'src/view.ts', line_number: 1, column: 24 }),
    ]);
    expect(insensitive.matches.map((match) => match.path).sort()).toEqual([
      'src/nested/helper.ts',
      'src/view.ts',
    ]);
    expect(insensitive.skipped_files).toBe(0);
  });

  it('does not follow directory symlinks and rejects an escaped start path', async () => {
    const outsideDirectory = join(temporaryDirectory, 'outside');
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'outside.ts'), 'Needle\n', 'utf8');
    await symlink(outsideDirectory, join(workspaceRoot, 'escape'));
    await symlink(join(workspaceRoot, 'src'), join(workspaceRoot, 'src-link'));

    const listed = await listWorkspacePaths(
      service,
      FsListInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        recursive: true,
        glob: '**/*.ts',
      }),
    );
    expect(listed.entries.some((entry) => entry.path.includes('outside.ts'))).toBe(false);
    await expect(
      listWorkspacePaths(
        service,
        FsListInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'escape',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(
      listWorkspacePaths(
        service,
        FsListInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          path: 'src-link',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });
  it('never searches content through a hard-link alias of a secret file', async () => {
    await link(join(workspaceRoot, '.env'), join(workspaceRoot, 'public.txt'));
    const result = await searchWorkspaceText(
      service,
      FsSearchInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        path: '.',
        query: 'TOKEN=Needle',
      }),
    );
    expect(result.matches).toEqual([]);
  });
});
