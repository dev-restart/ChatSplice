import { ChatSpliceError, SqliteGoalRepository } from '@chatsplice/core';
import { randomUUID } from 'node:crypto';
import type { WorkspaceReferenceService, WorkspaceService } from '@chatsplice/core';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '@chatsplice/protocol';
import { McpServer } from '@modelcontextprotocol/server';

import { workspaceBindingMatches } from '../workspace-binding.js';
import type { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import type { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import type { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import { DESKTOP_EXECUTION_CONCURRENCY, ProjectExecutionService } from '../execution/service.js';
import type { McpToolContext } from './tool-context.js';
import { getMcpToolCatalogIdentity, registerMcpTools } from './tool-catalog.js';
import { GoalService } from '../goal/service.js';
import { getRuntimeIdentitySync } from '../runtime-identity.js';

const DEFAULT_LOCAL_APPLY_START_WAIT_MS = 20_000;

export interface ChatSpliceMcpServerOptions {
  /** Test-only override for the native ChatSplice approval wait. */
  readonly localApplyStartWaitMs?: number;
  /** Shared daemon-owned execution lifecycle. */
  readonly executionService?: ProjectExecutionService;
  readonly goalService?: GoalService;
}

export function createChatSpliceMcpServer(
  workspaceService: WorkspaceService,
  workspaceReferenceService: WorkspaceReferenceService,
  bindingSecret: string,
  localApplyProposalStore: LocalApplyProposalStore,
  referenceRequestStore: ReferenceRequestStore,
  directEditActivityStore: DirectEditActivityStore,
  isReadOnly: () => boolean,
  options: ChatSpliceMcpServerOptions = {},
): McpServer {
  if (options.executionService !== undefined && options.goalService === undefined) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'A caller-owned execution service requires its shared caller-owned Goal service.',
    );
  }
  const ownsExecutionService = options.executionService === undefined;
  const localApplyStartWaitMs = options.localApplyStartWaitMs ?? DEFAULT_LOCAL_APPLY_START_WAIT_MS;
  const executionService =
    options.executionService ??
    new ProjectExecutionService(workspaceService, {
      isReadOnly,
      concurrency: DESKTOP_EXECUTION_CONCURRENCY,
      referenceService: workspaceReferenceService,
    });
  // Embedded MCP clients share a Goal store for this server lifetime. HTTP and
  // daemon owners pass their longer-lived service explicitly.
  const embeddedRepository =
    options.goalService === undefined ? new SqliteGoalRepository(':memory:') : undefined;
  const identity = { ...getRuntimeIdentitySync(), run_id: randomUUID() };
  const goalService =
    options.goalService ??
    new GoalService(embeddedRepository!, workspaceService, {
      buildId: identity.build_id,
      runId: identity.run_id,
      isReadOnly,
    });
  goalService.setExecutionService(executionService);
  executionService.setGoalLifecycle(goalService);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Transport authentication admits a connection; this binding authorizes an
  // individual project request. A matching display name grants no access.
  const assertSourceBinding = (workspaceId: string, workspaceBinding: string): void => {
    if (!workspaceBindingMatches(bindingSecret, workspaceId, workspaceBinding)) {
      throw new ChatSpliceError(
        'WORKSPACE_BINDING_REQUIRED',
        'The workspace binding is missing or does not match workspace_id. Do not select another workspace by name.',
      );
    }
  };

  /**
   * The single owner-controlled kill switch (Settings → read-only mode) for
   * every tool that starts new mutation or command execution.
   * Checked first in each such handler, before any binding lookup or side
   * effect, so flipping it off in ChatSplice takes effect on the very next
   * call with no server restart.
   */
  const assertMutationsAllowed = (): void => {
    if (isReadOnly()) {
      throw new ChatSpliceError(
        'READ_ONLY_MODE_ENABLED',
        'ChatSplice read-only mode is on. Turn it off in ChatSplice Settings to write, create, rename, delete files, run project checks, run git commands, or execute project work in this workspace.',
      );
    }
  };

  const context: McpToolContext = {
    server,
    workspaceService,
    workspaceReferenceService,
    bindingSecret,
    localApplyProposalStore,
    referenceRequestStore,
    directEditActivityStore,
    isReadOnly,
    localApplyStartWaitMs,
    executionService,
    goalService,
    readToolCatalogIdentity: getMcpToolCatalogIdentity,
    assertSourceBinding,
    assertMutationsAllowed,
  };

  registerMcpTools(context);

  if (ownsExecutionService || embeddedRepository !== undefined) {
    const close = server.close.bind(server);
    let closePromise: Promise<void> | undefined;
    server.close = () => {
      closePromise ??= (async () => {
        if (ownsExecutionService) await executionService.shutdown();
        await close();
        embeddedRepository?.close();
      })();
      return closePromise;
    };
  }

  return server;
}
