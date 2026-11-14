import type { MessageBoxOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceRequestStatus } from '@chatsplice/protocol';

const showMessageBox = vi
  .fn<(options: MessageBoxOptions) => Promise<{ response: number; checkboxChecked?: boolean }>>()
  .mockResolvedValue({ response: 1, checkboxChecked: false });
const getLocale = vi.fn(() => 'en-US');
vi.mock('electron', () => ({ app: { getLocale }, dialog: { showMessageBox } }));

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
    decideReferenceRequest: vi.fn(
      async (
        requestId: string,
        approved: boolean,
        accessMode?: NonNullable<ReferenceRequestStatus['access_mode']>,
      ) => ({
        ...pending,
        request_id: requestId,
        ...(accessMode === undefined ? {} : { access_mode: accessMode }),
        state: approved ? ('approved' as const) : ('denied' as const),
        reference_workspace_id: approved ? `ws_${'c'.repeat(24)}` : null,
      }),
    ),
  };
}

describe('ReferenceRequestDispatcher', () => {
  beforeEach(() => {
    getLocale.mockReset();
    getLocale.mockReturnValue('en-US');
    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
  });

  it.each([undefined, 'read_only', 'read_write'] as const)(
    'shows the requested access %s before relaying the owner decision',
    async (accessMode) => {
      showMessageBox.mockClear();
      showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
      const client = clientFixture();
      const request = {
        ...pending,
        ...(accessMode === undefined ? {} : { access_mode: accessMode }),
      };
      client.listReferenceRequests.mockResolvedValue({ requests: [request], count: 1 });
      const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
      try {
        await dispatcher.start();
        const options = showMessageBox.mock.calls[0]?.[0];
        expect(options).toEqual(
          expect.objectContaining({
            defaultId: 0,
            cancelId: 0,
            buttons: ['Deny', 'Allow work in this folder'],
            checkboxLabel: 'Connect as read-only',
            checkboxChecked: accessMode !== 'read_write',
            detail: expect.stringContaining(request.path),
          }),
        );
        expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, false);
      } finally {
        dispatcher.stop();
      }
    },
  );

  it.each([0, 1])(
    'retries an owner decision %s without repeating the approval prompt',
    async (response) => {
      showMessageBox.mockClear();
      showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
      const client = clientFixture();
      client.decideReferenceRequest.mockRejectedValueOnce(new Error('decision storage failed'));
      const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
      try {
        await dispatcher.start();
        await dispatcher.wake();
        expect(showMessageBox).toHaveBeenCalledOnce();
        expect(client.decideReferenceRequest).toHaveBeenCalledTimes(2);
        const expected = response === 1 ? [REQUEST_ID, true, 'read_write'] : [REQUEST_ID, false];
        expect(client.decideReferenceRequest).toHaveBeenNthCalledWith(1, ...expected);
        expect(client.decideReferenceRequest).toHaveBeenNthCalledWith(2, ...expected);
      } finally {
        dispatcher.stop();
      }
    },
  );

  it('asks again for a different request instead of reusing another request approval', async () => {
    showMessageBox.mockClear();
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    const client = clientFixture();
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
    const next = { ...pending, request_id: `refreq_${'d'.repeat(24)}`, path: '/different-folder' };
    try {
      await dispatcher.start();
      client.listReferenceRequests.mockResolvedValue({ requests: [next], count: 1 });
      await dispatcher.wake();
      expect(showMessageBox).toHaveBeenCalledTimes(2);
      expect(client.decideReferenceRequest).toHaveBeenLastCalledWith(
        next.request_id,
        true,
        'read_write',
      );
    } finally {
      dispatcher.stop();
    }
  });

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
    expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(
      REQUEST_ID,
      true,
      'read_write',
    );
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

  it.each([
    { requested: 'read_write', checked: false, granted: 'read_write' },
    { requested: 'read_write', checked: true, granted: 'read_only' },
    { requested: 'read_only', checked: false, granted: 'read_write' },
    { requested: 'read_only', checked: true, granted: 'read_only' },
  ] as const)(
    'relays owner selection $granted for requested $requested with checkbox $checked',
    async ({ requested, checked, granted }) => {
      showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: checked });
      const client = clientFixture();
      client.listReferenceRequests.mockResolvedValue({
        requests: [{ ...pending, access_mode: requested }],
        count: 1,
      });
      const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
      try {
        await dispatcher.start();
        expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(
          REQUEST_ID,
          true,
          granted,
        );
      } finally {
        dispatcher.stop();
      }
    },
  );

  it('shows the work permission and read-only choice in Korean', async () => {
    getLocale.mockReturnValue('ko-KR');
    const dispatcher = new ReferenceRequestDispatcher(clientFixture(), () => undefined);
    try {
      await dispatcher.start();
      expect(showMessageBox.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          buttons: ['거부', '이 폴더에서 작업 허용'],
          title: '폴더 접근 권한 요청',
          checkboxLabel: '읽기 전용으로 연결',
          message: expect.stringContaining('Fixture'),
          detail: expect.stringContaining(pending.path),
        }),
      );
    } finally {
      dispatcher.stop();
    }
  });

  it.each([{ response: 2 }, { response: -1 }, { response: 1 }])(
    'fails closed for an unexpected or incomplete result %j',
    async (result) => {
      showMessageBox.mockResolvedValueOnce(result);
      const client = clientFixture();
      const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
      try {
        await dispatcher.start();
        expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, false);
      } finally {
        dispatcher.stop();
      }
    },
  );

  it('retries the same read-only choice after a lost response', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: true });
    const client = clientFixture();
    client.decideReferenceRequest.mockRejectedValueOnce(new Error('lost response'));
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
    try {
      await dispatcher.start();
      await dispatcher.wake();
      expect(showMessageBox).toHaveBeenCalledOnce();
      expect(client.decideReferenceRequest).toHaveBeenCalledTimes(2);
      expect(client.decideReferenceRequest.mock.calls).toEqual([
        [REQUEST_ID, true, 'read_only'],
        [REQUEST_ID, true, 'read_only'],
      ]);
    } finally {
      dispatcher.stop();
    }
  });

  it('processes another request before retrying a failed decision with its original mode', async () => {
    const next = {
      ...pending,
      request_id: `refreq_${'d'.repeat(24)}`,
      workspace_id: `ws_${'e'.repeat(24)}`,
      path: '/different-folder',
    };
    showMessageBox
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: true });
    const client = clientFixture();
    client.listReferenceRequests.mockResolvedValue({ requests: [pending, next], count: 2 });
    client.decideReferenceRequest.mockRejectedValueOnce(new Error('folder busy'));
    const dispatcher = new ReferenceRequestDispatcher(client, () => undefined);
    try {
      await dispatcher.start();
      await dispatcher.wake();
      await dispatcher.wake();
      expect(showMessageBox).toHaveBeenCalledTimes(2);
      expect(client.decideReferenceRequest.mock.calls).toEqual([
        [REQUEST_ID, true, 'read_write'],
        [next.request_id, true, 'read_only'],
        [REQUEST_ID, true, 'read_write'],
      ]);
    } finally {
      dispatcher.stop();
    }
  });

  it('keeps the decision if the window closes while the prompt is open', async () => {
    const client = clientFixture();
    const window = windowFixture();
    showMessageBox.mockImplementationOnce(async () => {
      window.isDestroyed.mockReturnValue(true);
      return { response: 1, checkboxChecked: true };
    });
    const dispatcher = new ReferenceRequestDispatcher(client, () => window as never);
    try {
      await dispatcher.start();
      expect(window.flashFrame.mock.calls).toEqual([[true]]);
      expect(client.decideReferenceRequest).toHaveBeenCalledExactlyOnceWith(
        REQUEST_ID,
        true,
        'read_only',
      );
    } finally {
      dispatcher.stop();
    }
  });
});
