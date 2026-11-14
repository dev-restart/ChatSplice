import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { ChatSpliceError } from '../errors.js';
import { GOAL_RECORD_MAX_BYTES, StoredGoalRecordSchema } from './repository.js';
import type { GoalListOptions, GoalRepository, StoredGoalRecord } from './repository.js';

interface GoalRow {
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly document: string;
}

function validateRecord(value: unknown): { record: StoredGoalRecord; document: string } {
  const result = StoredGoalRecordSchema.safeParse(value);
  if (!result.success) {
    throw new ChatSpliceError('BAD_REQUEST', 'Goal record is invalid.');
  }
  const document = JSON.stringify(result.data);
  if (Buffer.byteLength(document, 'utf8') > GOAL_RECORD_MAX_BYTES) {
    throw new ChatSpliceError('BAD_REQUEST', 'Goal metadata exceeds the 1 MiB storage limit.');
  }
  return { record: result.data, document };
}

function readRow(row: GoalRow): StoredGoalRecord {
  let value: unknown;
  try {
    value = JSON.parse(row.document) as unknown;
  } catch {
    throw new ChatSpliceError('BAD_REQUEST', 'Stored Goal document is malformed.');
  }
  const { record } = validateRecord(value);
  if (
    record.goal_id !== row.goal_id ||
    record.workspace_id !== row.workspace_id ||
    record.revision !== row.revision
  ) {
    throw new ChatSpliceError('BAD_REQUEST', 'Stored Goal identity or revision is inconsistent.');
  }
  return record;
}

