import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatGptTabRecord, ChatGptTabState } from '@chatsplice/protocol';

import { ChatGptTabManager } from './chatgpt-tabs.js';

const WORKSPACE = `ws_${'a'.repeat(24)}`;
const OTHER_WORKSPACE = `ws_${'b'.repeat(24)}`;
const PROJECT_HOME = 'https://chatgpt.com/g/g-p-recovery-fixture/project';
const CONVERSATION = 'https://chatgpt.com/g/g-p-recovery-fixture/c/fixture-123';
const INPUT = {
  workspace_id: WORKSPACE,
  workspace_name: 'Recovery fixture',
  binding_text: 'Fixture instructions',
};
const managers: ChatGptTabManager[] = [];

function record(index: number, url = CONVERSATION, workspaceId = WORKSPACE): ChatGptTabRecord {
  return {
    chatgpt_tab_id: `tab_${index.toString(16).padStart(24, '0')}`,
    workspace_id: workspaceId,
    label: 'Fixture',
    url,
    project_url: PROJECT_HOME,
    project_instructions_confirmed: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function viewFixture() {
  let url = 'https://chatgpt.com/';
  let draft = '';
  const settings = vi
    .fn<(source: string) => Promise<{ status: string; reason: string; message: string }>>()
    .mockResolvedValue({
      status: 'completed',
      reason: 'instructions_updated',
      message: 'Saved and reopened',
    });
  const webContents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(async (next: string) => {
      url = next;
      draft = '';
    }),
    getURL: () => url,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    focus: vi.fn(),
    close: vi.fn(),
    executeJavaScript: vi.fn(async (source: string) => {
      if (source.startsWith('window.__chatspliceProjectInstructionsCancelled')) return;
      return settings(source);
    }),
  });
  return {
    webContents,
    settings,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setDraft: (value: string) => {
      draft = value;
    },
    getDraft: () => draft,
    navigate: (next: string) => {
      url = next;
      webContents.emit('did-navigate-in-page', {}, next, true);
    },
  };
}

async function fixture(
  tabs: ChatGptTabRecord[],
  configureView?: (view: ReturnType<typeof viewFixture>, index: number) => void,
) {
  const views: ReturnType<typeof viewFixture>[] = [];
  let saved!: ChatGptTabState;
  const manager = await ChatGptTabManager.create({
    window: {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      focus: vi.fn(),
    } as never,
    initialState: { tabs, active_tab_id: tabs[0]!.chatgpt_tab_id },
    createView: () => {
      const view = viewFixture();
      configureView?.(view, views.length);
      views.push(view);
      return view as never;
    },
    persist: async (state) => {
      saved = structuredClone(state);
    },
  });
  managers.push(manager);
  return { manager, views, saved: () => saved };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
});

