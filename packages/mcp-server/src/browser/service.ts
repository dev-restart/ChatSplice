import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ChatSpliceError } from '@chatsplice/core';
import {
  isLocalPreviewUrl,
  ProjectBrowserSnapshotSchema,
  type ProjectExecInput,
} from '@chatsplice/protocol';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type {
  ProjectExecutionBackendOptions,
  ProjectExecutionResult,
} from '../execution/backend.js';
import { EMBEDDED_EXECUTION_CONCURRENCY, MAX_CONCURRENT_EXECUTIONS } from '../execution/limits.js';
import { assertBrowserState, browserLogUrl } from './assertions.js';
import { browserActionFailure, browserActionTimeout } from './diagnostics.js';
import { ManagedPreviewBrowser } from './managed-browser.js';

const MAX_IMAGE_BYTES = 1024 * 1024;
const require = createRequire(import.meta.url);

interface PreviewSession {
  readonly browser: Browser;
  readonly root: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly console: string[];
}

/** Isolated local-app browser contexts; never attaches to the ChatGPT profile. */
export class ProjectBrowserService {
  readonly #sessions = new Map<string, PreviewSession>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #opening = new Set<string>();
  readonly #managedBrowser = new ManagedPreviewBrowser(() =>
    chromium.launch({
      headless: true,
      timeout: 30_000,
      env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
    }),
  );
  #closed = false;
  #shutdown: Promise<void> | undefined;

  public constructor(
    private readonly maxSessions = EMBEDDED_EXECUTION_CONCURRENCY.browser_sessions,
  ) {
    if (
      !Number.isInteger(maxSessions) ||
      maxSessions < 1 ||
      maxSessions > MAX_CONCURRENT_EXECUTIONS
    )
      throw new ChatSpliceError('BAD_REQUEST', 'Invalid preview session limit.');
  }

  public async execute(
    input: ProjectExecInput,
    options: ProjectExecutionBackendOptions,
    root: string,
  ): Promise<ProjectExecutionResult> {
    const previous = this.#queues.get(input.workspace_id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => this.#execute(input, options, root));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(input.workspace_id, tail);
    void tail.finally(() => {
      if (this.#queues.get(input.workspace_id) === tail) this.#queues.delete(input.workspace_id);
    });
    return result;
  }

  public close(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#closed = true;
    this.#shutdown = (async () => {
      await Promise.allSettled([...this.#sessions.keys()].map((id) => this.#closeSession(id)));
      await this.#managedBrowser.close();
    })();
    return this.#shutdown;
  }

  async #execute(
    input: ProjectExecInput,
    options: ProjectExecutionBackendOptions,
    root: string,
  ): Promise<ProjectExecutionResult> {
    if (input.operation.kind !== 'browser')
      throw new ChatSpliceError('BAD_REQUEST', 'Expected a browser operation.');
    options.signal.throwIfAborted();
    if (this.#closed)
      throw new ChatSpliceError('BAD_REQUEST', 'The preview browser is shutting down.');
    const action = input.operation.action;
    const previousSession = this.#sessions.get(input.workspace_id);
    if (previousSession !== undefined && previousSession.root !== root)
      await this.#closeSession(input.workspace_id);
    const started = Date.now();
    options.onStart({ command: `browser ${action.kind}`, used_network: true });
    if (action.kind === 'setup') return this.#install(input, options);
    if (action.kind === 'close') {
      await this.#closeSession(input.workspace_id);
      options.onOutput('Preview browser closed.\n');
      return { exit_code: 0, duration_ms: Date.now() - started, timed_out: false };
    }

    let timedOut = false;
    let cleanup: Promise<void> | undefined;
    const abort = (): void => {
      cleanup ??= this.#closeSession(input.workspace_id);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeout_ms);
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      const preview =
        action.kind === 'open'
          ? await this.#open(input.workspace_id, root, action.width ?? 1280, action.height ?? 800)
          : this.#requireSession(input.workspace_id);
      if (options.signal.aborted || timedOut) {
        await this.#closeSession(input.workspace_id);
        options.signal.throwIfAborted();
        return { exit_code: null, duration_ms: Date.now() - started, timed_out: true };
      }
      const timeout = browserActionTimeout(started, input.timeout_ms, Date.now());
      let actionFailed = false;
      try {
        if (action.kind === 'assert') {
          await assertBrowserState(
            preview.page,
            action.expectation,
            browserActionTimeout(started, input.timeout_ms, Date.now(), action.timeout_ms ?? 5000),
          );
        } else if (action.kind === 'open') {
          if (!isLocalPreviewUrl(action.url))
            throw new ChatSpliceError('BAD_REQUEST', 'Preview URLs must use loopback HTTP(S).');
          const response = await preview.page.goto(action.url, {
            waitUntil: 'domcontentloaded',
            timeout,
          });
          if (response !== null && response.status() >= 400) {
            options.onOutput(`Preview navigation returned HTTP ${response.status()}.\n`);
            throw new ChatSpliceError(
              'BAD_REQUEST',
              `Preview navigation returned HTTP ${response.status()}. Inspect the server log and repair it.`,
            );
          }
        } else if (action.kind === 'click' || action.kind === 'fill' || action.kind === 'press') {
          const target = preview.page.locator(action.selector);
          // Locator actions retain Playwright's strict matching and auto-wait.
          // An immediate count() rejects controls that appear after hydration.
          if (action.kind === 'click') await target.click({ timeout });
          else if (action.kind === 'fill') await target.fill(action.value, { timeout });
          else await target.press(action.key, { timeout });
        } else if (action.kind === 'scroll') {
          await preview.page.evaluate(({ x, y }) => window.scrollBy(x, y), {
            x: action.x,
            y: action.y,
          });
        }
      } catch (error) {
        options.signal.throwIfAborted();
        if (timedOut)
          return { exit_code: null, duration_ms: Date.now() - started, timed_out: true };
        actionFailed = true;
        // Do not echo assertion values (possibly credentials) or an unbounded
        // Playwright call log. The failed job still retains bounded page evidence.
        const reason = browserActionFailure(error, action.kind === 'assert');
        options.onOutput(
          `Preview ${action.kind} failed [${reason}]. Inspect the snapshot and server logs.\n`,
        );
      }
      if (!isLocalPreviewUrl(preview.page.url()))
        throw new ChatSpliceError('BAD_REQUEST', 'Preview navigation left the local application.');
      const pageDocument = await preview.page.evaluate(() => {
        function selector(element: Element): string | undefined {
          const idSelector = `#${CSS.escape(element.id)}`;
          if (
            element.id !== '' &&
            idSelector.length <= 1000 &&
            document.querySelectorAll(idSelector).length === 1
          )
            return idSelector;
          const testId = element.getAttribute('data-testid');
          if (testId !== null && testId !== '') {
            const candidate = `[data-testid="${CSS.escape(testId)}"]`;
            if (candidate.length <= 1000 && document.querySelectorAll(candidate).length === 1)
              return candidate;
          }
          const parts: string[] = [];
          let current: Element | null = element;
          while (current !== null && current !== document.documentElement) {
            const tag = CSS.escape(current.tagName.toLowerCase());
            const siblings: Element[] =
              current.parentElement === null
                ? []
                : [...current.parentElement.children].filter(
                    (child) => child.tagName === current?.tagName,
                  );
            parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
            const candidate = parts.join(' > ');
            // Never truncate a selector into a different or invalid target.
            // Unrepresentable controls remain visible in text and screenshots.
            if (candidate.length > 1000) return undefined;
            if (document.querySelectorAll(candidate).length === 1) return candidate;
            current = current.parentElement;
          }
          return undefined;
        }
        return {
          title: document.title.slice(0, 1000),
          text: (document.body?.innerText ?? '').slice(0, 24000),
          controls: [...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')]
            .filter((element) => element.getClientRects().length > 0)
            .slice(0, 100)
            .flatMap((element) => {
              const target = selector(element);
              if (target === undefined) return [];
              return [
                {
                  selector: target,
                  tag: element.tagName.toLowerCase().slice(0, 30),
                  text: (
                    element.getAttribute('aria-label') ||
                    (element instanceof HTMLInputElement ||
                    element instanceof HTMLTextAreaElement ||
                    element instanceof HTMLSelectElement
                      ? [...(element.labels ?? [])]
                          .map((label) => label.textContent ?? '')
                          .join(' ')
                      : '') ||
                    element.getAttribute('placeholder') ||
                    element.textContent ||
                    ''
                  )
                    .trim()
                    .slice(0, 300),
                },
              ];
            }),
        };
      });
      let screenshot: Buffer | undefined;
      const captureTimeout = (): number =>
        Math.max(1, Math.min(10000, input.timeout_ms - (Date.now() - started)));
      try {
        screenshot = await preview.page.screenshot({
          type: 'jpeg',
          quality: 65,
          timeout: captureTimeout(),
        });
        if (screenshot.length > MAX_IMAGE_BYTES)
          screenshot = await preview.page.screenshot({
            type: 'jpeg',
            quality: 25,
            timeout: captureTimeout(),
          });
        if (screenshot.length > MAX_IMAGE_BYTES) {
          screenshot = undefined;
          actionFailed = true;
          options.onOutput(
            'Preview screenshot exceeds 1 MiB; open a smaller viewport. Page text is retained.\n',
          );
        }
      } catch {
        options.signal.throwIfAborted();
        screenshot = undefined;
        actionFailed = true;
        options.onOutput(
          'Preview screenshot unavailable [capture_failed]. Page text is retained; no image was verified.\n',
        );
      }
      options.signal.throwIfAborted();
      if (timedOut) return { exit_code: null, duration_ms: Date.now() - started, timed_out: true };
      const viewport = preview.page.viewportSize() ?? { width: 1280, height: 800 };
      const snapshot = ProjectBrowserSnapshotSchema.parse({
        ...pageDocument,
        url: preview.page.url(),
        console: [...preview.console],
        screenshot_available: screenshot !== undefined,
        ...viewport,
      });
      const evidence =
        screenshot === undefined
          ? 'browser_result (no screenshot)'
          : 'browser_result and the attached screenshot';
      options.onOutput(
        `Preview ${action.kind} ${actionFailed ? 'failed' : 'completed'}; inspect ${evidence}.\n`,
      );
      return {
        exit_code: actionFailed ? 1 : 0,
        duration_ms: Date.now() - started,
        timed_out: false,
        browser_result: snapshot,
        ...(screenshot === undefined
          ? {}
          : { image: { data: screenshot, mimeType: 'image/jpeg' as const } }),
      };
    } catch (error) {
      if (timedOut) return { exit_code: null, duration_ms: Date.now() - started, timed_out: true };
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      // Keep the workspace lease until context cancellation has finished.
      // Deleting the session entry alone does not stop its in-flight requests.
      await cleanup;
    }
  }

  async #open(
    workspaceId: string,
    root: string,
    width: number,
    height: number,
  ): Promise<PreviewSession> {
    // Discard only dead contexts. Keep healthy workspaces and their state intact.
    for (const [id, session] of [...this.#sessions]) {
      if (session.page.isClosed() || !session.browser.isConnected())
        await this.#closeSession(id, session);
    }
    const existing = this.#sessions.get(workspaceId);
    if (existing !== undefined) {
      try {
        await existing.page.setViewportSize({ width, height });
        return existing;
      } catch {
        // A crashed renderer keeps its context connected but rejects every call.
        // Replace it so open can recover instead of failing until an explicit close.
        await this.#closeSession(workspaceId, existing);
      }
    }
    if (this.#sessions.size + this.#opening.size >= this.maxSessions)
      throw new ChatSpliceError(
        'BAD_REQUEST',
        `${this.maxSessions} preview sessions are open. Close one before opening another workspace.`,
      );
    this.#opening.add(workspaceId);
    try {
      const browser = await this.#managedBrowser.acquire();
      const context = await browser.newContext({
        viewport: { width, height },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        const logs: string[] = [];
        const record = (message: string): void => {
          logs.push(message.slice(0, 1000));
          if (logs.length > 100) logs.shift();
        };
        page.on('console', (message) => record(`${message.type()}: ${message.text()}`));
        page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
        page.on('requestfailed', (request) => {
          record(
            `requestfailed: ${browserLogUrl(request.url())} ${request.failure()?.errorText ?? ''}`,
          );
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            record(`http-error: ${response.status()} ${browserLogUrl(response.url())}`);
        });
        page.on('dialog', (dialog) => {
          void dialog.dismiss().catch(() => undefined);
        });
        context.on('page', (popup) => {
          if (popup !== page) void popup.close().catch(() => undefined);
        });
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (request.isNavigationRequest() && !isLocalPreviewUrl(request.url()))
            await route.abort();
          else await route.continue();
        });
        if (this.#closed || page.isClosed() || !browser.isConnected()) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'The preview closed while its page was opening.',
          );
        }
        const preview = { browser, context, page, console: logs, root };
        this.#sessions.set(workspaceId, preview);
        return preview;
      } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
      }
    } finally {
      this.#opening.delete(workspaceId);
    }
  }

  #requireSession(workspaceId: string): PreviewSession {
    const session = this.#sessions.get(workspaceId);
    if (session === undefined || session.page.isClosed() || !session.browser.isConnected())
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'No preview page is open for this workspace. Open its local application URL first.',
      );
    return session;
  }

  async #closeSession(workspaceId: string, expected?: PreviewSession): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (expected !== undefined && session !== expected) return;
    this.#sessions.delete(workspaceId);
    await session?.context.close().catch(() => undefined);
  }

  async #install(
    input: ProjectExecInput,
    options: ProjectExecutionBackendOptions,
  ): Promise<ProjectExecutionResult> {
    const started = Date.now();
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium', '--only-shell'], {
      env: {
        HOME: homedir(),
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        PLAYWRIGHT_SKIP_BROWSER_GC: '1',
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
          ? {}
          : { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }),
        ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already exited. */
        }
      }
    };
    const abort = (): void => {
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeout_ms);
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout?.on('data', (data: Buffer) => options.onOutput(data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => options.onOutput(data.toString('utf8')));
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { exit_code: exitCode, duration_ms: Date.now() - started, timed_out: timedOut };
    } finally {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', abort);
      kill('SIGKILL');
    }
  }
}
