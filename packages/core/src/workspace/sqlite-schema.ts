import type Database from 'better-sqlite3';

const WORKSPACES_TABLE = `
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'probe', 'reference')),
    created_at TEXT NOT NULL
  ) STRICT;
`;

/** Upgrade the original registry without changing identities or deleting its snapshot. */
export function ensureWorkspaceSchema(database: Database.Database): void {
  database
    .transaction(() => {
      const table = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
        .get() as { sql: string } | undefined;
      const legacyKind = /CHECK\s*\(\s*kind\s+IN\s*\(\s*'user'\s*,\s*'probe'\s*\)\s*\)/i;
      if (table !== undefined && legacyKind.test(table.sql)) {
        // SQLite cannot alter a CHECK constraint. Keep the old table as a
        // recovery snapshot and switch registries atomically in this transaction.
        database.exec('ALTER TABLE workspaces RENAME TO workspaces_before_reference_kind');
        database.exec(WORKSPACES_TABLE);
        database.exec(`
        INSERT INTO workspaces (workspace_id, display_name, root_path, kind, created_at)
        SELECT workspace_id, display_name, root_path, kind, created_at
        FROM workspaces_before_reference_kind;
      `);
      } else {
        database.exec(WORKSPACES_TABLE);
      }
    })
    .immediate();
}
