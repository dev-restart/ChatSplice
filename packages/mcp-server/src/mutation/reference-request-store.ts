import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { ChatSpliceError } from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import {
  ReferenceRequestDecisionInputSchema,
  ReferenceRequestInputSchema,
  ReferenceRequestListResultSchema,
  ReferenceRequestStatusSchema,
  type ReferenceRequestDecisionInput,
  type ReferenceRequestInput,
  type ReferenceRequestListResult,
  type ReferenceRequestStatus,
  type WorkspaceReferenceAccessMode,
} from '@chatsplice/protocol';

import { workspaceBindingMatches } from '../workspace-binding.js';
import type { DirectEditActivityStore } from './direct-edit-activity-store.js';

const MAX_PENDING_REQUESTS = 100;
const MAX_REQUESTS_PER_WORKSPACE = 10;
const REQUEST_TTL_MS = 15 * 60_000;
const CONTROL_CHARACTERS = /\p{Cc}/u;

interface OwnerDecision {
  readonly approved: boolean;
  readonly accessMode: WorkspaceReferenceAccessMode;
  inFlight: Promise<ReferenceRequestStatus> | undefined;
}

interface PendingRequest {
  readonly status: ReferenceRequestStatus;
  readonly activityId: string;
  readonly sequence: number;
  readonly sourceRootPath: string;
  decision?: OwnerDecision;
}

interface RetainedResult {
  readonly status: ReferenceRequestStatus;
  readonly requestedAccessMode: WorkspaceReferenceAccessMode;
}

export type ReferenceRequestOutcome =
  | {
      readonly approved: true;
      readonly referenceWorkspaceId: string;
      readonly accessMode?: WorkspaceReferenceAccessMode;
    }
  | { readonly approved: false };

function decisionConflict(): ChatSpliceError {
  return new ChatSpliceError(
    'BAD_REQUEST',
    'A different owner decision already exists for this request.',
  );
}

/**
 * Memory-only bridge between a chat's ad-hoc folder request and the owner's
 * local decision. Submitting a request never grants access. New requests
 * propose read/write work; the owner can restrict that mode or deny access.
 * The original requested mode and source root stay fixed for retries.
 */
export class ReferenceRequestStore {
  readonly #workspaceService: WorkspaceService;
  readonly #bindingSecret: string;
  readonly #activities: DirectEditActivityStore;
  readonly #pendingById = new Map<string, PendingRequest>();
  readonly #resultsById = new Map<string, RetainedResult>();
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

