import { describe, expect, it } from 'vitest';

import { ChatGptTabManager } from './chatgpt-tabs.js';

const CHATGPT_HOME = 'https://chatgpt.com/';
const WORKSPACE_ID = 'ws_0123456789abcdef01234567';

function createViewStub() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const webContents = {
    loadURL: async () => undefined,
    focus: () => undefined,
    close: () => undefined,
    isDestroyed: () => false,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(callback);
      listeners.set(event, current);
    },
  };

  return {
    setBounds: () => undefined,
    setVisible: () => undefined,
    webContents,
  };
}

function createAutoAttachViewStub(executeJavaScript: () => Promise<unknown>) {
  let currentUrl = CHATGPT_HOME;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const callback of listeners.get(event) ?? []) callback(...args);
  };
  const webContents = {
    loadURL: async (url: string) => {
      currentUrl = url;
    },
    focus: () => undefined,
    close: () => undefined,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => currentUrl,
    executeJavaScript,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    },
    removeListener: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((listener) => listener !== callback),
      );
    },
  };

  return {
    setBounds: () => undefined,
    setVisible: () => undefined,
    webContents,
    emit,
    navigate: (url: string) => {
      currentUrl = url;
      emit('did-navigate', {}, url);
    },
  };
}

function createDeferredLoadViewStub() {
  let resolveLoad!: () => void;
  let loadStarted!: () => void;
  let currentUrl = CHATGPT_HOME;
  let focusCount = 0;
  const loadStartedPromise = new Promise<void>((resolve) => {
    loadStarted = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const webContents = {
    loadURL: async (url: string) => {
      currentUrl = url;
      loadStarted();
      await loadGate;
    },
    focus: () => {
      focusCount += 1;
    },
    close: () => undefined,
    isDestroyed: () => false,
    isLoadingMainFrame: () => true,
    getURL: () => currentUrl,
    on: () => undefined,
  };

  return {
    setBounds: () => undefined,
    setVisible: () => undefined,
    webContents,
    loadStarted: loadStartedPromise,
    releaseLoad: resolveLoad,
    focusCount: () => focusCount,
  };
}

function createWindowStub() {
  const addedViews: Array<{ view: unknown; index: number | undefined }> = [];
  return {
    contentView: {
      addChildView: (view: unknown, index?: number) => {
        addedViews.push({ view, index });
      },
      removeChildView: () => undefined,
    },
    addedViews,
  };
}

describe('ChatGptTabManager', () => {
  it.each([
    'submitted',
    'document-replaced',
    'delayed-navigation',
    'trusted-input',
    'different-project',
    'premature-complete',
  ])('handles creation navigation without resubmitting (%s)', async (outcome) => {
    const windowStub = { ...createWindowStub(), focus: () => undefined };
    let submits = 0;
    let instructionWrites = 0;
    const view = createAutoAttachViewStub(async () => undefined);
    Object.assign(view.webContents, {
      executeJavaScript: async (source: string) => {
        if (source.startsWith('window.__chatspliceProjectInstructionsCancelled')) return;
        if (source.includes('findNewProjectControl')) return 'clicked';
        if (!source.includes('const payload') && source.includes('findProjectNameInput'))
          return true;
        if (source.includes('payload.createOnly')) {
          submits += 1;
          if (outcome === 'premature-complete') {
            return { status: 'completed', reason: 'created_and_bound', message: 'unverified' };
          }
          if (outcome === 'delayed-navigation') {
            setTimeout(() => view.navigate('https://chatgpt.com/g/created-fixture/project'), 5);
            return 'submitted';
          }
          view.navigate('https://chatgpt.com/g/created-fixture/project');
          if (outcome === 'trusted-input') view.emit('input-event', {}, { type: 'mouseDown' });
          if (outcome === 'different-project')
            view.navigate('https://chatgpt.com/g/other-fixture/project');
          if (outcome === 'document-replaced') throw new Error('Execution context destroyed');
          return 'submitted';
        }
        instructionWrites += 1;
        expect(source).toContain('https://chatgpt.com/g/created-fixture/project');
        expect(source).toContain('"initializeEmpty":true');
        return {
          status: 'completed',
          reason: 'instructions_updated',
          message: 'saved and reopened',
        };
      },
    });
    const manager = await ChatGptTabManager.create({
      window: windowStub as never,
      initialState: undefined,
      createView: () => view as never,
      persist: async () => undefined,
    });
    const result = await manager.automateProjectSetup({
      workspace_id: WORKSPACE_ID,
      workspace_name: 'Fixture',
      binding_text: 'Fixture instructions',
    });
    const interrupted = ['trusted-input', 'different-project', 'premature-complete'].includes(
      outcome,
    );
    expect(submits).toBe(1);
    expect(instructionWrites).toBe(interrupted ? 0 : 1);
    expect(result.automation.status).toBe(interrupted ? 'needs_user' : 'completed');
    expect(
      result.tabs.tabs.find((tab) => tab.workspace_id === WORKSPACE_ID)
        ?.project_instructions_confirmed,
    ).toBe(!interrupted);
    await manager.close();
  });

  it('repairs a retained unconfirmed Project instead of creating a duplicate', async () => {
    const sources: string[] = [];
    const view = createAutoAttachViewStub(async () => undefined);
    Object.assign(view.webContents, {
      executeJavaScript: async (source: string) => {
        sources.push(source);
        if (source.startsWith('window.__chatspliceProjectInstructionsCancelled')) return;
        return {
          status: 'completed',
          reason: 'instructions_updated',
          message: 'saved and reopened',
        };
      },
    });
    const id = 'tab_0123456789abcdef01234567';
    const manager = await ChatGptTabManager.create({
      window: { ...createWindowStub(), focus: () => undefined } as never,
      initialState: {
        active_tab_id: id,
        tabs: [
          {
            chatgpt_tab_id: id,
            workspace_id: WORKSPACE_ID,
            project_instructions_confirmed: false,
            label: 'Fixture',
            url: 'https://chatgpt.com/g/retained-fixture/project',
            created_at: '2026-10-12T00:00:00.000Z',
            updated_at: '2026-10-12T00:00:00.000Z',
          },
        ],
      },
      createView: () => view as never,
      persist: async () => undefined,
    });
    const result = await manager.automateProjectSetup({
      workspace_id: WORKSPACE_ID,
      workspace_name: 'Fixture',
      binding_text: 'Fixture instructions',
    });
    expect(result.automation.status).toBe('completed');
    expect(sources.some((source) => source.includes('findNewProjectControl'))).toBe(false);
    expect(sources.some((source) => source.includes('"initializeEmpty":true'))).toBe(true);
    expect(result.tabs.tabs).toHaveLength(1);
    await manager.close();
  });

  it.each(['opener', 'probe', 'editor', 'tab'])(
    'stops Project creation retries when the %s context changes',
    async (interruption) => {
      let openerCalls = 0;
      let probeCalls = 0;
      let creationCalls = 0;
      const windowStub = { ...createWindowStub(), focus: () => undefined };
      const manager: ChatGptTabManager = await ChatGptTabManager.create({
        window: windowStub as never,
        initialState: undefined,
        createView: () => {
          const view = createAutoAttachViewStub(async () => undefined);
          Object.assign(view.webContents, {
            executeJavaScript: async (source: string) => {
              if (source.startsWith('window.__chatspliceProjectInstructionsCancelled'))
                return undefined;
              if (source.includes('findNewProjectControl')) {
                openerCalls += 1;
                return interruption === 'opener' ? 'context_changed' : 'clicked';
              }
              if (!source.includes('const payload') && source.includes('findProjectNameInput')) {
                probeCalls += 1;
                if (interruption === 'editor') manager.setCenterSurface('editor');
                if (interruption === 'tab') {
                  const other = manager.list().tabs.find((tab) => tab.workspace_id === null);
                  if (other !== undefined) await manager.activateTab(other.chatgpt_tab_id);
                }
                return interruption === 'probe' ? 'context_changed' : false;
              }
              creationCalls += 1;
              return { status: 'completed', reason: 'created_and_bound', message: 'saved' };
            },
          });
          return view as never;
        },
        persist: async () => undefined,
      });
      try {
        const result = await manager.automateProjectSetup({
          workspace_id: WORKSPACE_ID,
          workspace_name: 'Fixture',
          binding_text: 'fixture rules',
        });
        expect(result.automation.reason).toBe('automation_deferred');
        expect(openerCalls).toBe(1);
        expect(probeCalls).toBe(interruption === 'opener' ? 0 : 1);
        expect(creationCalls).toBe(0);
      } finally {
        await manager.close();
      }
    },
  );

  it('inserts remote ChatGPT views below the local native view stack', async () => {
    const windowStub = createWindowStub();
    const manager = await ChatGptTabManager.create({
      window: windowStub as never,
      initialState: undefined,
      createView: () => createViewStub() as never,
      persist: async () => undefined,
    });

    expect(windowStub.addedViews).toHaveLength(1);
    expect(windowStub.addedViews[0]?.index).toBe(0);
    await manager.close();
  });

  it('uses an English fallback label for synthesized general chats', async () => {
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: undefined,
      createView: () => createViewStub() as never,
      persist: async () => undefined,
    });

    expect(manager.list()).toMatchObject({
      tabs: [{ workspace_id: null, label: 'General ChatGPT chat' }],
    });

    await manager.close();
  });

  it('clears a removed workspace back to the neutral general-chat label', async () => {
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: 'tab_aaaaaaaaaaaaaaaaaaaaaaaa',
        tabs: [
          {
            chatgpt_tab_id: 'tab_aaaaaaaaaaaaaaaaaaaaaaaa',
            workspace_id: WORKSPACE_ID,
            project_instructions_confirmed: true,
            label: 'demo · ChatGPT Project',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
          },
        ],
      },
      createView: () => createViewStub() as never,
      persist: async () => undefined,
    });

    await expect(manager.detachWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      tabs: [
        {
          workspace_id: null,
          project_instructions_confirmed: false,
          label: 'General ChatGPT chat',
        },
      ],
    });

    await manager.close();
  });

  it('does not report a late attach result after the active tab context changes', async () => {
    const firstTabId = 'tab_aaaaaaaaaaaaaaaaaaaaaaaa';
    const secondTabId = 'tab_bbbbbbbbbbbbbbbbbbbbbbbb';
    const secondWorkspaceId = 'ws_abcdef0123456789abcdef01';
    let releaseScript!: () => void;
    let scriptStarted!: () => void;
    const scriptGate = new Promise<void>((resolve) => {
      releaseScript = resolve;
    });
    const scriptStartedPromise = new Promise<void>((resolve) => {
      scriptStarted = resolve;
    });
    const views = [
      createAutoAttachViewStub(async () => {
        scriptStarted();
        await scriptGate;
        return 'attached';
      }),
      createAutoAttachViewStub(async () => 'attached'),
    ];
    let viewIndex = 0;
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: firstTabId,
        tabs: [
          {
            chatgpt_tab_id: firstTabId,
            workspace_id: WORKSPACE_ID,
            project_instructions_confirmed: false,
            label: 'first',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
          },
          {
            chatgpt_tab_id: secondTabId,
            workspace_id: secondWorkspaceId,
            project_instructions_confirmed: false,
            label: 'second',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
          },
        ],
      },
      createView: () => views[viewIndex++]! as never,
      persist: async () => undefined,
    });
    try {
      const execution = manager.runLocalMcpAutoAttach(new Set([WORKSPACE_ID]));
      await scriptStartedPromise;
      await manager.activateTab(secondTabId);
      releaseScript();
      await expect(execution).resolves.toBe('context_changed');
    } finally {
      await manager.close();
    }
  });

  it('keeps the last ChatGPT tab per workspace and reports an unbound workspace explicitly', async () => {
    const firstTabId = 'tab_aaaaaaaaaaaaaaaaaaaaaaaa';
    const secondTabId = 'tab_bbbbbbbbbbbbbbbbbbbbbbbb';
    const thirdTabId = 'tab_cccccccccccccccccccccccc';
    const secondWorkspaceId = 'ws_abcdef0123456789abcdef01';
    const thirdWorkspaceId = 'ws_0123456789abcdef01234567';
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: firstTabId,
        tabs: [
          {
            chatgpt_tab_id: firstTabId,
            workspace_id: secondWorkspaceId,
            project_instructions_confirmed: true,
            label: 'first',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:01.000Z',
          },
          {
            chatgpt_tab_id: secondTabId,
            workspace_id: secondWorkspaceId,
            project_instructions_confirmed: false,
            label: 'second',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:02.000Z',
          },
          {
            chatgpt_tab_id: thirdTabId,
            workspace_id: thirdWorkspaceId,
            project_instructions_confirmed: true,
            label: 'third',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:03.000Z',
          },
        ],
      },
      createView: () => createViewStub() as never,
      persist: async () => undefined,
    });

    try {
      await manager.activateTab(firstTabId);
      await manager.activateTab(secondTabId);
      await manager.activateTab(thirdTabId);
      await expect(manager.activateWorkspace(secondWorkspaceId)).resolves.toMatchObject({
        active_tab_id: secondTabId,
      });
      await expect(
        manager.activateWorkspace('ws_fedcba9876543210fedcba98'),
      ).resolves.toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it('returns workspace activation before a deferred ChatGPT load and avoids stale focus', async () => {
    const firstTabId = 'tab_aaaaaaaaaaaaaaaaaaaaaaaa';
    const secondTabId = 'tab_bbbbbbbbbbbbbbbbbbbbbbbb';
    const secondWorkspaceId = 'ws_abcdef0123456789abcdef01';
    const deferred = createDeferredLoadViewStub();
    const views = [createViewStub(), deferred];
    let viewIndex = 0;
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: firstTabId,
        tabs: [
          {
            chatgpt_tab_id: firstTabId,
            workspace_id: WORKSPACE_ID,
            project_instructions_confirmed: true,
            label: 'first',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:01.000Z',
          },
          {
            chatgpt_tab_id: secondTabId,
            workspace_id: secondWorkspaceId,
            project_instructions_confirmed: true,
            label: 'second',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:02.000Z',
          },
        ],
      },
      createView: () => views[viewIndex++]! as never,
      persist: async () => undefined,
    });
    try {
      const activation = manager.activateWorkspace(secondWorkspaceId);
      await deferred.loadStarted;
      await expect(activation).resolves.toMatchObject({ active_tab_id: secondTabId });
      manager.setCenterSurface('editor');
      deferred.releaseLoad();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(deferred.focusCount()).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it('hides remote tabs and pauses Local MCP auto-attach while the editor owns the center', async () => {
    const workspaceId = 'ws_0123456789abcdef01234567';
    const executeJavaScript = async () => 'attached';
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: 'tab_aaaaaaaaaaaaaaaaaaaaaaaa',
        tabs: [
          {
            chatgpt_tab_id: 'tab_aaaaaaaaaaaaaaaaaaaaaaaa',
            workspace_id: workspaceId,
            project_instructions_confirmed: true,
            label: 'project',
            url: CHATGPT_HOME,
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
          },
        ],
      },
      createView: () => createAutoAttachViewStub(executeJavaScript) as never,
      persist: async () => undefined,
    });

    try {
      expect(manager.getLocalMcpAutoAttachContext()).toMatchObject({ workspace_id: workspaceId });
      manager.setCenterSurface('editor');
      expect(manager.getLocalMcpAutoAttachContext()).toBeUndefined();
      await expect(manager.runLocalMcpAutoAttach(new Set([workspaceId]))).resolves.toBe('skipped');
      manager.setCenterSurface('chatgpt');
      expect(manager.getLocalMcpAutoAttachContext()).toMatchObject({ workspace_id: workspaceId });
      await expect(manager.runLocalMcpAutoAttach(new Set([workspaceId]))).resolves.toBe('attached');
    } finally {
      await manager.close();
    }
  });
  it('syncs changed instruction templates without reload and defers while an editor is active', async () => {
    const tabId = 'tab_aaaaaaaaaaaaaaaaaaaaaaaa';
    let loads = 0;
    let scripts = 0;
    const view = createAutoAttachViewStub(async () => {
      scripts += 1;
      return { status: 'completed', reason: 'instructions_updated', message: 'saved and reopened' };
    });
    const executeSettings = view.webContents.executeJavaScript;
    Object.assign(view.webContents, {
      executeJavaScript: async (source: string) =>
        source.startsWith('window.__chatspliceProjectInstructionsCancelled')
          ? undefined
          : executeSettings(),
    });
    const originalLoad = view.webContents.loadURL;
    view.webContents.loadURL = async (url) => {
      loads += 1;
      await originalLoad(url);
    };
    const manager = await ChatGptTabManager.create({
      window: createWindowStub() as never,
      initialState: {
        active_tab_id: tabId,
        tabs: [
          {
            chatgpt_tab_id: tabId,
            workspace_id: WORKSPACE_ID,
            project_instructions_confirmed: true,
            label: 'Project',
            url: 'https://chatgpt.com/g/project-fixture/project',
            created_at: '2026-09-30T00:00:00.000Z',
            updated_at: '2026-09-30T00:00:00.000Z',
          },
        ],
      },
      createView: () => view as never,
      persist: async () => undefined,
    });
    const input = {
      workspace_id: WORKSPACE_ID,
      workspace_name: 'Project',
      binding_text: 'template',
      automatic: true,
    };
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      manager.setCenterSurface('editor');
      expect((await manager.automateProjectInstructionsUpdate(input)).automation.reason).toBe(
        'automation_deferred',
      );
      expect(scripts).toBe(0);
      manager.setCenterSurface('chatgpt');
      await manager.automateProjectInstructionsUpdate(input);
      expect(scripts).toBe(1);
      expect((await manager.automateProjectInstructionsUpdate(input)).automation.reason).toBe(
        'instructions_current',
      );
      expect(scripts).toBe(1);
      await manager.automateProjectInstructionsUpdate({
        ...input,
        binding_text: 'updated template',
      });
      expect(scripts).toBe(2);
      expect(loads).toBe(1);
    } finally {
      await manager.close();
    }
  });
});
