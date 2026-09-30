import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, PanelStateSchema } from '@chatsplice/protocol';
import type { EditorDocument, PanelStatePatch, WorkspaceEditorFile } from '@chatsplice/protocol';

type InvokeHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown;

const { handlers, showMessageBox } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  showMessageBox: vi.fn(),
}));

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox, showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import { installIpcHandlers } from './ipc.js';
import { DaemonControlError } from './daemon-client.js';
import { WorkbenchEditorSessionManager } from './workbench-editor-session.js';
import type { EditorSessionPersistedState } from './workbench-editor-session.js';

const FIRST_WORKSPACE = `ws_${'a'.repeat(24)}`;
const SECOND_WORKSPACE = `ws_${'b'.repeat(24)}`;
const EDITOR_ID = 11;
const FILES_ID = 12;
const SIDEBAR_ID = 13;
const CONSOLE_ID = 14;
const REMOTE_ID = 99;
const CHAT_TAB_ID = `tab_${'c'.repeat(24)}`;

function eventFor(senderId: number, url = 'chatsplice://renderer/?surface=editor') {
  return {
    sender: { id: senderId },
    senderFrame: { url },
  } as IpcMainInvokeEvent;
}

async function invoke<T = unknown>(
  channel: string,
  senderId: number,
  input?: unknown,
  url?: string,
): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return (await handler(eventFor(senderId, url), input)) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let dispose: (() => void) | undefined;

function fixture(initialState?: EditorSessionPersistedState) {
  const session = new WorkbenchEditorSessionManager(
    initialState === undefined ? {} : { initialState },
  );
  session.selectWorkspace(FIRST_WORKSPACE);
  const readFile = vi.fn<(input: unknown) => Promise<WorkspaceEditorFile>>();
  const saveFile = vi.fn<(input: unknown) => Promise<WorkspaceEditorFile>>();
  const client = {
    readWorkspaceEditorFile: readFile,
    saveWorkspaceEditorFile: saveFile,
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [FIRST_WORKSPACE, SECOND_WORKSPACE].map((workspace_id) => ({
        workspace_id,
        kind: 'user',
        display_name: workspace_id,
      })),
    }),
  };
  let panelState = PanelStateSchema.parse({
    workspace_id: FIRST_WORKSPACE,
    console_open: false,
    files_open: true,
  });
  let editorActive = false;
  const panel = {
    get: () => panelState,
    set: (patch: PanelStatePatch) =>
      (panelState = PanelStateSchema.parse({
        ...panelState,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      })),
    syncWorkspace: (workspaceId: string | null) =>
      (panelState = { ...panelState, workspace_id: workspaceId }),
    setEditorActive: vi.fn((active: boolean) => {
      editorActive = active;
    }),
    isEditorActive: () => editorActive,
  };
  const chatgptTabs = {
    setCenterSurface: vi.fn(),
    activateWorkspace: vi.fn(async (workspaceId: string) => ({
      active_tab_id: 'chat-tab',
      tabs: [{ chatgpt_tab_id: 'chat-tab', workspace_id: workspaceId }],
    })),
    activateTab: vi.fn(async () => ({
      active_tab_id: CHAT_TAB_ID,
      tabs: [{ chatgpt_tab_id: CHAT_TAB_ID, workspace_id: null }],
    })),
  };
  type InstallArguments = Parameters<typeof installIpcHandlers>;
  dispose = installIpcHandlers(
    { client } as unknown as InstallArguments[0],
    {} as InstallArguments[1],
    async () => null,
    () => new Set([EDITOR_ID, FILES_ID, SIDEBAR_ID, CONSOLE_ID]),
    chatgptTabs as unknown as InstallArguments[4],
    {} as InstallArguments[5],
    panel,
    {} as InstallArguments[7],
    () => CONSOLE_ID,
    () => EDITOR_ID,
    () => FILES_ID,
    () => SIDEBAR_ID,
    session,
    vi.fn(),
  );

  const open = (workspaceId = FIRST_WORKSPACE, path = 'src/app.ts', content = 'original') => {
    const document = session.openFile({
      workspace_id: workspaceId,
      path,
      content,
      sha256: 'a'.repeat(64),
    }).document;
    return { workspace_id: workspaceId, editor_tab_id: document.editor_tab_id };
  };
  return { session, readFile, saveFile, panel, chatgptTabs, open };
}

