import { describe, expect, it, vi } from 'vitest';

import type { ReferenceRequestStatus } from '@chatsplice/protocol';

const showMessageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
vi.mock('electron', () => ({ dialog: { showMessageBox } }));

const { ReferenceRequestDispatcher } = await import('./reference-request-dispatcher.js');

const REQUEST_ID = `refreq_${'a'.repeat(24)}`;
const WORKSPACE_ID = `ws_${'b'.repeat(24)}`;

const pending: ReferenceRequestStatus = {
  request_id: REQUEST_ID,
  workspace_id: WORKSPACE_ID,
  workspace_name: 'Fixture',
  path: '/Users/example/dev/other-project',
  label: null,
  state: 'pending_approval',
  reference_workspace_id: null,
  created_at: '2026-09-07T00:00:00.000Z',
  expires_at: '2026-09-07T00:15:00.000Z',
  message: 'Waiting for the owner to approve this in ChatSplice.',
};

function windowFixture() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    flashFrame: vi.fn(),
  };
}

function clientFixture() {
  return {
    listReferenceRequests: vi.fn(async () => ({ requests: [pending], count: 1 })),
    decideReferenceRequest: vi.fn(async (_id: string, approved: boolean) => ({
      ...pending,
      state: approved ? ('approved' as const) : ('denied' as const),
      reference_workspace_id: approved ? `ws_${'c'.repeat(24)}` : null,
    })),
  };
}

describe('ReferenceRequestDispatcher', () => {
  it('shows a native prompt for a pending request and relays approval', async () => {
    showMessageBox.mockClear();
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const client = clientFixture();
    const window = windowFixture();
    const dispatcher = new ReferenceRequestDispatcher(client, () => window as never);

    await dispatcher.start();
    dispatcher.stop();

    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalled();
    expect(window.flashFrame).toHaveBeenCalledWith(true);
    expect(window.flashFrame).toHaveBeenCalledWith(false);
    expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, true);
  });

  it('relays denial when the owner picks the deny button', async () => {
    showMessageBox.mockClear();
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const client = clientFixture();
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);

    await dispatcher.start();
    dispatcher.stop();

    expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, false);
  });

  it('leaves the request pending on a lost decision response instead of guessing', async () => {
    showMessageBox.mockClear();
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const client = clientFixture();
    client.decideReferenceRequest.mockRejectedValueOnce(new Error('lost response'));
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);

    await expect(dispatcher.start()).resolves.toBeUndefined();
    dispatcher.stop();

    expect(client.decideReferenceRequest).toHaveBeenCalledOnce();
  });

  it('survives a failed poll and processes the request on the next poll', async () => {
    showMessageBox.mockClear();
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const client = clientFixture();
    client.listReferenceRequests.mockRejectedValueOnce(new Error('offline'));
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);

    await expect(dispatcher.start()).resolves.toBeUndefined();
    expect(client.decideReferenceRequest).not.toHaveBeenCalled();
    await dispatcher.wake();
    dispatcher.stop();
    expect(client.decideReferenceRequest).toHaveBeenCalledOnce();
  });
});
