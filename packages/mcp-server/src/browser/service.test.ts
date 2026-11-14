import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectExecInputSchema } from '@chatsplice/protocol';
import type * as BrowserAssertions from './assertions.js';

const fixture = vi.hoisted(() => ({
  status: 200,
  click: vi.fn(async (): Promise<void> => undefined),
  assert: vi.fn(async () => undefined),
  closeContext: vi.fn(async (): Promise<void> => undefined),
  viewport: vi.fn(async (): Promise<void> => undefined),
  screenshot: vi.fn(async () => Buffer.from('fixture-image')),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('./assertions.js', async (load) => {
  const original = await load<typeof BrowserAssertions>();
  return { ...original, assertBrowserState: fixture.assert };
});
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      close: async () => undefined,
      isConnected: () => true,
      once: () => undefined,
      newContext: async () => ({
        close: fixture.closeContext,
        on: () => undefined,
        route: async () => undefined,
        newPage: async () => ({
          goto: async () => ({ status: () => fixture.status }),
          url: () => 'http://127.0.0.1:5173/',
          setViewportSize: fixture.viewport,
          viewportSize: () => ({ width: 1280, height: 800 }),
          isClosed: () => false,
          on: (event: string, callback: (...args: unknown[]) => void) =>
            fixture.listeners.set(event, callback),
          locator: () => ({ count: async () => 1, click: fixture.click }),
          evaluate: async () => ({ title: 'Fixture', text: 'Current screen', controls: [] }),
          screenshot: fixture.screenshot,
        }),
      }),
    }),
  },
}));
import { ProjectBrowserService } from './service.js';

describe('browser failure evidence', () => {
  beforeEach(() => {
    fixture.status = 200;
    fixture.click.mockReset().mockResolvedValue(undefined);
    fixture.assert.mockReset().mockResolvedValue(undefined);
    fixture.closeContext.mockReset().mockResolvedValue(undefined);
    fixture.viewport.mockReset().mockResolvedValue(undefined);
    fixture.screenshot.mockReset().mockResolvedValue(Buffer.from('fixture-image'));
    fixture.listeners.clear();
  });
  const run = (
    service: ProjectBrowserService,
    action: unknown,
    output: string[],
    signal = new AbortController().signal,
    timeoutMs = 10000,
  ) =>
    service.execute(
      ProjectExecInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: `wb_${'a'.repeat(64)}`,
        request_id: 'browser-evidence-fixture',
        operation: { kind: 'browser', action },
        timeout_ms: timeoutMs,
      }),
      {
        signal,
        onStart: () => undefined,
        onOutput: (value) => output.push(value),
      },
      '/fixture',
    );
  it('keeps page evidence on HTTP navigation failure', async () => {
    const service = new ProjectBrowserService();
    try {
      fixture.status = 503;
      const output: string[] = [];
      const result = await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, output);
      expect(result.exit_code).toBe(1);
      expect(result.browser_result?.text).toBe('Current screen');
      expect(result.image?.mimeType).toBe('image/jpeg');
      expect(output.join('')).toContain('HTTP 503');
    } finally {
      await service.close();
    }
  });
  it('replaces a crashed preview page when open is retried', async () => {
    const service = new ProjectBrowserService();
    const output: string[] = [];
    try {
      const action = { kind: 'open', url: 'http://127.0.0.1:5173/' };
      await run(service, action, output);
      fixture.viewport.mockRejectedValueOnce(new Error('Target crashed'));
      const reopened = await run(service, action, output);
      expect(reopened.exit_code).toBe(0);
      expect(fixture.closeContext).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });
  it('retains a failed click/assertion screenshot and permits a later retry', async () => {
    const service = new ProjectBrowserService();
    const output: string[] = [];
    try {
      await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, output);
      fixture.click.mockRejectedValueOnce(new Error('private-input-value'));
      expect((await run(service, { kind: 'click', selector: '#save' }, output)).exit_code).toBe(1);
      fixture.assert.mockRejectedValueOnce(new Error('private-assertion-value'));
      const action = {
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Saved' },
      };
      const failed = await run(service, action, output);
      expect(failed.exit_code).toBe(1);
      expect(failed.browser_result?.screenshot_available).toBe(true);
      expect(failed.image).toBeDefined();
      expect(output.join('')).not.toContain('private-');
      expect((await run(service, action, output)).exit_code).toBe(0);
    } finally {
      await service.close();
    }
  });
  it('keeps text evidence and reports failure when a screenshot cannot be captured', async () => {
    const service = new ProjectBrowserService();
    const output: string[] = [];
    try {
      await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, output);
      fixture.screenshot.mockRejectedValueOnce(new Error('private-capture-details'));
      const result = await run(service, { kind: 'snapshot' }, output);
      expect(result.exit_code).toBe(1);
      expect(result.browser_result?.text).toBe('Current screen');
      expect(result.browser_result?.screenshot_available).toBe(false);
      expect(result.image).toBeUndefined();
      expect(output.join('')).toContain('[capture_failed]');
      expect(output.join('')).not.toContain('private-capture-details');
    } finally {
      await service.close();
    }
  });
  it('does not retain oversized images after the lower-quality retry', async () => {
    const service = new ProjectBrowserService();
    try {
      fixture.screenshot.mockResolvedValue(Buffer.alloc(1024 * 1024 + 1));
      const result = await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, []);
      expect(fixture.screenshot).toHaveBeenCalledTimes(2);
      expect(result.exit_code).toBe(1);
      expect(result.browser_result?.screenshot_available).toBe(false);
      expect(result.image).toBeUndefined();
    } finally {
      await service.close();
    }
  });
  it('records HTTP response failures without URL query secrets', async () => {
    const service = new ProjectBrowserService();
    try {
      await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, []);
      fixture.listeners.get('response')?.({
        status: () => 401,
        url: () => 'http://localhost/api?token=secret',
      });
      const result = await run(service, { kind: 'snapshot' }, []);
      expect(result.browser_result?.console).toContain('http-error: 401 http://localhost/api');
      expect(JSON.stringify(result.browser_result?.console)).not.toContain('secret');
    } finally {
      await service.close();
    }
  });
  it('waits for cancelled context cleanup before releasing the execution', async () => {
    const service = new ProjectBrowserService();
    const controller = new AbortController();
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    try {
      await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, []);
      fixture.closeContext.mockImplementationOnce(() => closing);
      fixture.click.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('Context was closed');
      });
      const pending = run(service, { kind: 'click', selector: '#save' }, [], controller.signal);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.closeContext).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      releaseClose();
      await expect(pending).rejects.toThrow();
    } finally {
      releaseClose();
      await service.close();
    }
  });
  it('waits for timed-out context cleanup before reporting the timeout', async () => {
    const service = new ProjectBrowserService();
    let releaseClose!: () => void;
    let rejectClick!: (error: Error) => void;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const clicked = new Promise<void>((_, reject) => {
      rejectClick = reject;
    });
    try {
      await run(service, { kind: 'open', url: 'http://127.0.0.1:5173/' }, []);
      fixture.closeContext.mockImplementationOnce(async () => {
        rejectClick(new Error('Context was closed'));
        await closing;
      });
      fixture.click.mockImplementationOnce(() => clicked);
      vi.useFakeTimers();
      const pending = run(
        service,
        { kind: 'click', selector: '#save' },
        [],
        new AbortController().signal,
        1000,
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.closeContext).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      releaseClose();
      await expect(pending).resolves.toMatchObject({ exit_code: null, timed_out: true });
    } finally {
      releaseClose();
      vi.useRealTimers();
      await service.close();
    }
  });
});
