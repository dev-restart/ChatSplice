import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  ChatGptTabStateSchema,
  McpAppNameSchema,
  TunnelConfigurationSchema,
  WorkspaceReferenceListResultSchema,
  WorkspaceReferenceMutationInputSchema,
  WorkspaceReferenceSchema,
} from '@chatsplice/protocol';
import type {
  ChatGptTabState,
  TunnelConfiguration,
  WorkspaceReference,
  WorkspaceReferenceListResult,
  WorkspaceReferenceMutationInput,
} from '@chatsplice/protocol';

import type { SettingsRepository } from './repository.js';

const TUNNEL_CONFIGURATION_KEY = 'tunnel.configuration.v1';
const CHATGPT_TAB_STATE_KEY = 'chatgpt.tabs.v1';
const WORKSPACE_REFERENCES_KEY = 'workspace.references.v1';
const READ_ONLY_MODE_KEY = 'mutation.read-only-mode.v1';
const MCP_APP_NAME_KEY = 'chatgpt.mcp-app-name.v1';
const AUTO_ATTACH_KEY = 'chatgpt.auto-attach-local-mcp.v1';

interface SettingRow {
  readonly value: string;
}

export class SqliteSettingsRepository implements SettingsRepository {
  readonly #database: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new Database(databasePath);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('foreign_keys = ON');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
  }

  public getTunnelConfiguration(): TunnelConfiguration | undefined {
    const row = this.#database
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(TUNNEL_CONFIGURATION_KEY) as SettingRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return TunnelConfigurationSchema.parse(JSON.parse(row.value) as unknown);
  }

  public setTunnelConfiguration(configuration: TunnelConfiguration): TunnelConfiguration {
    const validated = TunnelConfigurationSchema.parse(configuration);
    this.#database
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(TUNNEL_CONFIGURATION_KEY, JSON.stringify(validated));
    return validated;
  }

  public getChatGptTabState(): ChatGptTabState | undefined {
    const row = this.#readSetting(CHATGPT_TAB_STATE_KEY);
    if (row === undefined) {
      return undefined;
    }
    return ChatGptTabStateSchema.parse(JSON.parse(row.value) as unknown);
  }

  public setChatGptTabState(state: ChatGptTabState): ChatGptTabState {
    const validated = ChatGptTabStateSchema.parse(state);
    this.#writeSetting(CHATGPT_TAB_STATE_KEY, validated);
    return validated;
  }

  public getWorkspaceReferences(): WorkspaceReferenceListResult {
    const row = this.#readSetting(WORKSPACE_REFERENCES_KEY);
    if (row === undefined) {
      return { references: [], count: 0 };
    }
    return WorkspaceReferenceListResultSchema.parse(JSON.parse(row.value) as unknown);
  }

  public addWorkspaceReference(reference: WorkspaceReference): WorkspaceReference {
    const validated = WorkspaceReferenceSchema.parse(reference);
    const references = this.getWorkspaceReferences().references;
    const existing = references.find(
      (candidate) =>
        candidate.source_workspace_id === validated.source_workspace_id &&
        candidate.reference_workspace_id === validated.reference_workspace_id,
    );
    if (existing !== undefined) return existing;

    const nextReferences = [...references, validated].sort((left, right) => {
      const sourceComparison = left.source_workspace_id.localeCompare(right.source_workspace_id);
      return sourceComparison === 0
        ? left.reference_workspace_id.localeCompare(right.reference_workspace_id)
        : sourceComparison;
    });
    this.#writeSetting(
      WORKSPACE_REFERENCES_KEY,
      WorkspaceReferenceListResultSchema.parse({
        references: nextReferences,
        count: nextReferences.length,
      }),
    );
    return validated;
  }

  public removeWorkspaceReference(
    input: WorkspaceReferenceMutationInput,
  ): WorkspaceReferenceListResult {
    const validated = WorkspaceReferenceMutationInputSchema.parse(input);
    const references = this.getWorkspaceReferences().references.filter(
      (candidate) =>
        candidate.source_workspace_id !== validated.source_workspace_id ||
        candidate.reference_workspace_id !== validated.reference_workspace_id,
    );
    const result = WorkspaceReferenceListResultSchema.parse({
      references,
      count: references.length,
    });
    this.#writeSetting(WORKSPACE_REFERENCES_KEY, result);
    return result;
  }

  public removeWorkspaceReferences(workspaceId: string): WorkspaceReferenceListResult {
    const references = this.getWorkspaceReferences().references.filter(
      (candidate) =>
        candidate.source_workspace_id !== workspaceId &&
        candidate.reference_workspace_id !== workspaceId,
    );
    const result = WorkspaceReferenceListResultSchema.parse({
      references,
      count: references.length,
    });
    this.#writeSetting(WORKSPACE_REFERENCES_KEY, result);
    return result;
  }

  public getReadOnlyMode(): boolean {
    const row = this.#readSetting(READ_ONLY_MODE_KEY);
    if (row === undefined) {
      return false;
    }
    return (JSON.parse(row.value) as { enabled: boolean }).enabled;
  }

  public setReadOnlyMode(enabled: boolean): boolean {
    this.#writeSetting(READ_ONLY_MODE_KEY, { enabled });
    return enabled;
  }

  public getAutoAttachWorkspaceIds(): string[] {
    const row = this.#readSetting(AUTO_ATTACH_KEY);
    if (row === undefined) {
      return [];
    }
    return (JSON.parse(row.value) as { workspace_ids: string[] }).workspace_ids;
  }

  public setAutoAttach(workspaceId: string, enabled: boolean): string[] {
    const current = this.getAutoAttachWorkspaceIds().filter((id) => id !== workspaceId);
    const next = enabled ? [...current, workspaceId].sort() : current;
    this.#writeSetting(AUTO_ATTACH_KEY, { workspace_ids: next });
    return next;
  }

  public removeAutoAttach(workspaceId: string): string[] {
    return this.setAutoAttach(workspaceId, false);
  }

  public getMcpAppName(): string | undefined {
    const row = this.#readSetting(MCP_APP_NAME_KEY);
    if (row === undefined) return undefined;
    const parsed = McpAppNameSchema.safeParse((JSON.parse(row.value) as { name: unknown }).name);
    return parsed.success ? parsed.data : undefined;
  }

  public setMcpAppName(name: string): string {
    const validated = McpAppNameSchema.parse(name);
    this.#writeSetting(MCP_APP_NAME_KEY, { name: validated });
    return validated;
  }

  #readSetting(key: string): SettingRow | undefined {
    return this.#database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      SettingRow | undefined;
  }

  #writeSetting(key: string, value: unknown): void {
    this.#database
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  public close(): void {
    this.#database.close();
  }
}
