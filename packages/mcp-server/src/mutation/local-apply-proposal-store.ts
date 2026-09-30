import { createHash, randomBytes } from 'node:crypto';

import { ChatSpliceError } from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import {
  LocalApplyBundleSchema,
  LocalApplyProposalClaimSchema,
  LocalApplyProposalInputSchema,
  LocalApplyProposalListResultSchema,
  LocalApplyProposalStatusSchema,
  type LocalApplyBundle,
  type LocalApplyProposalClaim,
  type LocalApplyProposalCompletionInput,
  type LocalApplyProposalInput,
  type LocalApplyProposalListResult,
  type LocalApplyProposalStatus,
  type LocalApplyResult,
} from '@chatsplice/protocol';

import { workspaceBindingMatches } from '../workspace-binding.js';
import type { DirectEditActivityStore } from './direct-edit-activity-store.js';

const MAX_PENDING_PROPOSALS = 500;
const MAX_PROPOSALS_PER_WORKSPACE = 20;
const MAX_RETAINED_RESULTS = 500;
const PROPOSAL_TTL_MS = 10 * 60_000;
const CLAIM_LEASE_MS = 30_000;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;

interface PendingProposal {
  readonly status: LocalApplyProposalStatus;
  readonly bundle: LocalApplyBundle;
  readonly activityId: string;
  readonly sequence: number;
}

interface ClaimedProposal extends PendingProposal {
  readonly claimId: string;
  readonly claimedAt: number;
  applying: boolean;
}

function bundlePaths(bundle: LocalApplyBundle): string[] {
  return [
    ...new Set([
      ...bundle.operations.flatMap((operation) =>
        operation.tool === 'fs.rename'
          ? [operation.source_path, operation.destination_path]
          : [operation.path],
      ),
      ...bundle.checks.map((check) => `project.run ${check.task}`),
      ...bundle.git.map((command) => `git ${command.command}`),
    ]),
  ].slice(0, 40);
}

function dedupeKey(input: LocalApplyBundle): string {
  return `${input.workspace_id}\u0000${input.idempotency_key ?? bundleHash(input)}`;
}

function bundleHash(input: LocalApplyBundle): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Memory-only bridge between a ChatGPT mutation request and the Electron
 * desktop auto-applier. Submitting a proposal never calls a filesystem or
 * process mutation function; the desktop dispatcher claims the proposal and
 * applies it through the separately authenticated mutation path.
 */
export class LocalApplyProposalStore {
  readonly #workspaceService: WorkspaceService;
  readonly #bindingSecret: string;
  readonly #activities: DirectEditActivityStore;
  readonly #pendingById = new Map<string, PendingProposal>();
  readonly #claimsById = new Map<string, ClaimedProposal>();
  readonly #resultsById = new Map<string, LocalApplyProposalStatus>();
  readonly #waitersById = new Map<string, Set<() => void>>();
  readonly #requestsByKey = new Map<string, { proposalId: string; hash: string }>();
  readonly #terminalClaims = new Map<string, string>();
  readonly #executions = new Map<string, Promise<void>>();
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

  public submit(input: LocalApplyProposalInput): LocalApplyProposalStatus {
    this.#pruneExpired();
    const validated = LocalApplyProposalInputSchema.parse(input);
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
      throw new ChatSpliceError('BAD_REQUEST', 'Local apply proposals require a user workspace.');
    }

