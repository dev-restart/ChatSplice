import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { ChatGptTabManager } from './chatgpt-tabs.js';
import {
  CHATGPT_NO_DRAG_CSS,
  installChatGptPointerPolicy,
  isChatGptPointerPolicyUrl,
} from './remote-pointer-policy.js';

const HOME = 'https://chatgpt.com/';
const PROJECTS = 'https://chatgpt.com/projects';
const WORKSPACE = 'ws_0123456789abcdef01234567';

function pointerTarget(url = HOME) {
  const listeners = new Map<string, () => void>();
  const target = {
    on: (name: string, handler: () => void) => listeners.set(name, handler),
    getURL: vi.fn(() => url),
    isDestroyed: vi.fn(() => false),
    insertCSS: vi.fn(async () => 'fixture-css-key'),
  };
  installChatGptPointerPolicy(target as never);
  return { target, ready: () => listeners.get('dom-ready')?.() };
}

describe('remote web pointer policy', () => {
  it.each([HOME, PROJECTS, 'https://chatgpt.com/c/fixture'])('accepts %s', (url) => {
    expect(isChatGptPointerPolicyUrl(url)).toBe(true);
  });

  it.each([
    'https://auth.openai.com/authorize',
    'https://accounts.google.com/',
    'https://chatgpt.com.evil.example/',
    'https://chatgpt.com:444/',
    'https://user:pass@chatgpt.com/',
    'chatsplice://renderer/',
    'http://chatgpt.com/',
    'file:///fixture',
    'invalid',
  ])('does not modify other origins: %s', (url) => {
    const { target, ready } = pointerTarget(url);
    ready();
    expect(isChatGptPointerPolicyUrl(url)).toBe(false);
    expect(target.insertCSS).not.toHaveBeenCalled();
  });

  it('applies the user-origin CSS on each new document without changing pointer-events', () => {
    const { target, ready } = pointerTarget();
    expect(target.insertCSS).not.toHaveBeenCalled();
    ready();
    ready();
    expect(target.insertCSS).toHaveBeenCalledTimes(2);
    expect(target.insertCSS).toHaveBeenLastCalledWith(CHATGPT_NO_DRAG_CSS, { cssOrigin: 'user' });
    expect(CHATGPT_NO_DRAG_CSS).toContain('app-region: no-drag !important');
    expect(CHATGPT_NO_DRAG_CSS).not.toMatch(/pointer-events|display:|visibility:|position:/);
  });

  it('does not apply after navigation to authentication or destruction', () => {
    const { target, ready } = pointerTarget();
    target.getURL.mockReturnValue('https://auth.openai.com/authorize');
    ready();
    target.getURL.mockReturnValue(HOME);
    target.isDestroyed.mockReturnValue(true);
    ready();
    expect(target.insertCSS).not.toHaveBeenCalled();
  });

  it('handles a failed insertion without leaking page details', async () => {
    const { target, ready } = pointerTarget();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      target.insertCSS.mockRejectedValueOnce(new Error('private-page-details'));
      ready();
      await Promise.resolve();
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        '[ChatSplice] Remote pointer policy could not be applied.\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('installs only on remote contents, leaving the local draggable titlebar intact', () => {
    const source = readFileSync(new URL('./window.ts', import.meta.url), 'utf8');
    const remoteStart = source.indexOf('function secureRemoteContents(');
    const localStart = source.indexOf('function secureLocalContents(');
    const createStart = source.indexOf('export async function createChatSpliceWindow(');
    expect(source.slice(remoteStart, localStart)).toContain(
      'installChatGptPointerPolicy(contents)',
    );
    expect(source.slice(localStart, createStart)).not.toContain('installChatGptPointerPolicy');
  });
});

function viewStub() {
  let url = HOME;
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents: {
      loadURL: vi.fn(async (next: string) => {
        url = next;
      }),
      getURL: () => url,
      isLoadingMainFrame: () => false,
      isDestroyed: () => false,
      focus: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(),
    },
  };
}

async function tabFixture(
  configureView?: (view: ReturnType<typeof viewStub>, index: number) => void,
) {
  const views: ReturnType<typeof viewStub>[] = [];
  const persist = vi.fn(async () => undefined);
  const manager = await ChatGptTabManager.create({
    window: { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as never,
    initialState: undefined,
    createView: () => {
      const view = viewStub();
      configureView?.(view, views.length);
      views.push(view);
      return view as never;
    },
    persist,
  });
  return { manager, views, persist };
}

describe('owner-menu web navigation', () => {
  it.each(['home', 'projects'] as const)('opens %s in a new tab', async (page) => {
    const { manager, views } = await tabFixture();
    try {
      const original = manager.list().active_tab_id;
      await manager.updateTab({
        chatgpt_tab_id: original,
        workspace_id: WORKSPACE,
        project_instructions_confirmed: true,
      });
      const result = await manager.openBrowserPage(page);
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs.find((tab) => tab.active)).toMatchObject({
        workspace_id: null,
        project_instructions_confirmed: false,
      });
      expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
      expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
        page === 'home' ? HOME : PROJECTS,
      );
      expect(views[1]!.webContents.executeJavaScript).not.toHaveBeenCalled();
      expect(manager.getLocalMcpAutoAttachContext()).toBeUndefined();
      expect(manager.lastTabForWorkspace(WORKSPACE)).toBe(original);
      await expect(manager.activateWorkspace(WORKSPACE)).resolves.toMatchObject({
        active_tab_id: original,
      });
    } finally {
      await manager.close();
    }
  });

  it('rejects arbitrary URLs without opening a tab', async () => {
    const { manager, views } = await tabFixture();
    try {
      await expect(manager.openBrowserPage('https://example.com/' as never)).rejects.toThrow(
        'Unsupported ChatGPT browser destination.',
      );
      expect(views).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  it('reports load failures without closing the original tab', async () => {
    const { manager, views } = await tabFixture((view, index) => {
      if (index === 1) view.webContents.loadURL.mockRejectedValue(new Error('offline'));
    });
    try {
      const original = manager.list().active_tab_id;
      await expect(manager.openBrowserPage('projects')).rejects.toThrow(
        'ChatGPT page could not be loaded.',
      );
      expect(manager.list().tabs).toHaveLength(2);
      expect(views[0]!.webContents.close).not.toHaveBeenCalled();
      expect(views[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
      await expect(manager.activateTab(original)).resolves.toMatchObject({
        active_tab_id: original,
      });
    } finally {
      await manager.close();
    }
  });

  it('does not steal focus when a slow page finishes after another selection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, views } = await tabFixture((view, index) => {
      if (index === 1) view.webContents.loadURL.mockImplementationOnce(async () => gate);
    });
    const original = manager.list().active_tab_id;
    try {
      const opening = manager.openBrowserPage('projects');
      await manager.activateTab(original);
      release();
      await opening;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.list().active_tab_id).toBe(original);
      expect(views[1]!.webContents.focus).not.toHaveBeenCalled();
    } finally {
      release();
      await manager.close();
    }
  });
});
