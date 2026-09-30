import { randomBytes } from 'node:crypto';

import { ChatSpliceError } from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import {
  ReferenceRequestInputSchema,
  ReferenceRequestListResultSchema,
  ReferenceRequestStatusSchema,
  type ReferenceRequestInput,
  type ReferenceRequestListResult,
  type ReferenceRequestStatus,
} from '@chatsplice/protocol';

import { workspaceBindingMatches } from '../workspace-binding.js';
import type { DirectEditActivityStore } from './direct-edit-activity-store.js';

const MAX_PENDING_REQUESTS = 100;
const MAX_REQUESTS_PER_WORKSPACE = 10;
const REQUEST_TTL_MS = 15 * 60_000;

interface PendingRequest {
  readonly status: ReferenceRequestStatus;
  readonly activityId: string;
  readonly sequence: number;
}

export type ReferenceRequestOutcome =
  { readonly approved: true; readonly referenceWorkspaceId: string } | { readonly approved: false };

/**
 * Memory-only bridge between a chat's ad-hoc `fs.reference_request` and the
 * owner's local approval decision. Submitting a request never grants access
 * by itself — it only becomes a usable read-only reference once the desktop
 * dispatcher shows a native prompt and the owner approves it, at which point
 * the caller (control server) registers a lightweight 'reference' workspace
 * and this store is told the outcome via resolve().
 */
export class ReferenceRequestStore {
  readonly #workspaceService: WorkspaceService;
  readonly #bindingSecret: string;
  readonly #activities: DirectEditActivityStore;
  readonly #pendingById = new Map<string, PendingRequest>();
  readonly #resultsById = new Map<string, ReferenceRequestStatus>();
  readonly #waitersById = new Map<string, Set<() => void>>();
  #nextSequence = 0;

  public constructor(
    workspaceService: WorkspaceService,
    bindingSecret: string,
    activities: DirectEditActivityStore,
  ) {
    this.#workspaceService = workspaceService;
    this.#bindingSecret = bindingSecret;
    this.#activities = activities;
  }

  public submit(input: ReferenceRequestInput): ReferenceRequestStatus {
    this.#pruneExpired();
    const validated = ReferenceRequestInputSchema.parse(input);
    if (
      !workspaceBindingMatches(
        this.#bindingSecret,
        validated.workspace_id,
        validated.workspace_binding,
      )
    ) {
      throw new ChatSpliceError(
        'WORKSPACE_BINDING_REQUIRED',
        'The workspace binding is missing or does not match workspace_id.',
      );
    }
    const workspace = this.#workspaceService.getRecord(validated.workspace_id);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError('BAD_REQUEST', 'Reference requests require a user workspace.');
    }

    const workspaceCount = [...this.#pendingById.values()].filter(
      (request) => request.status.workspace_id === workspace.workspace_id,
    ).length;
    if (workspaceCount >= MAX_REQUESTS_PER_WORKSPACE) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `This workspace already has ${MAX_REQUESTS_PER_WORKSPACE} pending reference requests.`,
      );
    }
    if (this.#pendingById.size >= MAX_PENDING_REQUESTS) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'ChatSplice reference request capacity was reached.',
      );
    }

    const now = new Date();
    const status = ReferenceRequestStatusSchema.parse({
      request_id: `refreq_${randomBytes(12).toString('hex')}`,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      path: validated.path,
      label: validated.label ?? null,
      state: 'pending_approval',
      reference_workspace_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
      message: 'Waiting for the owner to approve this in ChatSplice.',
    });
    const activity = this.#activities.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      tool: 'fs.reference_request',
      paths: [validated.path],
      summary: '참조 승인 대기',
    });
    this.#pendingById.set(status.request_id, {
      status,
      activityId: activity.activity_id,
      sequence: this.#nextSequence++,
    });
    return status;
  }

  public list(): ReferenceRequestListResult {
    this.#pruneExpired();
    const requests = [...this.#pendingById.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ status }) => status);
    return ReferenceRequestListResultSchema.parse({ requests, count: requests.length });
  }

  public getPending(requestId: string): ReferenceRequestStatus | undefined {
    this.#pruneExpired();
    return this.#pendingById.get(requestId)?.status;
  }

  /** Called once by the control server, after it has already acted on the outcome. */
  public resolve(requestId: string, outcome: ReferenceRequestOutcome): ReferenceRequestStatus {
    const pending = this.#pendingById.get(requestId);
    if (pending === undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The reference request does not exist or expired.');
    }
    this.#pendingById.delete(requestId);
    const status = ReferenceRequestStatusSchema.parse({
      ...pending.status,
      state: outcome.approved ? 'approved' : 'denied',
      reference_workspace_id: outcome.approved ? outcome.referenceWorkspaceId : null,
      message: outcome.approved
        ? 'Approved. This reference is now available to fs.reference_list.'
        : 'The owner denied this reference request.',
    });
    if (outcome.approved) {
      this.#activities.completeActivity(pending.activityId, {
        paths: [pending.status.path],
        summary: '참조 승인됨',
      });
    } else {
      this.#activities.failActivity(pending.activityId, {
        paths: [pending.status.path],
        summary: '참조 거부됨',
      });
    }
    this.#resultsById.set(requestId, status);
    this.#notify(requestId);
    return status;
  }

  public async awaitResult(requestId: string, timeoutMs: number): Promise<ReferenceRequestStatus> {
    this.#pruneExpired();
    const current = this.#lookup(requestId);
    if (current === undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The reference request does not exist or expired.');
    }
    if (current.state !== 'pending_approval' || timeoutMs === 0) {
      return current;
    }
    await new Promise<void>((resolvePromise) => {
      const waiters = this.#waitersById.get(requestId) ?? new Set<() => void>();
      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.#waitersById.delete(requestId);
        resolvePromise();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.add(finish);
      this.#waitersById.set(requestId, waiters);
      timer.unref();
    });
    this.#pruneExpired();
    return this.#lookup(requestId) ?? current;
  }

  public removeWorkspace(workspaceId: string): void {
    for (const [requestId, request] of this.#pendingById) {
      if (request.status.workspace_id !== workspaceId) continue;
      this.#activities.failActivity(request.activityId, { summary: '프로젝트 연결 제거로 취소' });
      this.#pendingById.delete(requestId);
      this.#notify(requestId);
    }
    for (const [requestId, status] of this.#resultsById) {
      if (status.workspace_id === workspaceId) this.#resultsById.delete(requestId);
    }
  }

  #lookup(requestId: string): ReferenceRequestStatus | undefined {
    return this.#pendingById.get(requestId)?.status ?? this.#resultsById.get(requestId);
  }

  #notify(requestId: string): void {
    for (const resolveWaiter of this.#waitersById.get(requestId) ?? []) resolveWaiter();
    this.#waitersById.delete(requestId);
  }

  #pruneExpired(): void {
    const now = Date.now();
    for (const [requestId, request] of this.#pendingById) {
      if (Date.parse(request.status.expires_at) > now) continue;
      this.#pendingById.delete(requestId);
      const status = ReferenceRequestStatusSchema.parse({
        ...request.status,
        state: 'expired',
        message: 'This reference request expired before the owner responded.',
      });
      this.#activities.failActivity(request.activityId, { summary: '참조 요청 만료' });
      this.#resultsById.set(requestId, status);
      this.#notify(requestId);
    }
  }
}
