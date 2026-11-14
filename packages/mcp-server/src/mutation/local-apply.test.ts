import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectEditActivityStore } from './direct-edit-activity-store.js';
import { applyLocalBundle } from './local-apply.js';

const binding = `wb_${'0'.repeat(64)}`;

describe('local apply execution evidence', () => {
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chatsplice-apply-evidence-'));
    repository = new SqliteWorkspaceRepository(':memory:');
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: root })).workspace_id;
  });
  afterEach(async () => {
    repository.close();
    await rm(root, { recursive: true, force: true });
  });

  it('returns failed check output and the actual partial file changes without rollback claims', async () => {
    if (process.platform !== 'darwin') return;
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10.0.0',
        scripts: {
          check:
            "node -e \"console.log('check-output'); console.error('check-failed'); process.exit(7)\"",
        },
      }),
    );
    const result = await applyLocalBundle(service, new DirectEditActivityStore(), binding, {
      format: 'chatsplice.apply.v1',
      workspace_id: workspaceId,
      operations: [{ tool: 'fs.write', mode: 'create', path: 'notes.txt', content: 'changed\n' }],
      checks: [{ task: 'check', timeout_ms: 10_000 }],
      git: [],
    });
    expect(result.state).toBe('failed');
    expect(result.failed_step).toBe(1);
    expect(result.changed_paths).toEqual(['notes.txt']);
    expect(result.applied_steps[0]?.sha256).toBe(
      createHash('sha256').update('changed\n').digest('hex'),
    );
    expect(result.applied_steps[1]?.execution).toMatchObject({ exit_code: 7, timed_out: false });
    expect(result.applied_steps[1]?.execution?.stdout).toContain('check-output');
    expect(result.applied_steps[1]?.execution?.stderr).toContain('check-failed');
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('changed\n');
  });

  it('returns the actual git diff through the proposal result', async () => {
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    await writeFile(join(root, 'notes.txt'), 'before\n');
    execFileSync('/usr/bin/git', ['add', '--', 'notes.txt'], { cwd: root });
    await writeFile(join(root, 'notes.txt'), 'after\n');
    const result = await applyLocalBundle(service, new DirectEditActivityStore(), binding, {
      format: 'chatsplice.apply.v1',
      workspace_id: workspaceId,
      operations: [],
      checks: [],
      git: [{ command: 'diff', paths: ['notes.txt'], staged: false }],
    });
    expect(result.state).toBe('succeeded');
    expect(result.applied_steps[0]?.execution?.stdout).toContain('-before\n+after');
    expect(result.applied_steps[0]?.execution?.exit_code).toBe(0);
  });
});
