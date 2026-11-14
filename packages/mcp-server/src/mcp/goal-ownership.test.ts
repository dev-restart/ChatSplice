import {
  SqliteGoalRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectExecutionService } from '../execution/service.js';
import { GoalService } from '../goal/service.js';
import { startMcpHttpServer } from '../http/server.js';
import { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import { createChatSpliceMcpServer } from './server.js';

describe('Embedded Goal and execution ownership', () => {
  let workspaces: WorkspaceService;
  let references: WorkspaceReferenceService;
  let workspaceRepository: SqliteWorkspaceRepository;
  let settings: SqliteSettingsRepository;
  let goals: SqliteGoalRepository;
  let activity: DirectEditActivityStore;
  let proposals: LocalApplyProposalStore;
  let requests: ReferenceRequestStore;
  let execution: ProjectExecutionService;
  let goal: GoalService;
  const token = '0'.repeat(64);
  const isReadOnly = () => false;

  beforeEach(() => {
    workspaceRepository = new SqliteWorkspaceRepository(':memory:');
    settings = new SqliteSettingsRepository(':memory:');
    goals = new SqliteGoalRepository(':memory:');
    workspaces = new WorkspaceService(workspaceRepository);
    references = new WorkspaceReferenceService(workspaces, settings);
    activity = new DirectEditActivityStore();
    proposals = new LocalApplyProposalStore(workspaces, token, activity);
    requests = new ReferenceRequestStore(workspaces, token, activity);
    execution = new ProjectExecutionService(workspaces);
    goal = new GoalService(goals, workspaces, {
      buildId: '0'.repeat(64),
      runId: '00000000-0000-4000-8000-000000000001',
    });
  });

  afterEach(async () => {
    await execution.shutdown();
    goals.close();
    settings.close();
    workspaceRepository.close();
  });

  it('rejects unpaired caller execution before creating or closing its dependencies', async () => {
    const shutdown = vi.spyOn(execution, 'shutdown');
    expect(() =>
      createChatSpliceMcpServer(
        workspaces,
        references,
        token,
        proposals,
        requests,
        activity,
        isReadOnly,
        { executionService: execution },
      ),
    ).toThrow('caller-owned Goal service');
    await expect(
      startMcpHttpServer(workspaces, references, token, proposals, requests, activity, isReadOnly, {
        executionService: execution,
      }),
    ).rejects.toThrow('caller-owned Goal service');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('leaves explicitly paired caller services open when direct or HTTP MCP closes', async () => {
    const shutdown = vi.spyOn(execution, 'shutdown');
    const options = { executionService: execution, goalService: goal };
    const server = createChatSpliceMcpServer(
      workspaces,
      references,
      token,
      proposals,
      requests,
      activity,
      isReadOnly,
      options,
    );
    await server.close();
    const http = await startMcpHttpServer(
      workspaces,
      references,
      token,
      proposals,
      requests,
      activity,
      isReadOnly,
      options,
    );
    await http.close();
    expect(shutdown).not.toHaveBeenCalled();
    expect(goals.listAll()).toEqual([]);
  });

  it('drains an owned direct execution even when its Goal repository is caller-owned', async () => {
    const attach = vi.spyOn(goal, 'setExecutionService');
    const server = createChatSpliceMcpServer(
      workspaces,
      references,
      token,
      proposals,
      requests,
      activity,
      isReadOnly,
      { goalService: goal },
    );
    const owned = attach.mock.calls[0]?.[0];
    if (owned === undefined) throw new Error('Owned execution service was not attached.');
    const shutdown = vi.spyOn(owned, 'shutdown');
    await Promise.all([server.close(), server.close()]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(goals.listAll()).toEqual([]);
  });
});