export class SqliteGoalRepository implements GoalRepository {
  readonly #database: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        document TEXT NOT NULL CHECK (
          json_valid(document) AND length(CAST(document AS BLOB)) <= ${GOAL_RECORD_MAX_BYTES}
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS goals_workspace ON goals (workspace_id);
    `);
    // Rebuild only the legacy Goal table, atomically. Keep every document and revision.
    // Other application tables and their schema versions are untouched.
    const schema = this.#database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goals'")
      .get() as { sql: string };
    if (/<=\s*65536\b/.test(schema.sql)) {
      this.#database
        .transaction(() => {
          const currentSchema = this.#database
            .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goals'")
            .get() as { sql: string };
          if (!/<=\s*65536\b/.test(currentSchema.sql)) return;
          this.#database.exec(`
          CREATE TABLE goals_storage_upgrade (
            goal_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            document TEXT NOT NULL CHECK (
              json_valid(document) AND length(CAST(document AS BLOB)) <= ${GOAL_RECORD_MAX_BYTES}
            )
          ) STRICT;
          INSERT INTO goals_storage_upgrade (rowid, goal_id, workspace_id, revision, document)
            SELECT rowid, goal_id, workspace_id, revision, document FROM goals;
          DROP TABLE goals;
          ALTER TABLE goals_storage_upgrade RENAME TO goals;
          CREATE INDEX goals_workspace ON goals (workspace_id);
        `);
        })
        .immediate();
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS goal_execution_requests (
        goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        PRIMARY KEY (goal_id, request_hash)
      ) STRICT;
    `);
  }

  public insert(input: StoredGoalRecord): StoredGoalRecord {
    const { record, document } = validateRecord(input);
    if (record.revision !== 1) {
      throw new ChatSpliceError('BAD_REQUEST', 'A new Goal must start at revision 1.');
    }
    return this.#database
      .transaction(() => {
        if (this.find(record.goal_id) !== undefined) {
          throw new ChatSpliceError('BAD_REQUEST', 'Goal is already registered.');
        }
        this.#database
          .prepare(
            'INSERT INTO goals (goal_id, workspace_id, revision, document) VALUES (?, ?, ?, ?)',
          )
          .run(record.goal_id, record.workspace_id, record.revision, document);
        this.#rememberRequests(record);
        return record;
      })
      .immediate();
  }

  public find(goalId: string): StoredGoalRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId) as
      GoalRow | undefined;
    return row === undefined ? undefined : readRow(row);
  }

  public list(workspaceId: string, options?: GoalListOptions): StoredGoalRecord[] {
    if (
      options !== undefined &&
      (!Number.isSafeInteger(options.offset ?? 0) ||
        (options.offset ?? 0) < 0 ||
        !Number.isSafeInteger(options.limit ?? 32) ||
        (options.limit ?? 32) < 1 ||
        (options.limit ?? 32) > 32)
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Goal page must have a valid offset and limit from 1 to 32.',
      );
    }
    const rows = this.#database
      .prepare('SELECT * FROM goals WHERE workspace_id = ? ORDER BY rowid ASC LIMIT ? OFFSET ?')
      .all(
        workspaceId,
        options === undefined ? -1 : (options.limit ?? 32),
        options?.offset ?? 0,
      ) as GoalRow[];
    return rows.map(readRow);
  }

  public listAll(options?: GoalListOptions): StoredGoalRecord[] {
    if (
      options !== undefined &&
      (!Number.isSafeInteger(options.offset ?? 0) ||
        (options.offset ?? 0) < 0 ||
        !Number.isSafeInteger(options.limit ?? 32) ||
        (options.limit ?? 32) < 1 ||
        (options.limit ?? 32) > 32)
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Goal page must have a valid offset and limit from 1 to 32.',
      );
    }
    const rows = this.#database
      .prepare('SELECT * FROM goals ORDER BY rowid ASC LIMIT ? OFFSET ?')
      .all(options === undefined ? -1 : (options.limit ?? 32), options?.offset ?? 0) as GoalRow[];
    return rows.map(readRow);
  }

  /** Status polling reads only the row count, never all saved Goal documents. */
  public count(workspaceId?: string): number {
    const row = (
      workspaceId === undefined
        ? this.#database.prepare('SELECT COUNT(*) AS count FROM goals').get()
        : this.#database
            .prepare('SELECT COUNT(*) AS count FROM goals WHERE workspace_id = ?')
            .get(workspaceId)
    ) as { count: number };
    return row.count;
  }

  public hasExecutionRequest(goalId: string, requestHash: string): boolean {
    if (
      this.#database
        .prepare('SELECT 1 FROM goal_execution_requests WHERE goal_id = ? AND request_hash = ?')
        .get(goalId, requestHash) !== undefined
    )
      return true;
    // Legacy records predate the hash ledger. Their first write imports retained hashes.
    return (
      this.find(goalId)?.receipts.some((receipt) => receipt.request_hash === requestHash) ?? false
    );
  }

  #rememberRequests(record: StoredGoalRecord): void {
    const insert = this.#database.prepare(
      'INSERT OR IGNORE INTO goal_execution_requests (goal_id, request_hash) VALUES (?, ?)',
    );
    for (const receipt of record.receipts) insert.run(record.goal_id, receipt.request_hash);
  }

  public replace(input: StoredGoalRecord, expectedRevision: number): StoredGoalRecord {
    const { record, document } = validateRecord(input);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      record.revision !== expectedRevision + 1
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Goal replacement must increment the expected revision by one.',
      );
    }
    return this.#database
      .transaction(() => {
        const previous = this.find(record.goal_id);
        if (previous === undefined || previous.revision !== expectedRevision) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Goal revision changed. Read the current Goal before retrying.',
          );
        }
        if (
          record.workspace_id !== previous.workspace_id ||
          record.root_identity !== previous.root_identity ||
          record.created_at !== previous.created_at
        ) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Goal workspace, root identity and creation time are immutable.',
          );
        }
        // Preserve replay protection before obsolete receipt bodies are compacted.
        this.#rememberRequests(previous);
        this.#rememberRequests(record);
        const result = this.#database
          .prepare('UPDATE goals SET revision = ?, document = ? WHERE goal_id = ? AND revision = ?')
          .run(record.revision, document, record.goal_id, expectedRevision);
        if (result.changes !== 1) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Goal revision changed. Read the current Goal before retrying.',
          );
        }
        return record;
      })
      .immediate();
  }

  public deleteTerminal(workspaceId: string, goalId: string, expectedRevision: number): void {
    this.#database
      .transaction(() => {
        const record = this.find(goalId);
        if (record === undefined || record.workspace_id !== workspaceId) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Goal does not exist in the selected workspace.',
          );
        }
        if (record.revision !== expectedRevision) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Goal revision changed. Read the current Goal before retrying.',
          );
        }
        if (
          (record.state !== 'completed' && record.state !== 'cancelled') ||
          record.receipts.some(
            (receipt) => receipt.state === 'queued' || receipt.state === 'running',
          )
        ) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'Only completed or cancelled Goals with no owned work can be deleted.',
          );
        }
        this.#database
          .prepare('DELETE FROM goals WHERE goal_id = ? AND workspace_id = ? AND revision = ?')
          .run(goalId, workspaceId, expectedRevision);
      })
      .immediate();
  }

  public close(): void {
    this.#database.close();
  }
}
