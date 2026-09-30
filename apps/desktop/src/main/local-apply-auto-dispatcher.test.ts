import { describe, expect, it, vi } from 'vitest';

import type {
  LocalApplyBundle,
  LocalApplyProposalClaim,
  LocalApplyProposalStatus,
} from '@chatsplice/protocol';

import { LocalApplyAutoDispatcher } from './local-apply-auto-dispatcher.js';

const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;
const PROPOSAL_ID = `proposal_${'b'.repeat(24)}`;
const CLAIM_ID = `apply_claim_${'c'.repeat(24)}`;

const bundle: LocalApplyBundle = {
  format: 'chatsplice.apply.v1',
  workspace_id: WORKSPACE_ID,
  operations: [
    {
      tool: 'fs.write',
      path: 'notes.txt',
      mode: 'create',
      content: 'fixture\n',
    },
  ],
  checks: [],
  git: [],
};

const pending: LocalApplyProposalStatus = {
  proposal_id: PROPOSAL_ID,
  workspace_id: WORKSPACE_ID,
  workspace_name: 'Fixture',
  state: 'pending_apply',
  paths: ['notes.txt'],
  operation_count: 1,
  check_count: 0,
  git_count: 0,
  created_at: '2026-08-21T00:00:00.000Z',
  expires_at: '2026-08-21T00:10:00.000Z',
  result: null,
  message: '자동 적용 대기',
};

const claim: LocalApplyProposalClaim = {
  claim_id: CLAIM_ID,
  proposal: pending,
  bundle,
};

function clientFixture() {
  return {
    client: {
      listLocalApplyProposals: vi.fn(async () => ({ proposals: [pending], count: 1 })),
      claimLocalApplyProposal: vi.fn(async () => claim),
      executeLocalApplyProposal: vi.fn(async () => ({ ...pending, state: 'applying' as const })),
      releaseLocalApplyProposal: vi.fn(async () => ({ proposals: [pending], count: 1 })),
    },
  };
}

describe('LocalApplyAutoDispatcher', () => {
  it('automatically claims an MCP proposal and applies it without confirmation', async () => {
    const fixture = clientFixture();
    const dispatcher = new LocalApplyAutoDispatcher(fixture.client);

    await dispatcher.start();
    dispatcher.stop();

    expect(fixture.client.executeLocalApplyProposal).toHaveBeenCalledExactlyOnceWith(CLAIM_ID);
    expect(fixture.client.releaseLocalApplyProposal).not.toHaveBeenCalled();
  });

  it('releases an unstarted claim on transport failure without reporting a false failure', async () => {
    const fixture = clientFixture();
    fixture.client.executeLocalApplyProposal.mockRejectedValueOnce(new Error('lost response'));
    const dispatcher = new LocalApplyAutoDispatcher(fixture.client);
    await dispatcher.start();
    dispatcher.stop();
    expect(fixture.client.releaseLocalApplyProposal).toHaveBeenCalledWith(CLAIM_ID);
  });

  it('survives a failed poll and processes work on the next poll', async () => {
    const fixture = clientFixture();
    fixture.client.listLocalApplyProposals.mockRejectedValueOnce(new Error('offline'));
    const dispatcher = new LocalApplyAutoDispatcher(fixture.client);
    await expect(dispatcher.start()).resolves.toBeUndefined();
    expect(fixture.client.claimLocalApplyProposal).not.toHaveBeenCalled();
    await dispatcher.wake();
    dispatcher.stop();
    expect(fixture.client.executeLocalApplyProposal).toHaveBeenCalledOnce();
  });
});
