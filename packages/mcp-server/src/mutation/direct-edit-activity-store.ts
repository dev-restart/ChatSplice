import { randomBytes } from 'node:crypto';

import {
  DirectEditActivitySchema,
  DirectMcpActivitySchema,
  type DirectEditActivity,
  type DirectMcpActivity,
  type DirectMcpTool,
  type FsEditResult,
} from '@chatsplice/protocol';

const MAX_RECENT_ACTIVITIES_PER_WORKSPACE = 100;

export class DirectEditActivityStore {
  readonly #latestByWorkspace = new Map<string, DirectEditActivity>();
  readonly #mcpById = new Map<string, DirectMcpActivity>();
  readonly #mcpActivityIdsByWorkspace = new Map<string, string[]>();

  public record(result: FsEditResult): DirectEditActivity {
    const activity = DirectEditActivitySchema.parse({
      workspace_id: result.workspace_id,
      workspace_name: result.workspace_name,
      path: result.path,
      replacements: result.replacements,
      bytes_written: result.bytes_written,
      completed_at: new Date().toISOString(),
    });
    this.#latestByWorkspace.set(activity.workspace_id, activity);
    return activity;
  }

  public beginActivity(input: {
    workspace_id: string;
    workspace_name: string;
    source?: 'mcp' | 'local_apply';
    tool: DirectMcpTool;
    paths: string[];
    summary: string;
  }): DirectMcpActivity {
    const startedAt = new Date().toISOString();
    const activity = DirectMcpActivitySchema.parse({
      activity_id: `activity_${randomBytes(12).toString('hex')}`,
      ...input,
      source: input.source ?? 'mcp',
      state: 'running',
      started_at: startedAt,
      completed_at: null,
    });
    this.#mcpById.set(activity.activity_id, activity);
    const activityIds = this.#mcpActivityIdsByWorkspace.get(activity.workspace_id) ?? [];
    activityIds.unshift(activity.activity_id);
    this.#mcpActivityIdsByWorkspace.set(activity.workspace_id, activityIds);
    this.#trimWorkspaceActivities(activity.workspace_id);
    return activity;
  }

  public completeActivity(
    activityId: string,
    input: { paths?: string[]; summary: string },
  ): DirectMcpActivity | undefined {
    return this.#finishActivity(activityId, 'succeeded', input);
  }

  public failActivity(
    activityId: string,
    input: { paths?: string[]; summary: string },
  ): DirectMcpActivity | undefined {
    return this.#finishActivity(activityId, 'failed', input);
  }

  public recordActivity(input: {
    workspace_id: string;
    workspace_name: string;
    source?: 'mcp' | 'local_apply';
    tool: DirectMcpTool;
    paths: string[];
    summary: string;
  }): DirectMcpActivity {
    const running = this.beginActivity(input);
    return this.completeActivity(running.activity_id, input)!;
  }

  #finishActivity(
    activityId: string,
    state: 'succeeded' | 'failed',
    input: { paths?: string[]; summary: string },
  ): DirectMcpActivity | undefined {
    const running = this.#mcpById.get(activityId);
    if (running === undefined) return undefined;
    const activity = DirectMcpActivitySchema.parse({
      ...running,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      summary: input.summary,
      state,
      completed_at: new Date().toISOString(),
    });
    this.#mcpById.set(activity.activity_id, activity);
    this.#trimWorkspaceActivities(activity.workspace_id);
    return activity;
  }

  public list(): DirectEditActivity[] {
    return [...this.#latestByWorkspace.values()].sort((left, right) =>
      right.completed_at.localeCompare(left.completed_at),
    );
  }

  public listActivities(): DirectMcpActivity[] {
    return [...this.#mcpActivityIdsByWorkspace.values()]
      .flatMap((activityIds) =>
        activityIds.flatMap((activityId) => {
          const activity = this.#mcpById.get(activityId);
          return activity === undefined ? [] : [activity];
        }),
      )
      .sort((left, right) => right.started_at.localeCompare(left.started_at))
      .slice(0, 500);
  }

  public removeWorkspace(workspaceId: string): void {
    this.#latestByWorkspace.delete(workspaceId);
    for (const activityId of this.#mcpActivityIdsByWorkspace.get(workspaceId) ?? []) {
      this.#mcpById.delete(activityId);
    }
    this.#mcpActivityIdsByWorkspace.delete(workspaceId);
  }

  #trimWorkspaceActivities(workspaceId: string): void {
    const activityIds = this.#mcpActivityIdsByWorkspace.get(workspaceId);
    if (activityIds === undefined) return;

    while (activityIds.length > MAX_RECENT_ACTIVITIES_PER_WORKSPACE) {
      let terminalIndex = -1;
      for (let index = activityIds.length - 1; index >= 0; index -= 1) {
        const activityId = activityIds[index];
        if (activityId === undefined) continue;
        const activity = this.#mcpById.get(activityId);
        if (activity !== undefined && activity.state !== 'running') {
          terminalIndex = index;
          break;
        }
      }
      if (terminalIndex < 0) return;
      const [removedId] = activityIds.splice(terminalIndex, 1);
      if (removedId !== undefined) this.#mcpById.delete(removedId);
    }
  }
}
