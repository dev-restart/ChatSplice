import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { SqliteSettingsRepository } from '../settings/sqlite-repository.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { StoredGoalRecordSchema } from './repository.js';
import type { StoredGoalRecord } from './repository.js';
import { SqliteGoalRepository } from './sqlite-repository.js';

const workspaceId = `ws_${'a'.repeat(24)}`;

function record(overrides: Partial<StoredGoalRecord> = {}): StoredGoalRecord {
  return StoredGoalRecordSchema.parse({
    goal_id: `goal_${randomUUID()}`,
    workspace_id: workspaceId,
    objective: 'Implement and verify the project change.',
    scope: '',
    tracked_paths: ['src/main.ts'],
    criteria: [
      {
        kind: 'file',
        criterion_id: 'source',
        description: 'Verify source.',
        required: true,
        path: 'src/main.ts',
        status: 'pending',
        evidence: null,
      },
    ],
    state: 'active',
    revision: 1,
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    deadline_at: '2026-10-11T01:00:00.000Z',
    max_executions: 64,
    executions_used: 0,
    checkpoint: null,
    receipts: [],
    message: '',
    root_identity: 'b'.repeat(64),
    ...overrides,
  });
}

async function withRepository(
  run: (repository: SqliteGoalRepository, path: string) => void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'chatsplice-goals-'));
  const path = join(directory, 'state.sqlite');
  const repository = new SqliteGoalRepository(path);
  try {
    run(repository, path);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('SqliteGoalRepository', () => {
  it('persists bounded Goal/checkpoint/receipt records across reopening while preserving other tables', async () => {
    await withRepository((repository, path) => {
      const workspaces = new SqliteWorkspaceRepository(path);
      const settings = new SqliteSettingsRepository(path);
      workspaces.create({
        workspaceId,
        displayName: 'Project',
        rootPath: '/local/project',
        kind: 'user',
        createdAt: '2026-10-11T00:00:00.000Z',
      });
      settings.setMcpAppName('Test MCP');
      const created = repository.insert(
        record({
          checkpoint: {
            summary: 'Source updated.',
            next_step: 'Run tests.',
            files: [{ path: 'src/main.ts', sha256: 'c'.repeat(64) }],
            saved_at: '2026-10-11T00:00:00.000Z',
          },
          receipts: [
            {
              job_id: `exec_${randomUUID()}`,
              request_hash: 'd'.repeat(64),
              criterion_id: null,
              state: 'interrupted',
              build_id: 'e'.repeat(64),
              run_id: randomUUID(),
              created_at: '2026-10-11T00:00:00.000Z',
              started_at: '2026-10-11T00:00:01.000Z',
              finished_at: '2026-10-11T00:00:02.000Z',
              exit_code: null,
            },
          ],
        }),
      );
      const reopened = new SqliteGoalRepository(path);
      try {
        expect(reopened.find(created.goal_id)).toEqual(created);
        expect(reopened.list(workspaceId)).toEqual([created]);
        expect(reopened.listAll()).toEqual([created]);
        expect(workspaces.findById(workspaceId)?.display_name).toBe('Project');
        expect(settings.getMcpAppName()).toBe('Test MCP');
      } finally {
        reopened.close();
        workspaces.close();
        settings.close();
      }
    });
  });

  it('uses revision compare-and-swap across independent connections and prevents lost updates', async () => {
    await withRepository((repository, path) => {
      const second = new SqliteGoalRepository(path);
      try {
        const original = repository.insert(record());
        const updated = second.replace({ ...original, state: 'paused', revision: 2 }, 1);
        expect(() =>
          repository.replace({ ...original, state: 'cancelled', revision: 2 }, 1),
        ).toThrow('revision changed');
        expect(repository.find(original.goal_id)).toEqual(updated);
        expect(() => repository.replace({ ...updated, revision: 4 }, 2)).toThrow('increment');
        expect(() => repository.insert(record({ revision: 2 }))).toThrow('revision 1');
        expect(() => repository.insert(original)).toThrow('already registered');
      } finally {
        second.close();
      }
    });
  });

  it('keeps workspace/root/creation identity immutable during replacement', async () => {
    await withRepository((repository) => {
      const original = repository.insert(record());
      for (const changes of [
        { workspace_id: `ws_${'c'.repeat(24)}` },
        { root_identity: 'd'.repeat(64) },
        { created_at: '2026-10-11T00:00:01.000Z' },
      ]) {
        expect(() => repository.replace({ ...original, ...changes, revision: 2 }, 1)).toThrow(
          'immutable',
        );
      }
      expect(repository.find(original.goal_id)?.revision).toBe(1);
    });
  });

  it('admits Goals beyond the old per-workspace and global caps while paging stable rows', async () => {
    await withRepository((repository) => {
      for (let goal = 0; goal < 260; goal += 1) repository.insert(record());
      expect(repository.count(workspaceId)).toBe(260);
      expect(repository.count()).toBe(260);
      const first = repository.list(workspaceId, { offset: 0, limit: 32 });
      const second = repository.list(workspaceId, { offset: 32, limit: 32 });
      expect(first).toHaveLength(32);
      expect(second).toHaveLength(32);
      expect(new Set([...first, ...second].map((goal) => goal.goal_id)).size).toBe(64);
      expect(repository.list(workspaceId, { offset: 256, limit: 32 })).toHaveLength(4);
      expect(repository.listAll({ offset: 256, limit: 32 })).toHaveLength(4);
    });
  });

  it('accepts valid multilingual criteria beyond the old 64 KiB ceiling and keeps a database byte guard', async () => {
    await withRepository((repository, path) => {
      const oversized = record({
        criteria: Array.from({ length: 16 }, (_, index) => ({
          kind: 'browser' as const,
          criterion_id: `page_${index}`,
          description: 'Verify page.',
          required: true,
          status: 'pending' as const,
          evidence: null,
          expectation: { kind: 'text' as const, selector: 'main', text: '한'.repeat(4000) },
        })),
      });
      const stored = repository.insert(oversized);
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(65_536);
      expect(repository.find(stored.goal_id)).toEqual(stored);
      const external = new Database(path);
      try {
        expect(() =>
          external
            .prepare('UPDATE goals SET document = ? WHERE goal_id = ?')
            .run(JSON.stringify({ ...stored, padding: 'x'.repeat(1024 * 1024) }), stored.goal_id),
        ).toThrow();
      } finally {
        external.close();
      }
      expect(repository.find(stored.goal_id)).toEqual(stored);
    });
  });

  it('rejects malformed and inconsistent stored documents when reading', async () => {
    await withRepository((repository, path) => {
      const original = repository.insert(record());
      const external = new Database(path);
      try {
        external
          .prepare('UPDATE goals SET document = ? WHERE goal_id = ?')
          .run('{}', original.goal_id);
        expect(() => repository.find(original.goal_id)).toThrow('invalid');
        external
          .prepare('UPDATE goals SET document = ? WHERE goal_id = ?')
          .run(JSON.stringify({ ...original, revision: 2 }), original.goal_id);
        expect(() => repository.list(workspaceId)).toThrow('inconsistent');
        expect(() =>
          external
            .prepare('UPDATE goals SET document = ? WHERE goal_id = ?')
            .run('not json', original.goal_id),
        ).toThrow();
      } finally {
        external.close();
      }
    });
  });

  it('upgrades the legacy 64 KiB table atomically while retaining identities, revisions and unrelated tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-storage-upgrade-'));
    const path = join(directory, 'state.sqlite');
    const legacy = new Database(path);
    const original = record();
    legacy.exec(`
      CREATE TABLE goals (
        goal_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        document TEXT NOT NULL CHECK (json_valid(document) AND length(CAST(document AS BLOB)) <= 65536)
      ) STRICT;
      CREATE INDEX goals_workspace ON goals (workspace_id);
      CREATE TABLE retained_settings (value TEXT NOT NULL) STRICT;
      INSERT INTO retained_settings VALUES ('keep me');
    `);
    legacy
      .prepare('INSERT INTO goals (goal_id, workspace_id, revision, document) VALUES (?, ?, ?, ?)')
      .run(original.goal_id, original.workspace_id, original.revision, JSON.stringify(original));
    legacy.close();
    const repository = new SqliteGoalRepository(path);
    try {
      expect(repository.find(original.goal_id)).toEqual(original);
      const enlarged = repository.replace(
        {
          ...original,
          revision: 2,
          criteria: Array.from({ length: 16 }, (_, index) => ({
            kind: 'browser' as const,
            criterion_id: `page_${index}`,
            description: 'Verify page.',
            required: true,
            status: 'pending' as const,
            evidence: null,
            expectation: { kind: 'text' as const, selector: 'main', text: '한'.repeat(4000) },
          })),
        },
        1,
      );
      const reopened = new SqliteGoalRepository(path);
      const inspected = new Database(path, { readonly: true });
      try {
        expect(reopened.find(original.goal_id)).toEqual(enlarged);
        expect(inspected.prepare('SELECT value FROM retained_settings').get()).toEqual({
          value: 'keep me',
        });
        expect(
          inspected
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'goals_storage_upgrade'")
            .get(),
        ).toBeUndefined();
      } finally {
        inspected.close();
        reopened.close();
      }
    } finally {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains execution hashes after receipt compaction and removes them only with an owned terminal Goal', async () => {
    await withRepository((repository, path) => {
      const requestHash = 'd'.repeat(64);
      let current = repository.insert(
        record({
          receipts: [
            {
              job_id: `exec_${randomUUID()}`,
              request_hash: requestHash,
              criterion_id: null,
              state: 'succeeded',
              build_id: 'e'.repeat(64),
              run_id: randomUUID(),
              created_at: '2026-10-11T00:00:00.000Z',
              started_at: '2026-10-11T00:00:01.000Z',
              finished_at: '2026-10-11T00:00:02.000Z',
              exit_code: 0,
            },
          ],
        }),
      );
      current = repository.replace({ ...current, revision: 2, receipts: [] }, 1);
      const reopened = new SqliteGoalRepository(path);
      try {
        expect(reopened.hasExecutionRequest(current.goal_id, requestHash)).toBe(true);
        expect(() =>
          reopened.deleteTerminal(workspaceId, current.goal_id, current.revision),
        ).toThrow('completed or cancelled');
        expect(() =>
          reopened.deleteTerminal(`ws_${'f'.repeat(24)}`, current.goal_id, current.revision),
        ).toThrow('selected workspace');
        current = repository.replace({ ...current, revision: 3, state: 'completed' }, 2);
        expect(() => reopened.deleteTerminal(workspaceId, current.goal_id, 2)).toThrow(
          'revision changed',
        );
        reopened.deleteTerminal(workspaceId, current.goal_id, 3);
        expect(repository.find(current.goal_id)).toBeUndefined();
        expect(repository.hasExecutionRequest(current.goal_id, requestHash)).toBe(false);
        const inspected = new Database(path, { readonly: true });
        try {
          expect(
            inspected.prepare('SELECT COUNT(*) AS count FROM goal_execution_requests').get(),
          ).toEqual({ count: 0 });
        } finally {
          inspected.close();
        }
      } finally {
        reopened.close();
      }
    });
  });
});
