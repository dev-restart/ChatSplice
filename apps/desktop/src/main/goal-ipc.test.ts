import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, PanelStateSchema } from '@chatsplice/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

type InvokeHandler = (event: IpcMainInvokeEvent, input?: unknown) => unknown;
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, InvokeHandler>() }));
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import { installIpcHandlers } from './ipc.js';
import { WorkbenchEditorSessionManager } from './workbench-editor-session.js';

const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;
const OTHER_WORKSPACE_ID = `ws_${'b'.repeat(24)}`;
const GOAL_ID = 'goal_00000000-0000-4000-8000-000000000000';
const CONSOLE_ID = 14;
let dispose: (() => void) | undefined;

function fixture() {
  handlers.clear();
  const listGoals = vi.fn().mockResolvedValue({ goals: [] });
  const updateGoal = vi.fn().mockResolvedValue({ goal: { goal_id: GOAL_ID } });
  type Arguments = Parameters<typeof installIpcHandlers>;
  dispose = installIpcHandlers(
    { client: { listGoals, updateGoal } } as unknown as Arguments[0],
    {} as Arguments[1],
    async () => null,
    () => new Set([11, 12, 13, CONSOLE_ID]),
    {} as Arguments[4],
    {} as Arguments[5],
    {
      get: () =>
        PanelStateSchema.parse({
          workspace_id: WORKSPACE_ID,
          console_open: true,
          files_open: false,
        }),
      set: vi.fn(),
      syncWorkspace: vi.fn(),
      setEditorActive: vi.fn(),
    },
    {} as Arguments[7],
    () => CONSOLE_ID,
    () => 11,
    () => 12,
    () => 13,
    new WorkbenchEditorSessionManager(),
    vi.fn(),
  );
  return { listGoals, updateGoal };
}

async function invoke(
  channel: string,
  input: unknown,
  senderId = CONSOLE_ID,
  url = 'chatsplice://renderer/?surface=console',
) {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error('Missing handler');
  return handler({ sender: { id: senderId }, senderFrame: { url } } as IpcMainInvokeEvent, input);
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('owner Goal IPC', () => {
  it('allows only the selected console workspace and preserves revision', async () => {
    const { listGoals, updateGoal } = fixture();
    const read = { workspace_id: WORKSPACE_ID };
    const pause = {
      workspace_id: WORKSPACE_ID,
      goal_id: GOAL_ID,
      action: 'pause',
      expected_revision: 3,
    };
    await expect(invoke(IPC_CHANNELS.listGoals, read)).resolves.toEqual({ goals: [] });
    await invoke(IPC_CHANNELS.updateGoal, pause);
    expect(listGoals).toHaveBeenCalledWith(read);
    expect(updateGoal).toHaveBeenCalledWith(pause);
  });

  it('preserves pagination and revision-guarded deletion on the owner console channel', async () => {
    const { listGoals, updateGoal } = fixture();
    const read = { workspace_id: WORKSPACE_ID, offset: 21, limit: 7 };
    const deletion = {
      workspace_id: WORKSPACE_ID,
      goal_id: GOAL_ID,
      action: 'delete',
      expected_revision: 8,
    };
    await invoke(IPC_CHANNELS.listGoals, read);
    await invoke(IPC_CHANNELS.updateGoal, deletion);
    expect(listGoals).toHaveBeenCalledWith(read);
    expect(updateGoal).toHaveBeenCalledWith(deletion);
  });

  it('rejects remote views, other local surfaces, changed projects and supplied bindings before daemon access', async () => {
    const { listGoals, updateGoal } = fixture();
    const read = { workspace_id: WORKSPACE_ID };
    const pause = {
      workspace_id: WORKSPACE_ID,
      goal_id: GOAL_ID,
      action: 'pause',
      expected_revision: 1,
    };
    for (const [senderId, url] of [
      [99, 'https://chatgpt.com/'],
      [99, 'chatsplice://renderer/'],
      [CONSOLE_ID, 'https://chatgpt.com/'],
      [11, 'chatsplice://renderer/?surface=editor'],
      [13, 'chatsplice://renderer/'],
    ] as const) {
      await expect(invoke(IPC_CHANNELS.listGoals, read, senderId, url)).rejects.toThrow();
      await expect(invoke(IPC_CHANNELS.updateGoal, pause, senderId, url)).rejects.toThrow();
    }
    await expect(
      invoke(IPC_CHANNELS.listGoals, { workspace_id: OTHER_WORKSPACE_ID }),
    ).rejects.toThrow('selected project changed');
    await expect(
      invoke(IPC_CHANNELS.updateGoal, { ...pause, workspace_id: OTHER_WORKSPACE_ID }),
    ).rejects.toThrow('selected project changed');
    await expect(
      invoke(IPC_CHANNELS.listGoals, { ...read, workspace_binding: `wb_${'a'.repeat(64)}` }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.updateGoal, { ...pause, workspace_binding: `wb_${'a'.repeat(64)}` }),
    ).rejects.toThrow();
    expect(listGoals).not.toHaveBeenCalled();
    expect(updateGoal).not.toHaveBeenCalled();
  });
});
