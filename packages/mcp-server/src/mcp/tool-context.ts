import type { WorkspaceReferenceService, WorkspaceService } from '@chatsplice/core';
import type { McpServer } from '@modelcontextprotocol/server';

import type { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import type { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import type { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import type { ProjectExecutionService } from '../execution/service.js';

/**
 * Shared dependencies and guards handed to every tool-registration module.
 * `createChatSpliceMcpServer` builds this once so all 22 tools share the same
 * binding verification, read-only kill switch, stores and execution service.
 */
export interface McpToolContext {
  readonly server: McpServer;
  readonly workspaceService: WorkspaceService;
  readonly workspaceReferenceService: WorkspaceReferenceService;
  readonly bindingSecret: string;
  readonly localApplyProposalStore: LocalApplyProposalStore;
  readonly referenceRequestStore: ReferenceRequestStore;
  readonly directEditActivityStore: DirectEditActivityStore;
  readonly isReadOnly: () => boolean;
  readonly localApplyStartWaitMs: number;
  readonly executionService: ProjectExecutionService;
  readonly assertSourceBinding: (workspaceId: string, workspaceBinding: string) => void;
  readonly assertMutationsAllowed: () => void;
}
