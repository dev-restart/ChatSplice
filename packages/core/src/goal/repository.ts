import { GoalEvidenceSchema, GoalRecordSchema } from '@chatsplice/protocol';
import type { GoalRecord } from '@chatsplice/protocol';

export const GOAL_RECORD_MAX_BYTES = 1024 * 1024;

export interface GoalListOptions {
  readonly offset?: number;
  readonly limit?: number;
}

type StoredGoalShape = { root_identity: typeof GoalEvidenceSchema.shape.scope_digest };

// Keep the declaration portable across workspace dependency layouts.
export const StoredGoalRecordSchema: ReturnType<typeof GoalRecordSchema.extend<StoredGoalShape>> =
  GoalRecordSchema.extend({
    root_identity: GoalEvidenceSchema.shape.scope_digest,
  });
export interface StoredGoalRecord extends GoalRecord {
  readonly root_identity: string;
}

export interface GoalRepository {
  insert(record: StoredGoalRecord): StoredGoalRecord;
  find(goalId: string): StoredGoalRecord | undefined;
  list(workspaceId: string, options?: GoalListOptions): StoredGoalRecord[];
  listAll(options?: GoalListOptions): StoredGoalRecord[];
  count(workspaceId?: string): number;
  hasExecutionRequest(goalId: string, requestHash: string): boolean;
  replace(record: StoredGoalRecord, expectedRevision: number): StoredGoalRecord;
  deleteTerminal(workspaceId: string, goalId: string, expectedRevision: number): void;
  close(): void;
}
