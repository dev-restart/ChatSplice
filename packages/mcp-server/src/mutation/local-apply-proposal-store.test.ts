import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalApplyResult } from '@chatsplice/protocol';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceBindingFor } from '../workspace-binding.js';
import { DirectEditActivityStore } from './direct-edit-activity-store.js';
import { LocalApplyProposalStore } from './local-apply-proposal-store.js';

const BINDING_SECRET = 'test-local-apply-binding-secret';

describe('LocalApplyProposalStore', () => {
  let temporaryDirectory: string;
  let repository: SqliteWorkspaceRepository;
  let store: LocalApplyProposalStore;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-apply-proposal-store-'));
    const root = join(temporaryDirectory, 'workspace');
    await mkdir(root);

    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    const workspaceService = new WorkspaceService(repository);
    workspaceId = (await workspaceService.register({ root_path: root })).workspace_id;
    store = new LocalApplyProposalStore(
      workspaceService,
      BINDING_SECRET,
      new DirectEditActivityStore(),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function submitGit(command: { command: 'status' } | { command: 'branch' }) {
    return store.submit({
      format: 'chatsplice.apply.v1',
      workspace_id: workspaceId,
      workspace_binding: workspaceBindingFor(BINDING_SECRET, workspaceId),
      operations: [],
      checks: [],
      git: [command],
    });
  }

  it('accepts a checks-only proposal and exposes an automatic-apply pending state', () => {
    const proposal = store.submit({
      format: 'chatsplice.apply.v1',
      workspace_id: workspaceId,
      workspace_binding: workspaceBindingFor(BINDING_SECRET, workspaceId),
      operations: [],
      checks: [{ task: 'typecheck', timeout_ms: 30_000 }],
      git: [],
    });

    expect(proposal).toMatchObject({
      state: 'pending_apply',
      paths: ['project.run typecheck'],
      operation_count: 0,
      check_count: 1,
      git_count: 0,
    });
    expect(store.claim(proposal.proposal_id)?.bundle).toMatchObject({
      operations: [],
      checks: [{ task: 'typecheck', timeout_ms: 30_000 }],
      git: [],
    });
  });

  it('preserves Git steps in status, dedupe, and the claimed bundle', () => {
    const statusProposal = submitGit({ command: 'status' });
    const duplicateStatusProposal = submitGit({ command: 'status' });
    const branchProposal = submitGit({ command: 'branch' });

    expect(statusProposal).toMatchObject({
      paths: ['git status'],
      operation_count: 0,
      check_count: 0,
      git_count: 1,
    });
    expect(duplicateStatusProposal.proposal_id).toBe(statusProposal.proposal_id);
    expect(branchProposal).toMatchObject({ paths: ['git branch'], git_count: 1 });
    expect(branchProposal.proposal_id).not.toBe(statusProposal.proposal_id);

    const statusClaim = store.claim(statusProposal.proposal_id);
    const branchClaim = store.claim(branchProposal.proposal_id);

    expect(statusClaim?.bundle.git).toEqual([{ command: 'status' }]);
    expect(branchClaim?.bundle.git).toEqual([{ command: 'branch' }]);
  });
  it('recovers an abandoned claim after its lease, rejecting the expired claim id', () => {
    vi.useFakeTimers();
    const proposal = submitGit({ command: 'status' });
    const claim = store.claim(proposal.proposal_id)!;
    expect(store.list().count).toBe(0);
    vi.advanceTimersByTime(30_001);
    expect(store.list().proposals[0]?.proposal_id).toBe(proposal.proposal_id);
    expect(store.execute(claim.claim_id, vi.fn())).toBeUndefined();
    const recovered = store.claim(proposal.proposal_id)!;
    expect(recovered.claim_id).not.toBe(claim.claim_id);
  });

  it('executes once across lost responses and long checks, retaining terminal retry evidence', async () => {
    vi.useFakeTimers();
    const proposal = submitGit({ command: 'status' });
    const claim = store.claim(proposal.proposal_id)!;
    let finish!: (value: LocalApplyResult) => void;
    const apply = vi.fn(
      () =>
        new Promise<LocalApplyResult>((resolve) => {
          finish = resolve;
        }),
    );
    expect(store.execute(claim.claim_id, apply)?.state).toBe('applying');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(130_000);
    store.release(claim.claim_id);
    expect(store.list().count).toBe(0);
    expect(store.execute(claim.claim_id, apply)?.state).toBe('applying');
    const waiting = store.awaitResult(proposal.proposal_id, 30_000);
    finish({
      state: 'succeeded',
      workspace_id: workspaceId,
      workspace_name: proposal.workspace_name,
      applied_steps: [],
      changed_paths: [],
      failed_step: null,
      message: 'finished',
    });
    await store.drain();
    expect((await waiting).state).toBe('succeeded');
    expect(vi.getTimerCount()).toBe(0);
    expect(store.execute(claim.claim_id, apply)?.state).toBe('succeeded');
    expect(submitGit({ command: 'status' }).proposal_id).toBe(proposal.proposal_id);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused key for different work and allows intentional new executions', async () => {
    const input = {
      format: 'chatsplice.apply.v1' as const,
      workspace_id: workspaceId,
      workspace_binding: workspaceBindingFor(BINDING_SECRET, workspaceId),
      idempotency_key: 'request_001',
      operations: [],
      checks: [],
      git: [{ command: 'status' as const }],
    };
    const first = store.submit(input);
    expect(store.submit(input).proposal_id).toBe(first.proposal_id);
    expect(() => store.submit({ ...input, git: [{ command: 'branch' }] })).toThrow(
      'different work',
    );
    expect(store.submit({ ...input, idempotency_key: 'request_002' }).proposal_id).not.toBe(
      first.proposal_id,
    );
  });

  it('publishes failures from the executor without stranding an applying claim', async () => {
    const proposal = submitGit({ command: 'status' });
    const claim = store.claim(proposal.proposal_id)!;
    store.execute(claim.claim_id, async () => {
      throw new Error('disk unavailable');
    });
    await store.drain();
    expect((await store.awaitResult(proposal.proposal_id, 0)).state).toBe('failed');
    expect(store.list().count).toBe(0);
  });
  it('does not return a stale pending status when a waiting workspace is removed', async () => {
    const proposal = submitGit({ command: 'status' });
    const waiting = store.awaitResult(proposal.proposal_id, 30_000);
    const rejected = expect(waiting).rejects.toThrow('unavailable');
    store.removeWorkspace(workspaceId);
    await rejected;
  });
});