describe('Project instructions recovery', () => {
  it.each([false, true])(
    'verifies the retained home and preserves the conversation (existing home: %s)',
    async (existingHome) => {
      const first = record(1);
      const tabs = existingHome ? [first, record(2, PROJECT_HOME)] : [first];
      const { manager, views, saved } = await fixture(tabs);
      views[0]!.setDraft('작성 중인 메시지');

      const result = await manager.automateProjectInstructionsUpdate(INPUT);

      expect(result.automation.reason).toBe('instructions_updated');
      expect(result.tabs.active_tab_id).toBe(first.chatgpt_tab_id);
      expect(views).toHaveLength(2);
      expect(views[0]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(CONVERSATION);
      expect(views[0]!.settings).not.toHaveBeenCalled();
      expect(views[0]!.getDraft()).toBe('작성 중인 메시지');
      expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(PROJECT_HOME);
      expect(views[1]!.settings).toHaveBeenCalledOnce();
      expect(views[1]!.settings.mock.calls[0]![0]).toContain('"initializeEmpty":true');
      expect(saved().tabs.every((tab) => tab.project_instructions_confirmed)).toBe(true);

      const nextChat = await manager.createTab({ workspace_id: WORKSPACE, project_chat: true });
      expect(nextChat.tabs).toHaveLength(3);
      const automatic = await manager.automateProjectInstructionsUpdate({
        ...INPUT,
        automatic: true,
      });
      expect(automatic.automation.reason).toBe('instructions_current');
      expect(views[2]!.settings).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'defers background conversation checks to a manual Project home check (confirmed: %s)',
    async (confirmed) => {
      const first = { ...record(1), project_instructions_confirmed: confirmed };
      const { manager, views } = await fixture([first]);
      views[0]!.setDraft('보존할 draft');

      const result = await manager.automateProjectInstructionsUpdate({ ...INPUT, automatic: true });

      expect(result.automation.reason).toBe('project_home_required');
      expect(result.tabs.active_tab_id).toBe(first.chatgpt_tab_id);
      expect(views).toHaveLength(1);
      expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
      expect(views[0]!.settings).not.toHaveBeenCalled();
      expect(views[0]!.getDraft()).toBe('보존할 draft');
    },
  );

  it('invalidates older confirmations after a failed saved-state check without losing the Project pin', async () => {
    const { manager, views, saved } = await fixture(
      [record(1), record(2, PROJECT_HOME), record(3, CONVERSATION, OTHER_WORKSPACE)],
      (view, index) => {
        if (index === 1)
          view.settings.mockResolvedValue({
            status: 'needs_user',
            reason: 'needs_manual_merge',
            message: 'Identity mismatch',
          });
      },
    );
    views[0]!.setDraft('보존');

    const result = await manager.automateProjectInstructionsUpdate(INPUT);

    expect(result.automation.reason).toBe('needs_manual_merge');
    expect(
      saved()
        .tabs.filter((tab) => tab.workspace_id === WORKSPACE)
        .every((tab) => !tab.project_instructions_confirmed && tab.project_url === PROJECT_HOME),
    ).toBe(true);
    expect(saved().tabs[2]!.project_instructions_confirmed).toBe(true);
    expect(views[0]!.getDraft()).toBe('보존');
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);

    views[1]!.settings.mockResolvedValue({
      status: 'completed',
      reason: 'instructions_updated',
      message: 'Verified retry',
    });
    expect((await manager.automateProjectInstructionsUpdate(INPUT)).automation.status).toBe(
      'completed',
    );
    expect(saved().tabs.every((tab) => tab.project_instructions_confirmed)).toBe(true);
  });

  it('does not restore the previous conversation after the owner selects another tab during verification', async () => {
    const first = record(1);
    const other = record(2, PROJECT_HOME, OTHER_WORKSPACE);
    const { manager, views } = await fixture([first, other]);
    let release!: (value: { status: string; reason: string; message: string }) => void;
    let started!: () => void;
    const settingsStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const settingsResult = new Promise<{ status: string; reason: string; message: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    // The manual action creates the third view; configure it before its load settles.
    const updating = manager.automateProjectInstructionsUpdate(INPUT);
    views[2]!.settings.mockImplementation(async () => {
      started();
      return settingsResult;
    });
    await settingsStarted;
    await manager.activateTab(other.chatgpt_tab_id);
    release({ status: 'completed', reason: 'instructions_updated', message: 'Late result' });

    expect((await updating).automation.reason).toBe('automation_deferred');
    expect(manager.list().active_tab_id).toBe(other.chatgpt_tab_id);
  });

  it('rejects a late result from another Project home', async () => {
    const { manager, views } = await fixture([record(1), record(2, PROJECT_HOME)]);
    views[1]!.settings.mockImplementation(async () => {
      views[1]!.navigate('https://chatgpt.com/g/g-p-other-fixture/project');
      return { status: 'completed', reason: 'instructions_updated', message: 'Late result' };
    });

    expect((await manager.automateProjectInstructionsUpdate(INPUT)).automation.reason).toBe(
      'automation_deferred',
    );
    expect(manager.list().tabs[1]!.project_instructions_confirmed).toBe(false);
  });

  it('does not reuse a home view whose retained Project identity disagrees with its location', async () => {
    const unrelated = {
      ...record(2, PROJECT_HOME),
      project_url: 'https://chatgpt.com/g/g-p-unrelated-fixture/project',
    };
    const { manager, views } = await fixture([record(1), unrelated]);

    const result = await manager.automateProjectInstructionsUpdate(INPUT);

    expect(result.automation.status).toBe('completed');
    expect(views).toHaveLength(3);
    expect(views[1]!.settings).not.toHaveBeenCalled();
    expect(result.tabs.tabs[1]!.project_instructions_confirmed).toBe(false);
    expect(result.tabs.tabs[2]!.project_instructions_confirmed).toBe(true);
  });

  it('reuses an existing home at the tab limit and leaves a full set of conversations untouched otherwise', async () => {
    const conversations = Array.from({ length: 50 }, (_, index) => record(index + 1));
    const full = await fixture(conversations);
    await expect(full.manager.automateProjectInstructionsUpdate(INPUT)).rejects.toThrow(
      'chatgpt_tab_limit_reached',
    );
    expect(full.views).toHaveLength(50);
    expect(full.views[0]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(CONVERSATION);
    expect(full.manager.list().active_tab_id).toBe(conversations[0]!.chatgpt_tab_id);

    const withHome = await fixture([...conversations.slice(0, 49), record(50, PROJECT_HOME)]);
    expect(
      (await withHome.manager.automateProjectInstructionsUpdate(INPUT)).automation.status,
    ).toBe('completed');
    expect(withHome.views).toHaveLength(50);
  });
});