    const bundle = LocalApplyBundleSchema.parse({
      format: validated.format,
      workspace_id: validated.workspace_id,
      ...(validated.idempotency_key === undefined
        ? {}
        : { idempotency_key: validated.idempotency_key }),
      operations: validated.operations,
      checks: validated.checks,
      git: validated.git,
    });
    const key = dedupeKey(bundle);
    if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > 900 * 1024) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Split proposals larger than 900 KiB into smaller requests.',
      );
    }
    const previous = this.#requestsByKey.get(key);
    if (previous !== undefined) {
      if (previous.hash !== bundleHash(bundle)) {
        throw new ChatSpliceError(
          'BAD_REQUEST',
          'The idempotency key was already used for different work.',
        );
      }
      const duplicate = this.#lookup(previous.proposalId);
      if (duplicate !== undefined) return duplicate;
    }

    const pendingBytes = [...this.#pendingById.values(), ...this.#claimsById.values()].reduce(
      (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.bundle)),
      0,
    );
    if (pendingBytes + Buffer.byteLength(JSON.stringify(bundle)) > MAX_RETAINED_BYTES) {
      throw new ChatSpliceError('BAD_REQUEST', 'The bounded proposal memory budget is full.');
    }

    const workspaceCount = [...this.#pendingById.values(), ...this.#claimsById.values()].filter(
      (proposal) => proposal.status.workspace_id === workspace.workspace_id,
    ).length;
    if (workspaceCount >= MAX_PROPOSALS_PER_WORKSPACE) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `This workspace already has ${MAX_PROPOSALS_PER_WORKSPACE} pending apply proposals.`,
      );
    }
    if (this.#pendingById.size + this.#claimsById.size >= MAX_PENDING_PROPOSALS) {
      throw new ChatSpliceError('BAD_REQUEST', 'ChatSplice apply proposal capacity was reached.');
    }

    const now = new Date();
    const paths = bundlePaths(bundle);
    const status = LocalApplyProposalStatusSchema.parse({
      proposal_id: `proposal_${randomBytes(12).toString('hex')}`,
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      state: 'pending_apply',
      paths,
      operation_count: bundle.operations.length,
      check_count: bundle.checks.length,
      git_count: bundle.git.length,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
      result: null,
      message: '변경 제안이 접수되었습니다. ChatSplice가 자동으로 감지해 적용합니다.',
    });
    const activity = this.#activities.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      source: 'local_apply',
      tool: 'local.prepare_apply',
      paths: paths.slice(0, 2),
      summary: '변경 적용 대기',
    });
    this.#pendingById.set(status.proposal_id, {
      status,
      bundle,
      activityId: activity.activity_id,
      sequence: this.#nextSequence++,
    });
    this.#requestsByKey.set(key, { proposalId: status.proposal_id, hash: bundleHash(bundle) });
    return status;
  }

  public list(): LocalApplyProposalListResult {
    this.#pruneExpired();
    const proposals = [...this.#pendingById.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ status }) => status);
    return LocalApplyProposalListResultSchema.parse({ proposals, count: proposals.length });
  }

  public claim(proposalId: string): LocalApplyProposalClaim | null {
    this.#pruneExpired();
    const pending = this.#pendingById.get(proposalId);
    if (pending === undefined) return null;
    this.#pendingById.delete(proposalId);
    const claim: ClaimedProposal = {
      ...pending,
      claimId: `apply_claim_${randomBytes(12).toString('hex')}`,
      claimedAt: Date.now(),
      applying: false,
    };
    this.#claimsById.set(claim.claimId, claim);
    return LocalApplyProposalClaimSchema.parse({
      claim_id: claim.claimId,
      proposal: claim.status,
      bundle: claim.bundle,
    });
  }

  /** Electron authorizes once; the daemon owns execution and terminal evidence. */
  public execute(
    claimId: string,
    apply: (bundle: LocalApplyBundle) => Promise<LocalApplyResult>,
  ): LocalApplyProposalStatus | undefined {
    this.#pruneExpired();
    const terminalId = this.#terminalClaims.get(claimId);
    if (terminalId !== undefined) return this.#lookup(terminalId);
    const claim = this.#claimsById.get(claimId);
    if (claim === undefined) return undefined;
    if (this.#executions.has(claimId)) return this.#statusForClaim(claim);
    claim.applying = true;
    const execution = Promise.resolve()
      .then(async () => {
        try {
          const result = await apply(claim.bundle);
          this.#complete({ claim_id: claimId, outcome: 'completed', result });
        } catch {
          this.#complete({
            claim_id: claimId,
            outcome: 'failed',
            message: '변경 실행에 실패했습니다. 현재 파일을 다시 확인하세요.',
          });
        }
      })
      .finally(() => this.#executions.delete(claimId));
    this.#executions.set(claimId, execution);
    return this.#statusForClaim(claim);
  }

  public async drain(): Promise<void> {
    await Promise.allSettled(this.#executions.values());
  }

  public release(claimId: string): LocalApplyProposalListResult {
    const claim = this.#claimsById.get(claimId);
    if (claim !== undefined && !claim.applying) {
      this.#claimsById.delete(claimId);
      this.#pendingById.set(claim.status.proposal_id, claim);
    }
    return this.list();
  }

  #complete(input: LocalApplyProposalCompletionInput): LocalApplyProposalStatus | undefined {
    const claim = this.#claimsById.get(input.claim_id);
    if (claim === undefined) return undefined;

    let status: LocalApplyProposalStatus;
    if (input.outcome === 'completed') {
      if (input.result.workspace_id !== claim.status.workspace_id) {
        throw new ChatSpliceError('BAD_REQUEST', 'Apply result workspace mismatch.');
      }
      status = LocalApplyProposalStatusSchema.parse({
        ...claim.status,
        state: input.result.state,
        result: input.result,
        message: input.result.message,
      });
      const activityInput = {
        ...(input.result.changed_paths.length > 0
          ? { paths: input.result.changed_paths.slice(0, 2) }
          : {}),
        summary:
          input.result.state === 'succeeded'
            ? `${input.result.changed_paths.length}개 경로 변경 완료`
            : '변경 적용 실패',
      };
      if (input.result.state === 'succeeded') {
        this.#activities.completeActivity(claim.activityId, activityInput);
      } else {
        this.#activities.failActivity(claim.activityId, activityInput);
      }
    } else {
      status = LocalApplyProposalStatusSchema.parse({
        ...claim.status,
        state: input.outcome,
        result: null,
        message: input.message,
      });
      this.#activities.failActivity(claim.activityId, {
        summary: input.outcome === 'cancelled' ? '변경 적용 취소' : '변경 적용 실패',
      });
    }
    this.#claimsById.delete(input.claim_id);
    this.#terminalClaims.set(input.claim_id, status.proposal_id);
    this.#storeResult(status);
    this.#notify(status.proposal_id);
    return status;
  }

  public async awaitResult(
    proposalId: string,
    timeoutMs: number,
  ): Promise<LocalApplyProposalStatus> {
    this.#pruneExpired();
    const current = this.#lookup(proposalId);
    if (current === undefined) {
      throw new ChatSpliceError('BAD_REQUEST', 'The apply proposal does not exist or has expired.');
    }
    if (!['pending_apply', 'applying'].includes(current.state) || timeoutMs === 0) {
      return current;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.#waitersById.get(proposalId) ?? new Set<() => void>();
      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.#waitersById.delete(proposalId);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      waiters.add(finish);
      this.#waitersById.set(proposalId, waiters);
      timer.unref();
    });
    this.#pruneExpired();
    const next = this.#lookup(proposalId);
    if (next === undefined)
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'The apply result is unavailable. Re-read current files before submitting new work.',
      );
    return next;
  }

  public removeWorkspace(workspaceId: string): void {
    for (const [proposalId, proposal] of this.#pendingById) {
      if (proposal.status.workspace_id !== workspaceId) continue;
      this.#activities.failActivity(proposal.activityId, { summary: '프로젝트 연결 제거로 취소' });
      this.#pendingById.delete(proposalId);
      this.#notify(proposalId);
    }
    for (const [claimId, claim] of this.#claimsById) {
      if (claim.status.workspace_id !== workspaceId) continue;
      this.#activities.failActivity(claim.activityId, { summary: '프로젝트 연결 제거로 취소' });
      this.#claimsById.delete(claimId);
      this.#notify(claim.status.proposal_id);
    }
    for (const [proposalId, status] of this.#resultsById) {
      if (status.workspace_id === workspaceId) this.#forgetResult(proposalId);
    }
    for (const [key] of this.#requestsByKey) {
      if (key.startsWith(`${workspaceId}\u0000`)) this.#requestsByKey.delete(key);
    }
  }

  #lookup(proposalId: string): LocalApplyProposalStatus | undefined {
    const pending = this.#pendingById.get(proposalId);
    if (pending !== undefined) return pending.status;
    const claim = [...this.#claimsById.values()].find(
      (candidate) => candidate.status.proposal_id === proposalId,
    );
    if (claim !== undefined) return this.#statusForClaim(claim);
    return this.#resultsById.get(proposalId);
  }

  #statusForClaim(claim: ClaimedProposal): LocalApplyProposalStatus {
    return LocalApplyProposalStatusSchema.parse({
      ...claim.status,
      state: claim.applying ? 'applying' : 'pending_apply',
      message: claim.applying
        ? 'ChatSplice가 변경을 적용하고 있습니다.'
        : 'ChatSplice가 변경을 적용할 준비를 하고 있습니다.',
    });
  }

  #storeResult(status: LocalApplyProposalStatus): void {
    this.#resultsById.set(status.proposal_id, status);
    let bytes = [...this.#resultsById.values()].reduce(
      (sum, result) => sum + Buffer.byteLength(JSON.stringify(result)),
      0,
    );
    while (this.#resultsById.size > MAX_RETAINED_RESULTS || bytes > MAX_RETAINED_BYTES) {
      const oldest = this.#resultsById.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      bytes -= Buffer.byteLength(JSON.stringify(this.#resultsById.get(oldest)));
      this.#forgetResult(oldest);
    }
  }

  #forgetResult(proposalId: string): void {
    this.#resultsById.delete(proposalId);
    for (const [key, request] of this.#requestsByKey) {
      if (request.proposalId === proposalId) this.#requestsByKey.delete(key);
    }
    for (const [claimId, id] of this.#terminalClaims) {
      if (id === proposalId) this.#terminalClaims.delete(claimId);
    }
  }

  #notify(proposalId: string): void {
    for (const resolve of this.#waitersById.get(proposalId) ?? []) resolve();
    this.#waitersById.delete(proposalId);
  }

  #pruneExpired(): void {
    const now = Date.now();
    for (const [claimId, claim] of this.#claimsById) {
      if (claim.applying || now - claim.claimedAt < CLAIM_LEASE_MS) continue;
      this.#claimsById.delete(claimId);
      this.#pendingById.set(claim.status.proposal_id, claim);
    }
    for (const [proposalId, proposal] of this.#pendingById) {
      if (Date.parse(proposal.status.expires_at) > now) continue;
      this.#pendingById.delete(proposalId);
      const status = LocalApplyProposalStatusSchema.parse({
        ...proposal.status,
        state: 'cancelled',
        message: '변경 적용이 만료되었습니다. 현재 파일을 다시 읽고 새 변경안을 만드세요.',
      });
      this.#activities.failActivity(proposal.activityId, { summary: '변경 적용 만료' });
      this.#storeResult(status);
      this.#notify(proposalId);
    }
  }
}
