import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { CreateWorkspaceRecord, WorkspaceRecord, WorkspaceRepository } from './repository.js';

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly display_name: string;
  readonly root_path: string;
  readonly kind: 'user' | 'probe' | 'reference';
  readonly created_at: string;
}

function rowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspace_id: row.workspace_id,
    display_name: row.display_name,
    rootPath: row.root_path,
    kind: row.kind,
    created_at: row.created_at,
  };
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  readonly #database: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'probe', 'reference')),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  public create(input: CreateWorkspaceRecord): WorkspaceRecord {
    this.#database
      .prepare(
        `INSERT INTO workspaces
          (workspace_id, display_name, root_path, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.workspaceId, input.displayName, input.rootPath, input.kind, input.createdAt);

    const created = this.findById(input.workspaceId);
    if (created === undefined) {
      throw new Error('Workspace was not available after insertion.');
    }
    return created;
  }

  public rename(workspaceId: string, displayName: string): WorkspaceRecord | undefined {
    this.#database
      .prepare('UPDATE workspaces SET display_name = ? WHERE workspace_id = ?')
      .run(displayName, workspaceId);
    return this.findById(workspaceId);
  }

  public updateRootPath(workspaceId: string, rootPath: string): WorkspaceRecord | undefined {
    this.#database
      .prepare('UPDATE workspaces SET root_path = ? WHERE workspace_id = ?')
      .run(rootPath, workspaceId);
    return this.findById(workspaceId);
  }

  public remove(workspaceId: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM workspaces WHERE workspace_id = ?')
      .run(workspaceId);
    return result.changes === 1;
  }

  public findById(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as WorkspaceRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  public findByRoot(rootPath: string): WorkspaceRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workspaces WHERE root_path = ?')
      .get(rootPath) as WorkspaceRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  public list(): WorkspaceRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM workspaces ORDER BY kind = 'probe' DESC, created_at ASC")
      .all() as WorkspaceRow[];
    return rows.map(rowToRecord);
  }

  public close(): void {
    this.#database.close();
  }
}
