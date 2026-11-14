import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatGptTabRecordSchema, CreateChatGptTabInputSchema } from '@chatsplice/protocol';
import type { ChatGptTabRecord, ChatGptTabState } from '@chatsplice/protocol';

import { ChatGptTabManager } from './chatgpt-tabs.js';

const FIRST = `ws_${'a'.repeat(24)}`;
const SECOND = `ws_${'b'.repeat(24)}`;
const FIRST_URL = 'https://chatgpt.com/g/g-p-first-fixture/project';
const SECOND_URL = 'https://chatgpt.com/g/g-p-second-fixture/project';
const FIRST_TAB = `tab_${'a'.repeat(24)}`;
const OTHER_TAB = `tab_${'b'.repeat(24)}`;
const SECOND_TAB = `tab_${'c'.repeat(24)}`;
const HOME = 'https://chatgpt.com/';
const managers: ChatGptTabManager[] = [];

function record(
  id = FIRST_TAB,
  workspaceId: string | null = FIRST,
  url = FIRST_URL,
): ChatGptTabRecord {
  return {
    chatgpt_tab_id: id,
    workspace_id: workspaceId,
    project_instructions_confirmed: workspaceId !== null,
    label: 'Fixture',
    url,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function viewFixture() {
  let url = HOME;
  const webContents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn(async (next: string) => {
      url = next;
    }),
    getURL: () => url,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    focus: vi.fn(),
    close: vi.fn(),
    executeJavaScript: vi.fn(),
  });
  return {
    webContents,
    setVisible: vi.fn(),
    setBounds: vi.fn(),
    navigate: (next: string, mainFrame = true) => {
      if (mainFrame) url = next;
      webContents.emit('did-navigate-in-page', {}, next, mainFrame);
    },
  };
}