beforeEach(() => {
  handlers.clear();
  showMessageBox.mockReset().mockResolvedValue({ response: 2 });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('owner editor IPC', () => {
  it('rejects remote and other local surfaces before reading, editing or saving a body', async () => {
    const { session, readFile, saveFile, open } = fixture();
    const target = open();
    const before = session.getDocument(target);
    const callers = [
      { id: REMOTE_ID, url: 'https://chatgpt.com/' },
      { id: REMOTE_ID, url: 'chatsplice://renderer/?surface=editor' },
      { id: EDITOR_ID, url: 'https://chatgpt.com/' },
      { id: FILES_ID, url: 'chatsplice://renderer/?surface=files' },
      { id: SIDEBAR_ID, url: 'chatsplice://renderer/' },
      { id: CONSOLE_ID, url: 'chatsplice://renderer/?surface=console' },
    ];
    for (const caller of callers) {
      for (const channel of [IPC_CHANNELS.getEditorDocument, IPC_CHANNELS.saveEditorDocument]) {
        await expect(invoke(channel, caller.id, target, caller.url)).rejects.toThrow();
      }
      await expect(
        invoke(
          IPC_CHANNELS.updateEditorDocument,
          caller.id,
          { ...target, content: 'untrusted change', expected_revision: 0 },
          caller.url,
        ),
      ).rejects.toThrow();
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(session.getDocument(target)).toEqual(before);
    await expect(invoke(IPC_CHANNELS.getEditorDocument, EDITOR_ID, target)).resolves.toEqual(
      before,
    );
  });

  it('returns only tab metadata when the files surface opens an editor', async () => {
    const { readFile } = fixture();
    readFile.mockResolvedValue({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
      content: 'private file body',
      sha256: 'a'.repeat(64),
    });
    const state = await invoke(IPC_CHANNELS.openEditorFile, FILES_ID, {
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
    });
    expect(JSON.stringify(state)).not.toContain('private file body');
    expect(state).toMatchObject({ tabs: [{ path: 'src/app.ts', loaded: true }] });
  });

  it('allows summary state from the sidebar while keeping editor bodies owner-only', async () => {
    const { open } = fixture();
    open();
    const state = await invoke(IPC_CHANNELS.getEditorState, SIDEBAR_ID);
    expect(JSON.stringify(state)).not.toContain('original');
    await expect(invoke(IPC_CHANNELS.getEditorState, FILES_ID)).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.getEditorState, REMOTE_ID, undefined, 'https://chatgpt.com/'),
    ).rejects.toThrow();
  });

  it('rejects body reads and new opens outside the selected workspace before daemon access', async () => {
    const { session, readFile, saveFile, open } = fixture();
    const target = open(SECOND_WORKSPACE);
    session.selectWorkspace(FIRST_WORKSPACE);
    await expect(invoke(IPC_CHANNELS.getEditorDocument, EDITOR_ID, target)).rejects.toThrow(
      'selected project changed',
    );
    await expect(
      invoke(IPC_CHANNELS.openEditorFile, FILES_ID, {
        workspace_id: SECOND_WORKSPACE,
        path: 'src/app.ts',
      }),
    ).rejects.toThrow('selected project changed');
    expect(readFile).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('rejects an editor tab ID paired with a different workspace before daemon access', async () => {
    const { session, readFile, saveFile, open } = fixture();
    const target = open(SECOND_WORKSPACE);
    session.selectWorkspace(FIRST_WORKSPACE);
    const wrongTarget = { ...target, workspace_id: FIRST_WORKSPACE };
    const before = session.getDocument(target);
    for (const channel of [IPC_CHANNELS.getEditorDocument, IPC_CHANNELS.saveEditorDocument]) {
      await expect(invoke(channel, EDITOR_ID, wrongTarget)).rejects.toThrow();
    }
    await expect(
      invoke(IPC_CHANNELS.updateEditorDocument, EDITOR_ID, {
        ...wrongTarget,
        content: 'wrong project update',
        expected_revision: 0,
      }),
    ).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(session.getDocument(target)).toEqual(before);
  });

  it('clears the editor center when a ChatGPT tab becomes active', async () => {
    const { session, panel, chatgptTabs, open } = fixture();
    open();
    await invoke(IPC_CHANNELS.activateChatGptTab, SIDEBAR_ID, CHAT_TAB_ID);
    expect(panel.get().workspace_id).toBeNull();
    expect(panel.isEditorActive()).toBe(false);
    expect(chatgptTabs.setCenterSurface).toHaveBeenCalledWith('chatgpt');
    expect(session.getState().workspace_id).toBeNull();
  });

  it('restores the selected workspace editor tab through the project selector', async () => {
    const { session, panel, chatgptTabs, open } = fixture();
    const target = open();
    session.selectWorkspace(SECOND_WORKSPACE);
    await invoke(IPC_CHANNELS.selectWorkspace, SIDEBAR_ID, FIRST_WORKSPACE);
    expect(session.getState().workspace_id).toBe(FIRST_WORKSPACE);
    expect(session.getState().active_editor_tab_id).toBe(target.editor_tab_id);
    expect(panel.get().workspace_id).toBe(FIRST_WORKSPACE);
    expect(panel.isEditorActive()).toBe(true);
    expect(chatgptTabs.setCenterSurface).toHaveBeenLastCalledWith('editor');
  });

  it('does not install a delayed file read after a project selection changed', async () => {
    const { session, readFile, panel } = fixture();
    const read = deferred<WorkspaceEditorFile>();
    readFile.mockReturnValue(read.promise);
    const opening = invoke(IPC_CHANNELS.openEditorFile, FILES_ID, {
      workspace_id: FIRST_WORKSPACE,
      path: 'src/late.ts',
    });
    const rejected = expect(opening).rejects.toMatchObject({ code: 'editor_selection_changed' });
    expect(readFile).toHaveBeenCalledOnce();
    await invoke(IPC_CHANNELS.selectWorkspace, SIDEBAR_ID, SECOND_WORKSPACE);
    read.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/late.ts',
      content: 'late body',
      sha256: 'a'.repeat(64),
    });
    await rejected;
    expect(session.getState(FIRST_WORKSPACE).tabs).toHaveLength(0);
    expect(panel.get().workspace_id).toBe(SECOND_WORKSPACE);
    expect(session.getState().workspace_id).toBe(SECOND_WORKSPACE);
  });

  it('hydrates a delayed tab without stealing the same-workspace active tab', async () => {
    const firstTabId = `edtab_${'1'.repeat(24)}`;
    const secondTabId = `edtab_${'2'.repeat(24)}`;
    const { session, readFile } = fixture({
      active_workspace_id: FIRST_WORKSPACE,
      workspaces: [
        {
          workspace_id: FIRST_WORKSPACE,
          active_editor_tab_id: firstTabId,
          tabs: [
            { editor_tab_id: firstTabId, path: 'src/first.ts', label: 'first.ts' },
            { editor_tab_id: secondTabId, path: 'src/second.ts', label: 'second.ts' },
          ],
        },
      ],
    });
    const firstRead = deferred<WorkspaceEditorFile>();
    const secondRead = deferred<WorkspaceEditorFile>();
    readFile.mockImplementation((input: unknown) =>
      (input as { path: string }).path === 'src/first.ts' ? firstRead.promise : secondRead.promise,
    );
    const firstTarget = {
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: firstTabId,
    };
    const secondTarget = {
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: secondTabId,
    };

    const hydration = invoke<EditorDocument>(
      IPC_CHANNELS.getEditorDocument,
      EDITOR_ID,
      firstTarget,
    );
    expect(readFile).toHaveBeenCalledExactlyOnceWith({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/first.ts',
    });

    const activation = invoke(IPC_CHANNELS.activateEditorTab, EDITOR_ID, secondTarget);
    secondRead.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/second.ts',
      content: 'second body',
      sha256: 'b'.repeat(64),
    });
    await activation;
    expect(session.getState(FIRST_WORKSPACE).active_editor_tab_id).toBe(secondTabId);

    firstRead.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/first.ts',
      content: 'first body',
      sha256: 'a'.repeat(64),
    });
    await expect(hydration).resolves.toMatchObject({
      editor_tab_id: firstTabId,
      content: 'first body',
      dirty: false,
    });
    expect(session.getState(FIRST_WORKSPACE).active_editor_tab_id).toBe(secondTabId);
  });

  it('keeps a newer loaded result when another read hydrates the same tab first', async () => {
    const firstTabId = `edtab_${'3'.repeat(24)}`;
    const { session, readFile } = fixture({
      active_workspace_id: FIRST_WORKSPACE,
      workspaces: [
        {
          workspace_id: FIRST_WORKSPACE,
          active_editor_tab_id: firstTabId,
          tabs: [{ editor_tab_id: firstTabId, path: 'src/first.ts', label: 'first.ts' }],
        },
      ],
    });
    const staleRead = deferred<WorkspaceEditorFile>();
    const freshRead = deferred<WorkspaceEditorFile>();
    let readCount = 0;
    readFile.mockImplementation(() => {
      readCount += 1;
      return readCount === 1 ? staleRead.promise : freshRead.promise;
    });
    const target = { workspace_id: FIRST_WORKSPACE, editor_tab_id: firstTabId };

    const hydration = invoke<EditorDocument>(IPC_CHANNELS.getEditorDocument, EDITOR_ID, target);
    const activation = invoke(IPC_CHANNELS.activateEditorTab, EDITOR_ID, target);
    freshRead.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/first.ts',
      content: 'fresh body',
      sha256: 'b'.repeat(64),
    });
    await activation;

    staleRead.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/first.ts',
      content: 'stale body',
      sha256: 'a'.repeat(64),
    });
    await expect(hydration).resolves.toMatchObject({
      editor_tab_id: firstTabId,
      content: 'fresh body',
      sha256: 'b'.repeat(64),
    });
    expect(session.getDocument(target)).toMatchObject({
      content: 'fresh body',
      sha256: 'b'.repeat(64),
    });
  });

  it.each([IPC_CHANNELS.closeEditorTab, IPC_CHANNELS.reloadEditorDocument])(
    'keeps an unsaved draft when the owner cancels %s',
    async (channel) => {
      const { session, readFile, saveFile, open } = fixture();
      const target = open();
      session.updateDocument({ ...target, content: 'unsaved draft', expected_revision: 0 });
      const before = session.getDocument(target);
      await expect(invoke(channel, EDITOR_ID, target)).rejects.toMatchObject({
        code: 'editor_cancelled',
      });
      expect(showMessageBox).toHaveBeenCalledOnce();
      expect(readFile).not.toHaveBeenCalled();
      expect(saveFile).not.toHaveBeenCalled();
      expect(session.getDocument(target)).toEqual(before);
      expect(session.getState(FIRST_WORKSPACE).tabs).toHaveLength(1);
    },
  );

  it('preserves newer typing while updating the saved baseline after a pending save', async () => {
    const { session, saveFile, panel, open } = fixture();
    const target = open();
    await invoke(IPC_CHANNELS.updateEditorDocument, EDITOR_ID, {
      ...target,
      content: 'first draft',
      expected_revision: 0,
    });
    const write = deferred<WorkspaceEditorFile>();
    saveFile.mockReturnValue(write.promise);
    const saving = invoke<EditorDocument>(IPC_CHANNELS.saveEditorDocument, EDITOR_ID, target);
    await invoke(IPC_CHANNELS.updateEditorDocument, EDITOR_ID, {
      ...target,
      content: 'newer typing',
      expected_revision: 1,
    });
    await invoke(IPC_CHANNELS.selectWorkspace, SIDEBAR_ID, SECOND_WORKSPACE);
    write.resolve({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
      content: 'first draft',
      sha256: 'b'.repeat(64),
    });
    expect(saveFile).toHaveBeenCalledExactlyOnceWith({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
      content: 'first draft',
      expected_sha256: 'a'.repeat(64),
    });
    await expect(saving).resolves.toMatchObject({
      content: 'newer typing',
      sha256: 'b'.repeat(64),
      dirty: true,
      draft_revision: 2,
    });
    expect(session.getDocument(target).content).toBe('newer typing');
    expect(panel.get().workspace_id).toBe(SECOND_WORKSPACE);
    expect(session.getState().workspace_id).toBe(SECOND_WORKSPACE);
  });

  it('preserves a queued owner draft update after selecting another project', async () => {
    const { session, readFile, saveFile, panel, open } = fixture();
    const target = open();
    await invoke(IPC_CHANNELS.selectWorkspace, SIDEBAR_ID, SECOND_WORKSPACE);
    await expect(
      invoke(IPC_CHANNELS.updateEditorDocument, EDITOR_ID, {
        ...target,
        content: 'last input before switching',
        expected_revision: 0,
      }),
    ).resolves.toMatchObject({ content: 'last input before switching', dirty: true });
    expect(session.getDocument(target).content).toBe('last input before switching');
    expect(panel.get().workspace_id).toBe(SECOND_WORKSPACE);
    expect(session.getState().workspace_id).toBe(SECOND_WORKSPACE);
    await expect(invoke(IPC_CHANNELS.getEditorDocument, EDITOR_ID, target)).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('saves a queued exact document target without changing the newly selected project', async () => {
    const { session, saveFile, panel, open } = fixture();
    const target = open();
    session.updateDocument({ ...target, content: 'queued save', expected_revision: 0 });
    await invoke(IPC_CHANNELS.selectWorkspace, SIDEBAR_ID, SECOND_WORKSPACE);
    saveFile.mockResolvedValue({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
      content: 'queued save',
      sha256: 'b'.repeat(64),
    });
    await expect(invoke(IPC_CHANNELS.saveEditorDocument, EDITOR_ID, target)).resolves.toMatchObject(
      {
        workspace_id: FIRST_WORKSPACE,
        content: 'queued save',
        dirty: false,
      },
    );
    expect(saveFile).toHaveBeenCalledExactlyOnceWith({
      workspace_id: FIRST_WORKSPACE,
      path: 'src/app.ts',
      content: 'queued save',
      expected_sha256: 'a'.repeat(64),
    });
    expect(panel.get().workspace_id).toBe(SECOND_WORKSPACE);
    expect(session.getState().workspace_id).toBe(SECOND_WORKSPACE);
  });

  it('keeps the draft and baseline when the daemon refuses an external-change conflict', async () => {
    const { session, saveFile, open } = fixture();
    const target = open();
    session.updateDocument({ ...target, content: 'unsaved draft', expected_revision: 0 });
    const before = session.getDocument(target);
    saveFile.mockRejectedValue(new DaemonControlError('BAD_REQUEST', 'The file changed.', 409));
    await expect(invoke(IPC_CHANNELS.saveEditorDocument, EDITOR_ID, target)).rejects.toMatchObject({
      code: 'editor_conflict',
    });
    expect(session.getDocument(target)).toEqual(before);
    expect(saveFile).toHaveBeenCalledOnce();
  });

  it.each([
    IPC_CHANNELS.openEditorFile,
    IPC_CHANNELS.activateEditorTab,
    IPC_CHANNELS.reloadEditorDocument,
  ])(
    'does not overwrite typing that arrives while %s reads the previous clean file',
    async (channel) => {
      const { session, readFile, saveFile, open } = fixture();
      const target = open();
      const read = deferred<WorkspaceEditorFile>();
      readFile.mockReturnValue(read.promise);
      const opening = invoke(
        channel,
        channel === IPC_CHANNELS.openEditorFile ? FILES_ID : EDITOR_ID,
        channel === IPC_CHANNELS.openEditorFile
          ? { workspace_id: FIRST_WORKSPACE, path: 'src/app.ts' }
          : target,
      ).catch(() => undefined);
      expect(readFile).toHaveBeenCalledOnce();
      await invoke(IPC_CHANNELS.updateEditorDocument, EDITOR_ID, {
        ...target,
        content: 'typed during read',
        expected_revision: 0,
      });
      read.resolve({
        workspace_id: FIRST_WORKSPACE,
        path: 'src/app.ts',
        content: 'original',
        sha256: 'a'.repeat(64),
      });
      await opening;
      expect(session.getDocument(target)).toMatchObject({
        content: 'typed during read',
        dirty: true,
        draft_revision: 1,
      });
      expect(saveFile).not.toHaveBeenCalled();
    },
  );
});
