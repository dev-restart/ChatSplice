import { describe, expect, it, vi } from 'vitest';

import type { DaemonStatus } from '@chatsplice/protocol';
import type { LocalMcpAutoAttachContext } from './chatgpt-tabs.js';

import { LocalMcpAutoAttachDispatcher } from './local-mcp-auto-attach-dispatcher.js';

const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;

function statusFixture(autoAttachWorkspaceIds: string[]): DaemonStatus {
  return {
    protocol_version: 4,
    healthy: true,
    ready: true,
    mcp_url: 'http://127.0.0.1:39001/mcp',
    workspace_count: 1,
    probe_workspace_id: 'workspace_probe',
    latest_direct_edits: [],
    latest_mcp_activities: [],
    execution_jobs: [],
    tunnel: {
      mode: 'none',
      state: 'unconfigured',
      healthy: false,
      ready: false,
      configuration: null,
      detected_executable_path: null,
      detected_tunnel_id: null,
      mcp_url: null,
      admin_url: null,
      error_code: null,
    },
    read_only_mode: false,
    auto_attach_workspace_ids: autoAttachWorkspaceIds,
    mcp_app_name: 'ChatSplice MCP',
  };
}

function clientFixture(autoAttachWorkspaceIds: string[]) {
  return { status: vi.fn(async () => statusFixture(autoAttachWorkspaceIds)) };
}

function tabsFixture(context?: LocalMcpAutoAttachContext) {
  let currentContext = context;
  return {
    runLocalMcpAutoAttach: vi.fn(async () => 'attached'),
    getLocalMcpAutoAttachContext: vi.fn(() => currentContext),
    setContext: (next: LocalMcpAutoAttachContext | undefined) => {
      currentContext = next;
    },
  };
}

function context(tabId: string, workspaceId = WORKSPACE_ID, url = 'https://chatgpt.com/c/1') {
  return { chatgpt_tab_id: tabId, workspace_id: workspaceId, url };
}

describe('LocalMcpAutoAttachDispatcher', () => {
  it('runs the composer script for a project with the toggle on', async () => {
    const client = clientFixture([WORKSPACE_ID]);
    const tabs = tabsFixture();
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

    await dispatcher.start();
    dispatcher.stop();

    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledExactlyOnceWith(
      new Set([WORKSPACE_ID]),
      'ChatSplice MCP',
    );
  });

  it('never touches the composer when no project has the toggle on', async () => {
    const client = clientFixture([]);
    const tabs = tabsFixture();
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

    await dispatcher.start();
    dispatcher.stop();

    expect(tabs.runLocalMcpAutoAttach).not.toHaveBeenCalled();
  });

  it.each(['busy', 'awaiting_input', 'user_input_active'])(
    'does not apply failure cooldown after normal %s pauses',
    async (result) => {
      const client = clientFixture([WORKSPACE_ID]);
      const tabs = tabsFixture(context('tab_a'));
      tabs.runLocalMcpAutoAttach.mockResolvedValueOnce(result).mockResolvedValue('attached');
      const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

      await dispatcher.start();
      await dispatcher.wake();
      dispatcher.stop();

      expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledTimes(2);
    },
  );

  it('survives a failed status call and tries again on the next poll', async () => {
    const client = clientFixture([WORKSPACE_ID]);
    client.status.mockRejectedValueOnce(new Error('offline'));
    const tabs = tabsFixture();
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

    await expect(dispatcher.start()).resolves.toBeUndefined();
    expect(tabs.runLocalMcpAutoAttach).not.toHaveBeenCalled();
    await dispatcher.wake();
    dispatcher.stop();
    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledOnce();
  });

  it.each(['script_failed', 'app_not_found', 'menu_not_found', 'attach_not_confirmed'])(
    'backs off repeated %s results per tab, workspace, and URL context',
    async (result) => {
      let now = 0;
      const client = clientFixture([WORKSPACE_ID]);
      const tabs = tabsFixture(context('tab_a'));
      tabs.runLocalMcpAutoAttach.mockResolvedValue(result);
      const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs, { now: () => now });

      await dispatcher.start();
      await dispatcher.wake();
      expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledOnce();

      now = 29_999;
      await dispatcher.wake();
      expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledOnce();

      now = 30_000;
      await dispatcher.wake();
      dispatcher.stop();
      expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledTimes(2);
    },
  );

  it('does not let a failed tab context block a different active tab', async () => {
    let now = 0;
    const client = clientFixture([WORKSPACE_ID]);
    const tabs = tabsFixture(context('tab_a'));
    tabs.runLocalMcpAutoAttach.mockResolvedValue('script_failed');
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs, { now: () => now });

    await dispatcher.start();
    tabs.setContext(context('tab_b'));
    now = 1;
    await dispatcher.wake();
    dispatcher.stop();

    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledTimes(2);
  });

  it('does not attribute a late tab A failure to tab B', async () => {
    const now = 0;
    const client = clientFixture([WORKSPACE_ID]);
    const tabs = tabsFixture(context('tab_a'));
    let releaseA!: () => void;
    const deferredA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    tabs.runLocalMcpAutoAttach
      .mockImplementationOnce(async () => {
        await deferredA;
        return 'script_failed';
      })
      .mockResolvedValue('attached');
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs, { now: () => now });

    const start = dispatcher.start();
    await Promise.resolve();
    tabs.setContext(context('tab_b'));
    releaseA();
    await start;
    await dispatcher.wake();
    dispatcher.stop();

    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a page script across stop and start generations', async () => {
    const client = clientFixture([WORKSPACE_ID]);
    const tabs = tabsFixture(context('tab_a'));
    let releaseScript!: () => void;
    let scriptStarted!: () => void;
    const scriptGate = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    const scriptStartedPromise = new Promise<void>((resolve) => {
      scriptStarted = resolve;
    });
    let firstScript = true;
    tabs.runLocalMcpAutoAttach.mockImplementation(async () => {
      if (firstScript) {
        firstScript = false;
        scriptStarted();
        await scriptGate;
      }
      return 'attached';
    });
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

    const oldStart = dispatcher.start();
    await scriptStartedPromise;
    dispatcher.stop();
    const newStart = dispatcher.start();
    await newStart;
    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledOnce();
    releaseScript();
    await oldStart;
    dispatcher.stop();
  });

  it('ignores a delayed status from a stopped generation after restart', async () => {
    const client = clientFixture([WORKSPACE_ID]);
    let releaseOldStatus!: (status: DaemonStatus) => void;
    let statusStarted!: () => void;
    const oldStatus = new Promise<DaemonStatus>((resolve) => {
      releaseOldStatus = resolve;
    });
    const oldStatusStarted = new Promise<void>((resolve) => {
      statusStarted = resolve;
    });
    client.status
      .mockImplementationOnce(async () => {
        statusStarted();
        return oldStatus;
      })
      .mockResolvedValue(statusFixture([WORKSPACE_ID]));
    const tabs = tabsFixture(context('tab_b'));
    const dispatcher = new LocalMcpAutoAttachDispatcher(client, tabs);

    const oldStart = dispatcher.start();
    await oldStatusStarted;
    dispatcher.stop();
    const newStart = dispatcher.start();
    await newStart;
    releaseOldStatus(statusFixture([WORKSPACE_ID]));
    await oldStart;
    dispatcher.stop();

    expect(tabs.runLocalMcpAutoAttach).toHaveBeenCalledOnce();
  });
});