async function fixture(
  initialState: ChatGptTabState,
  configureView?: (view: ReturnType<typeof viewFixture>, index: number) => void,
) {
  const views: ReturnType<typeof viewFixture>[] = [];
  let saved!: ChatGptTabState;
  const manager = await ChatGptTabManager.create({
    window: {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      focus: vi.fn(),
    } as never,
    initialState,
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
  vi.restoreAllMocks();
});

describe('project chat navigation', () => {
  it('returns to the last selected project chat without reloading its live view', async () => {
    const { manager, views } = await fixture({
      tabs: [record(), record(OTHER_TAB, FIRST), record(SECOND_TAB, SECOND, SECOND_URL)],
      active_tab_id: FIRST_TAB,
    });
    await manager.activateTab(OTHER_TAB);
    await manager.activateTab(SECOND_TAB);
    manager.setCenterSurface('editor');
    await expect(manager.activateWorkspace(FIRST)).resolves.toMatchObject({
      active_tab_id: OTHER_TAB,
    });
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(views[1]!.setVisible).toHaveBeenLastCalledWith(true);
    expect(views[2]!.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('persists activation order despite same-millisecond clicks and background navigation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-02-01T00:00:00.000Z'));
    const { manager, views, saved } = await fixture({
      tabs: [record(), record(OTHER_TAB, FIRST), record(SECOND_TAB, SECOND, SECOND_URL)],
      active_tab_id: FIRST_TAB,
    });
    await manager.activateTab(OTHER_TAB);
    await manager.activateTab(SECOND_TAB);
    views[0]!.navigate('https://chatgpt.com/c/background-fixture');
    await manager.close();
    const state = saved();
    expect(state.tabs[0]!.last_activated_at! < state.tabs[1]!.last_activated_at!).toBe(true);
    const restarted = await fixture(state);
    await expect(restarted.manager.activateWorkspace(FIRST)).resolves.toMatchObject({
      active_tab_id: OTHER_TAB,
    });
  });

  it('opens a new chat at the remembered project landing and keeps the old conversation intact', async () => {
    const { manager, views, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate('https://chatgpt.com/c/original-conversation-fixture');
    const result = await manager.createTab({
      workspace_id: FIRST,
      label: 'Fresh Project chat',
      project_chat: true,
    });
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs.find((tab) => tab.active)).toMatchObject({
      workspace_id: FIRST,
      project_instructions_confirmed: true,
    });
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(FIRST_URL);
    expect(views[0]!.webContents.getURL()).toBe(
      'https://chatgpt.com/c/original-conversation-fixture',
    );
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(views[1]!.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(saved().tabs[0]!.project_url).toBe(FIRST_URL);
    expect(JSON.stringify(result)).not.toContain('project_url');
    expect(JSON.stringify(result)).not.toContain('last_activated_at');
    expect(JSON.stringify(result)).not.toContain('https://');
  });

  it('does not use another workspace project as a missing destination', async () => {
    const { manager, views } = await fixture({
      tabs: [
        record(FIRST_TAB, FIRST, 'https://chatgpt.com/c/legacy-fixture'),
        record(SECOND_TAB, SECOND, SECOND_URL),
      ],
      active_tab_id: FIRST_TAB,
    });
    await expect(manager.createTab({ workspace_id: FIRST, project_chat: true })).rejects.toThrow(
      'project_chat_url_unavailable',
    );
    expect(views).toHaveLength(2);
    expect(manager.list().active_tab_id).toBe(FIRST_TAB);
    // Setup placeholders and general chats retain their existing creation path.
    await manager.createTab({ workspace_id: FIRST });
    expect(views[2]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(HOME);
    await manager.createTab({ workspace_id: null });
    expect(views[3]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(HOME);
  });

  it('keeps the verified project pin and clears confirmation on a different project route', async () => {
    const { manager, views, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(SECOND_URL);
    const setup = await manager.automateProjectSetup({
      workspace_id: FIRST,
      workspace_name: 'First',
      binding_text: 'Fixture instructions',
    });
    expect(setup.automation.status).toBe('needs_user');
    expect(views[0]!.webContents.executeJavaScript).not.toHaveBeenCalled();
    await manager.close();
    expect(saved().tabs[0]).toMatchObject({
      project_url: FIRST_URL,
      url: SECOND_URL,
      project_instructions_confirmed: false,
    });
  });

  it('opens a new chat from the stored project key even after confirmation was cleared', async () => {
    const { manager, views, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(SECOND_URL);
    const created = await manager.createTab({ workspace_id: FIRST, project_chat: true });
    expect(created.tabs).toHaveLength(2);
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(FIRST_URL);
    await manager.close();
    expect(saved().project_keys).toEqual({ [FIRST]: 'g-p-first-fixture' });
  });

  it('returns a drifted unconfirmed tab to its stored project address when the workspace is selected', async () => {
    const { manager, views, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(SECOND_URL);
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
    const result = await manager.activateWorkspace(FIRST);
    expect(result).toMatchObject({ active_tab_id: FIRST_TAB });
    expect(result?.tabs[0]).toMatchObject({
      workspace_id: FIRST,
      project_instructions_confirmed: false,
    });
    expect(views[0]!.webContents.loadURL).toHaveBeenLastCalledWith(FIRST_URL);
    expect(views[0]!.webContents.getURL()).toBe(FIRST_URL);
    expect(views[0]!.setVisible).toHaveBeenLastCalledWith(true);
    expect(JSON.stringify(result)).not.toContain('https://');
    await manager.close();
    // Navigation alone never re-confirms the project or touches ChatGPT's page.
    expect(saved().tabs[0]).toMatchObject({
      project_url: FIRST_URL,
      url: FIRST_URL,
      project_instructions_confirmed: false,
    });
    expect(views[0]!.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('does not invent a return address for a workspace without its own project pin', async () => {
    const { manager, views } = await fixture({
      tabs: [
        {
          ...record(FIRST_TAB, FIRST, 'https://chatgpt.com/c/legacy-fixture'),
          project_instructions_confirmed: false,
        },
        record(SECOND_TAB, SECOND, SECOND_URL),
      ],
      active_tab_id: SECOND_TAB,
    });
    await expect(manager.activateWorkspace(FIRST)).resolves.toMatchObject({
      active_tab_id: FIRST_TAB,
    });
    expect(views[0]!.webContents.loadURL).not.toHaveBeenCalledWith(SECOND_URL);
    expect(views[0]!.webContents.loadURL).not.toHaveBeenCalledWith(FIRST_URL);
  });

  it('returns a project tab to its last project conversation after it wandered elsewhere', async () => {
    const conversation = 'https://chatgpt.com/g/g-p-first-fixture/c/abc-123';
    const { manager, views, saved } = await fixture({
      tabs: [record(), record(SECOND_TAB, SECOND, SECOND_URL)],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(`${conversation}?model=fixture#anchor`);
    views[0]!.navigate('https://chatgpt.com/c/general-fixture');
    await manager.activateTab(SECOND_TAB);
    const result = await manager.activateWorkspace(FIRST);
    expect(result).toMatchObject({ active_tab_id: FIRST_TAB });
    expect(views[0]!.webContents.loadURL).toHaveBeenLastCalledWith(conversation);
    expect(views[0]!.setVisible).toHaveBeenLastCalledWith(true);
    expect(JSON.stringify(result)).not.toContain('project_last_url');
    expect(JSON.stringify(result)).not.toContain('https://');
    await manager.close();
    expect(saved().tabs[0]).toMatchObject({
      project_url: FIRST_URL,
      project_last_url: conversation,
      url: conversation,
    });
  });

  it('keeps the remembered project conversation across a restart', async () => {
    const conversation = 'https://chatgpt.com/g/g-p-first-fixture/c/abc-123';
    const first = await fixture({ tabs: [record()], active_tab_id: FIRST_TAB });
    first.views[0]!.navigate(conversation);
    first.views[0]!.navigate('https://chatgpt.com/');
    await first.manager.close();
    const restarted = await fixture(first.saved());
    await expect(restarted.manager.activateWorkspace(FIRST)).resolves.toMatchObject({
      active_tab_id: FIRST_TAB,
    });
    expect(restarted.views[0]!.webContents.loadURL).toHaveBeenLastCalledWith(conversation);
  });

  it('does not reload a project tab that is still inside its Project', async () => {
    const conversation = 'https://chatgpt.com/g/g-p-first-fixture/c/abc-123';
    const { manager, views } = await fixture({ tabs: [record()], active_tab_id: FIRST_TAB });
    views[0]!.navigate(conversation);
    const calls = views[0]!.webContents.loadURL.mock.calls.length;
    await manager.activateWorkspace(FIRST);
    expect(views[0]!.webContents.loadURL.mock.calls.length).toBe(calls);
  });

  it('never restores to a location outside the pinned Project', async () => {
    const { manager, views, saved } = await fixture({ tabs: [record()], active_tab_id: FIRST_TAB });
    views[0]!.navigate('https://chatgpt.com/g/g-p-second-fixture/c/other-9');
    views[0]!.navigate('https://chatgpt.com/c/general-fixture');
    await manager.close();
    expect(saved().tabs[0]!.project_last_url).toBe(FIRST_URL);
  });

  describe('a project confirmed before its home address was stored', () => {
    const KEY = 'g-p-legacy-fixture-demo-project';
    const HOME_URL = `https://chatgpt.com/g/${KEY}/project`;
    const input = {
      workspace_id: FIRST,
      workspace_name: 'First',
      binding_text: 'Fixture instructions',
    };
    const legacy = () => ({
      tabs: [record(FIRST_TAB, FIRST, `https://chatgpt.com/g/${KEY}/c/abc-123`)],
      active_tab_id: FIRST_TAB,
    });
    const scriptResult = (views: ReturnType<typeof viewFixture>[], value: unknown) =>
      views[0]!.webContents.executeJavaScript
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(value);

    it('derives the home from its conversation and stores it only after the identity check', async () => {
      const { manager, views, saved } = await fixture(legacy());
      await expect(manager.createTab({ workspace_id: FIRST, project_chat: true })).rejects.toThrow(
        'project_chat_url_unavailable',
      );
      scriptResult(views, {
        status: 'completed',
        reason: 'instructions_current',
        message: 'ok',
      });
      const verified = await manager.automateProjectInstructionsUpdate(input);
      expect(verified.automation.status).toBe('completed');
      expect(views[0]!.webContents.loadURL).toHaveBeenLastCalledWith(HOME_URL);
      const created = await manager.createTab({ workspace_id: FIRST, project_chat: true });
      expect(created.tabs).toHaveLength(2);
      expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(HOME_URL);
      await manager.close();
      expect(saved().tabs[0]).toMatchObject({
        project_url: HOME_URL,
        project_instructions_confirmed: true,
      });
    });

    it('keeps no address when the instructions belong to another project', async () => {
      const { manager, views, saved } = await fixture(legacy());
      scriptResult(views, {
        status: 'needs_user',
        reason: 'needs_manual_merge',
        message: 'other project',
      });
      const result = await manager.automateProjectInstructionsUpdate(input);
      expect(result.automation.status).toBe('needs_user');
      await expect(manager.createTab({ workspace_id: FIRST, project_chat: true })).rejects.toThrow(
        'project_chat_url_unavailable',
      );
      await manager.close();
      expect(saved().tabs[0]!.project_url).toBeUndefined();
    });

    it('does not treat a custom GPT address as a Project', async () => {
      const { manager, views } = await fixture({
        tabs: [record(FIRST_TAB, FIRST, 'https://chatgpt.com/g/g-custom-fixture/c/abc-123')],
        active_tab_id: FIRST_TAB,
      });
      await manager.automateProjectInstructionsUpdate(input);
      // The address is never promoted to a Project home candidate.
      expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
      await expect(manager.createTab({ workspace_id: FIRST, project_chat: true })).rejects.toThrow(
        'project_chat_url_unavailable',
      );
    });
  });

  describe('the project key registry', () => {
    it('keeps the key after its tab is closed and opens the project home again', async () => {
      const { manager, views, saved } = await fixture({
        tabs: [record(), record(SECOND_TAB, SECOND, SECOND_URL)],
        active_tab_id: SECOND_TAB,
      });
      await manager.closeTab(FIRST_TAB);
      await expect(manager.activateWorkspace(FIRST)).resolves.toBeUndefined();
      const created = await manager.createTab({ workspace_id: FIRST, project_chat: true });
      expect(created.tabs.find((tab) => tab.active)).toMatchObject({
        workspace_id: FIRST,
        project_instructions_confirmed: true,
      });
      expect(views[2]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(FIRST_URL);
      await manager.close();
      expect(saved().project_keys).toEqual({
        [FIRST]: 'g-p-first-fixture',
        [SECOND]: 'g-p-second-fixture',
      });
    });

    it('restores keys after a restart and forgets them when the workspace is detached', async () => {
      const first = await fixture({ tabs: [record()], active_tab_id: FIRST_TAB });
      await first.manager.closeTab(FIRST_TAB);
      await first.manager.close();
      const restarted = await fixture(first.saved());
      const created = await restarted.manager.createTab({
        workspace_id: FIRST,
        project_chat: true,
      });
      expect(created.tabs.some((tab) => tab.workspace_id === FIRST)).toBe(true);
      await restarted.manager.detachWorkspace(FIRST);
      await restarted.manager.close();
      expect(restarted.saved().project_keys).toBeUndefined();
    });

    it('never stores a key for a general chat or a non-project address', async () => {
      const { manager, saved } = await fixture({
        tabs: [
          record(FIRST_TAB, null, 'https://chatgpt.com/g/g-p-general-fixture/project'),
          record(OTHER_TAB, FIRST, 'https://chatgpt.com/g/g-custom-fixture/c/abc-123'),
        ],
        active_tab_id: FIRST_TAB,
      });
      await manager.close();
      expect(saved().project_keys).toBeUndefined();
    });
  });

  it('restores another owned project view when the recent one navigated to another Project', async () => {
    const { manager, views } = await fixture({
      tabs: [record(), record(OTHER_TAB, FIRST)],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(SECOND_URL);
    await expect(manager.activateWorkspace(FIRST)).resolves.toMatchObject({
      active_tab_id: OTHER_TAB,
    });
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(FIRST_URL);
    expect(views[0]!.webContents.getURL()).toBe(SECOND_URL);
  });

  it('ignores subframe navigation when recording project and conversation destinations', async () => {
    const { manager, views, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    views[0]!.navigate(SECOND_URL, false);
    await manager.createTab({ workspace_id: FIRST, project_chat: true });
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(FIRST_URL);
    expect(saved().tabs[0]).toMatchObject({
      url: FIRST_URL,
      project_url: FIRST_URL,
      project_instructions_confirmed: true,
    });
  });

  it('requires explicit association when one workspace has conflicting verified projects', async () => {
    const { manager, views } = await fixture({
      tabs: [record(), record(OTHER_TAB, FIRST, SECOND_URL)],
      active_tab_id: FIRST_TAB,
    });
    await expect(manager.createTab({ workspace_id: FIRST, project_chat: true })).rejects.toThrow(
      'project_chat_url_ambiguous',
    );
    expect(views).toHaveLength(2);
  });

  it('does not restore another project pin after reassigning or detaching a tab', async () => {
    const { manager, saved } = await fixture({
      tabs: [record()],
      active_tab_id: FIRST_TAB,
    });
    await manager.updateTab({ chatgpt_tab_id: FIRST_TAB, workspace_id: SECOND });
    expect(saved().tabs[0]!.project_url).toBeUndefined();
    await expect(manager.createTab({ workspace_id: SECOND, project_chat: true })).rejects.toThrow(
      'project_chat_url_unavailable',
    );
    await manager.detachWorkspace(SECOND);
    expect(saved().tabs[0]!.project_url).toBeUndefined();
  });

  it('keeps a later selection focused when the new project view finishes loading late', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, views } = await fixture(
      {
        tabs: [record(), record(SECOND_TAB, SECOND, SECOND_URL)],
        active_tab_id: FIRST_TAB,
      },
      (view, index) => {
        if (index === 2) view.webContents.loadURL.mockImplementationOnce(async () => gate);
      },
    );
    try {
      await manager.createTab({ workspace_id: FIRST, project_chat: true });
      await manager.activateTab(SECOND_TAB);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.list().active_tab_id).toBe(SECOND_TAB);
      expect(views[2]!.webContents.focus).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('rejects project chat intent without a workspace and rejects caller-supplied destinations', () => {
    expect(
      CreateChatGptTabInputSchema.safeParse({ workspace_id: null, project_chat: true }).success,
    ).toBe(false);
    expect(
      CreateChatGptTabInputSchema.safeParse({
        workspace_id: FIRST,
        project_chat: true,
        url: SECOND_URL,
      }).success,
    ).toBe(false);
  });

  it.each([
    'http://chatgpt.com/g/project-fixture/project',
    'https://other.example/g/project-fixture/project',
    'https://user:pass@chatgpt.com/g/project-fixture/project',
    'https://chatgpt.com/g/project-fixture/project?destination=other',
    'https://chatgpt.com/g/project-fixture/project#other',
    'https://chatgpt.com/c/conversation-fixture',
  ])('rejects invalid stored project destinations: %s', (projectUrl) => {
    expect(ChatGptTabRecordSchema.safeParse({ ...record(), project_url: projectUrl }).success).toBe(
      false,
    );
  });
});
