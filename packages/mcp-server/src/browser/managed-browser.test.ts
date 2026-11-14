import { EventEmitter } from 'node:events';

import type { Browser } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { ManagedPreviewBrowser } from './managed-browser.js';

function fakeBrowser() {
  const events = new EventEmitter();
  let connected = true;
  const disconnect = () => {
    connected = false;
    events.emit('disconnected');
  };
  const stub = {
    isConnected: () => connected,
    once: events.once.bind(events),
    close: vi.fn(async () => {
      disconnect();
    }),
  };
  return { browser: stub as unknown as Browser, stub, disconnect };
}

// Lifecycle tests use deterministic process stubs; browser workflow tests use Chromium.
describe('managed preview browser lifecycle', () => {
  it('shares a single launch across concurrent projects', async () => {
    const fixture = fakeBrowser();
    const launch = vi.fn(async () => fixture.browser);
    const manager = new ManagedPreviewBrowser(launch);
    try {
      const [a, b] = await Promise.all([manager.acquire(), manager.acquire()]);
      expect(a).toBe(b);
      expect(a).toBe(fixture.browser);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(await manager.acquire()).toBe(a);
    } finally {
      await manager.close();
    }
    expect(fixture.stub.close).toHaveBeenCalledTimes(1);
  });

  it('retries a failed launch on the next request, never installs automatically', async () => {
    const fixture = fakeBrowser();
    const launch = vi
      .fn(async () => fixture.browser)
      .mockRejectedValueOnce(new Error("Executable doesn't exist"));
    const manager = new ManagedPreviewBrowser(launch);
    try {
      await expect(manager.acquire()).rejects.toThrow('[browser_missing]');
      expect(await manager.acquire()).toBe(fixture.browser);
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
    }
  });

  it('replaces a disconnected browser instead of reusing a resolved launch promise', async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    const launch = vi.fn(async () => second.browser).mockResolvedValueOnce(first.browser);
    const manager = new ManagedPreviewBrowser(launch);
    try {
      expect(await manager.acquire()).toBe(first.browser);
      first.disconnect();
      expect(await manager.acquire()).toBe(second.browser);
      first.disconnect();
      expect(await manager.acquire()).toBe(second.browser);
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
    }
    expect(second.stub.close).toHaveBeenCalledTimes(1);
  });

  it('closes a browser that finishes launching after shutdown', async () => {
    const fixture = fakeBrowser();
    let release!: (browser: Browser) => void;
    const gate = new Promise<Browser>((resolve) => {
      release = resolve;
    });
    const launch = vi.fn(() => gate);
    const manager = new ManagedPreviewBrowser(launch);
    const pending = manager.acquire();
    const rejected = expect(pending).rejects.toThrow('shutting down');
    await Promise.resolve();
    const closing = manager.close();
    release(fixture.browser);
    await rejected;
    await closing;
    await manager.close();
    await expect(manager.acquire()).rejects.toThrow('shutting down');
    expect(fixture.stub.close).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
