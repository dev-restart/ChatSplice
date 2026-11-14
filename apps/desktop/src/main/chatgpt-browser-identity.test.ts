import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  chatGptBrowserUserAgent,
  configureChatGptBrowserIdentity,
} from './chatgpt-browser-identity.js';

const macPrefix =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
const chromium = 'Chrome/150.0.7871.250';
const safari = 'Safari/537.36';
const browser = `${macPrefix} ${chromium} ${safari}`;
const wrapper = `${macPrefix} ChatSplice/0.0.2 ${chromium} Electron/43.5.0 ${safari}`;

describe('ChatGPT web-client browser identity', () => {
  it('removes the app and Electron products without changing the actual browser or OS', () => {
    expect(chatGptBrowserUserAgent(wrapper)).toBe(browser);
  });

  it.each(['LocalChat', 'localchat', 'localchat-ade', 'chatgpt-ade', 'chatsplice'])(
    'handles the legacy or development application name %s',
    (name) => {
      const input = `${macPrefix} ${name}/0.1.0-dev.2 ${chromium} Electron/43.5.0 ${safari}`;
      expect(chatGptBrowserUserAgent(input)).toBe(browser);
    },
  );

  it.each(['Windows NT 10.0; Win64; x64', 'X11; Linux x86_64'])(
    'preserves a non-macOS platform: %s',
    (platform) => {
      const prefix = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko)`;
      const expected = `${prefix} ${chromium} ${safari}`;
      const input = `${prefix} ${chromium} ${safari} Electron/43.5.0 ChatSplice/0.0.2`;
      expect(chatGptBrowserUserAgent(input)).toBe(expected);
    },
  );

  it('uses the running Chromium version rather than pinning a Chrome version', () => {
    const nextBrowser = 'Chrome/151.0.8000.17';
    expect(chatGptBrowserUserAgent(wrapper.replace(chromium, nextBrowser))).toBe(
      browser.replace(chromium, nextBrowser),
    );
  });

  it('does not strip similarly named or unrelated products', () => {
    const input = `${browser} NotElectron/1.0 Another-ChatSplice/2.0 Electron/43.5.0`;
    expect(chatGptBrowserUserAgent(input)).toBe(
      `${browser} NotElectron/1.0 Another-ChatSplice/2.0`,
    );
  });

  it.each(['', 'ChatSplice/0.0.2 Electron/43.5.0', 'Mozilla/5.0 Firefox/140.0'])(
    'leaves an unexpected non-Chromium identity unchanged: %s',
    (input) => {
      expect(chatGptBrowserUserAgent(input)).toBe(input);
    },
  );

  it('is idempotent and leaves a normal web identity unchanged', () => {
    expect(chatGptBrowserUserAgent(browser)).toBe(browser);
    expect(chatGptBrowserUserAgent(chatGptBrowserUserAgent(wrapper))).toBe(browser);
  });

  it('sets the identity once on a Session or WebContents without other capabilities', () => {
    let current = wrapper;
    const target = {
      getUserAgent: () => current,
      setUserAgent: vi.fn((value: string) => {
        current = value;
      }),
    };
    configureChatGptBrowserIdentity(target);
    configureChatGptBrowserIdentity(target);
    expect(current).toBe(browser);
    expect(target.setUserAgent).toHaveBeenCalledExactlyOnceWith(browser);
  });

  it('does not reset an already configured target', () => {
    const target = { getUserAgent: () => browser, setUserAgent: vi.fn() };
    configureChatGptBrowserIdentity(target);
    expect(target.setUserAgent).not.toHaveBeenCalled();
  });
});

// These guards verify the native wiring, not the account's remotely served UI.
describe('ChatGPT browser identity wiring', () => {
  const windowSource = readFileSync(new URL('./window.ts', import.meta.url), 'utf8');

  it('configures the persistent remote session before creating the tab manager', () => {
    const sessionStart = windowSource.indexOf('const remoteSession = session.fromPartition(');
    const configured = windowSource.indexOf('configureChatGptBrowserIdentity(remoteSession);');
    const created = windowSource.indexOf('await ChatGptTabManager.create(');
    expect(sessionStart).toBeGreaterThanOrEqual(0);
    expect(configured).toBeGreaterThan(sessionStart);
    expect(created).toBeGreaterThan(configured);
    expect(windowSource).toContain("const CHATGPT_PARTITION = 'persist:localchat-chatgpt';");
    expect(windowSource).not.toContain('configureChatGptBrowserIdentity(session.defaultSession)');
  });

  it('applies the same identity to remote views and popup children, never local renderers', () => {
    const remoteStart = windowSource.indexOf('function secureRemoteContents(');
    const localStart = windowSource.indexOf('function secureLocalContents(');
    const createStart = windowSource.indexOf('export async function createChatSpliceWindow(');
    const remoteSource = windowSource.slice(remoteStart, localStart);
    const localSource = windowSource.slice(localStart, createStart);
    expect(remoteSource).toContain('configureChatGptBrowserIdentity(contents);');
    expect(remoteSource).toContain('secureRemoteContents(child.webContents);');
    expect(remoteSource).toContain('if (!isAllowedChatGptNavigation(navigationUrl))');
    expect(localSource).not.toContain('configureChatGptBrowserIdentity');
    expect(windowSource).toContain('installDefaultDenyPermissions(remoteSession);');
  });
});