    // Validate only the supplied text. Discovery and registration still wait
    // for the owner's local approval.
    if (!isAbsolute(validated.path) || CONTROL_CHARACTERS.test(validated.path)) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'A folder request requires an absolute path without control characters.',
      );
    }

    const accessMode = validated.access_mode ?? 'read_write';
    // Reuse only a pending request with the same source root, scope and mode.
    // Old grants retain their read-only fallback.
    const duplicate = [...this.#pendingById.values()].find(
      ({ status, sourceRootPath }) =>
        status.workspace_id === workspace.workspace_id &&
        sourceRootPath === workspace.rootPath &&
        status.path === validated.path &&
        status.label === (validated.label ?? null) &&
        (status.access_mode ?? 'read_only') === accessMode,
    );
    if (duplicate !== undefined) return ReferenceRequestStatusSchema.parse(duplicate.status);

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
      access_mode: accessMode,
      label: validated.label ?? null,
      state: 'pending_approval',
      reference_workspace_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
      message: `Waiting for the owner to choose folder access in ChatSplice; requested mode: ${accessMode}.`,
    });
    const activity = this.#activities.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      tool: 'fs.reference_request',
      paths: [validated.path],
      summary: accessMode === 'read_write' ? '폴더 작업 연결 승인 대기' : '폴더 읽기 승인 대기',
    });
    this.#pendingById.set(status.request_id, {
      status,
      activityId: activity.activity_id,
      sequence: this.#nextSequence++,
      sourceRootPath: workspace.rootPath,
    });
    return ReferenceRequestStatusSchema.parse(status);
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
    const status = this.#pendingById.get(requestId)?.status;
    return status === undefined ? undefined : ReferenceRequestStatusSchema.parse(status);
  }

  public getStatus(requestId: string): ReferenceRequestStatus | undefined {
    this.#pruneExpired();
    return this.#lookup(requestId);
  }

  /** Root changes and removal must not interrupt a grant that is being recorded. */
  public assertNoApplyingDecision(workspaceId: string): void {
    if (
      [...this.#pendingById.values()].some(
        (request) =>
          request.status.workspace_id === workspaceId && request.decision?.inFlight !== undefined,
      )
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'This workspace has a folder approval being applied. Retry after it finishes.',
      );
    }
  }

  /**
   * Used only after verifying the private owner capability. Retain the exact
   * choice through failed or concurrent retries and apply one grant at a time.
   */
  public async decide(
    input: ReferenceRequestDecisionInput,
    grant: (
      request: ReferenceRequestStatus,
      accessMode: WorkspaceReferenceAccessMode,
      expectedSourceRootPath: string,
    ) => Promise<string>,
  ): Promise<ReferenceRequestStatus> {
    const validated = ReferenceRequestDecisionInputSchema.parse(input);
    this.#pruneExpired();
    const retained = this.#resultsById.get(validated.request_id);
    if (retained !== undefined) {
      const status = retained.status;
      if (status.state === 'expired') {
        throw new ChatSpliceError(
          'BAD_REQUEST',
          'The reference request does not exist or expired.',
        );
      }
      const accessMode = validated.access_mode ?? retained.requestedAccessMode;
      const sameDecision =
        (status.state === 'denied' && !validated.approved) ||
        (status.state === 'approved' &&
          validated.approved &&
          (status.access_mode ?? 'read_only') === accessMode);
      if (!sameDecision) throw decisionConflict();
      return ReferenceRequestStatusSchema.parse(status);
    }

    const pending = this.#pendingById.get(validated.request_id);
    if (pending === undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The reference request does not exist or expired.');
    }
    const accessMode = validated.access_mode ?? pending.status.access_mode ?? 'read_only';
    const decision = pending.decision ?? {
      approved: validated.approved,
      accessMode,
      inFlight: undefined,
    };
    if (
      decision.approved !== validated.approved ||
      (validated.approved && decision.accessMode !== accessMode)
    ) {
      throw decisionConflict();
    }
    pending.decision = decision;

    if (!decision.approved) {
      return this.#complete(validated.request_id, { approved: false });
    }
    if (decision.inFlight !== undefined) {
      return ReferenceRequestStatusSchema.parse(await decision.inFlight);
    }

    const source = this.#workspaceService.getRecord(pending.status.workspace_id);
    if (source.kind !== 'user' || source.rootPath !== pending.sourceRootPath) {
      throw new ChatSpliceError(
        'PATH_OUTSIDE_WORKSPACE',
        'The source project folder changed after this request. Submit a new folder request.',
      );
    }

    // Publish the in-flight marker before invoking any asynchronous grant work.
    const attempt = Promise.resolve().then(async (): Promise<ReferenceRequestStatus> => {
      const referenceWorkspaceId = await grant(
        ReferenceRequestStatusSchema.parse(pending.status),
        decision.accessMode,
        pending.sourceRootPath,
      );
      return this.#complete(validated.request_id, {
        approved: true,
        referenceWorkspaceId,
        accessMode: decision.accessMode,
      });
    });
    decision.inFlight = attempt;
    try {
      return ReferenceRequestStatusSchema.parse(await attempt);
    } finally {
      if (decision.inFlight === attempt) decision.inFlight = undefined;
    }
  }

  /** Legacy internal completion; it cannot replace a grant already in progress. */
  public resolve(requestId: string, outcome: ReferenceRequestOutcome): ReferenceRequestStatus {
    if (this.#pendingById.get(requestId)?.decision?.inFlight !== undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The folder approval is still being applied.');
    }
    return this.#complete(requestId, outcome);
  }

  #complete(requestId: string, outcome: ReferenceRequestOutcome): ReferenceRequestStatus {
    const pending = this.#pendingById.get(requestId);
    if (pending === undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The reference request does not exist or expired.');
    }
    const requestedAccessMode = pending.status.access_mode ?? 'read_only';
    const accessMode = outcome.approved
      ? (outcome.accessMode ?? requestedAccessMode)
      : requestedAccessMode;
    if (
      pending.decision !== undefined &&
      (pending.decision.approved !== outcome.approved ||
        (outcome.approved && pending.decision.accessMode !== accessMode))
    ) {
      throw decisionConflict();
    }
    const status = ReferenceRequestStatusSchema.parse({
      ...pending.status,
      access_mode: accessMode,
      state: outcome.approved ? 'approved' : 'denied',
      reference_workspace_id: outcome.approved ? outcome.referenceWorkspaceId : null,
      message: outcome.approved
        ? `Approved ${accessMode} access. This folder is now available to fs.reference_list.`
        : 'The owner denied this reference request.',
    });
    this.#pendingById.delete(requestId);
    if (outcome.approved) {
      this.#activities.completeActivity(pending.activityId, {
        paths: [pending.status.path],
        summary: accessMode === 'read_write' ? '폴더 읽기·수정·실행 승인됨' : '폴더 읽기 승인됨',
      });
    } else {
      this.#activities.failActivity(pending.activityId, {
        paths: [pending.status.path],
        summary: '참조 거부됨',
      });
    }
    this.#resultsById.set(requestId, { status, requestedAccessMode });
    this.#notify(requestId);
    return ReferenceRequestStatusSchema.parse(status);
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
    this.assertNoApplyingDecision(workspaceId);
    for (const [requestId, request] of this.#pendingById) {
      if (request.status.workspace_id !== workspaceId) continue;
      this.#activities.failActivity(request.activityId, { summary: '프로젝트 연결 제거로 취소' });
      this.#pendingById.delete(requestId);
      this.#notify(requestId);
    }
    for (const [requestId, result] of this.#resultsById) {
      if (result.status.workspace_id === workspaceId) this.#resultsById.delete(requestId);
    }
  }

  #lookup(requestId: string): ReferenceRequestStatus | undefined {
    const status =
      this.#pendingById.get(requestId)?.status ?? this.#resultsById.get(requestId)?.status;
    return status === undefined ? undefined : ReferenceRequestStatusSchema.parse(status);
  }

  #notify(requestId: string): void {
    for (const resolveWaiter of this.#waitersById.get(requestId) ?? []) resolveWaiter();
    this.#waitersById.delete(requestId);
  }

  #pruneExpired(): void {
    const now = Date.now();
    for (const [requestId, request] of this.#pendingById) {
      // An accepted approval must finish with a matching result. Failed
      // attempts release this marker and follow the ordinary TTL again.
      if (request.decision?.inFlight !== undefined) continue;
      if (Date.parse(request.status.expires_at) > now) continue;
      this.#pendingById.delete(requestId);
      const status = ReferenceRequestStatusSchema.parse({
        ...request.status,
        state: 'expired',
        message: 'This reference request expired before the owner responded.',
      });
      this.#activities.failActivity(request.activityId, { summary: '참조 요청 만료' });
      this.#resultsById.set(requestId, {
        status,
        requestedAccessMode: request.status.access_mode ?? 'read_only',
      });
      this.#notify(requestId);
    }
  }
}
