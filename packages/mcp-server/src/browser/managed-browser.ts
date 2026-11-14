import { ChatSpliceError } from '@chatsplice/core';
import type { Browser } from 'playwright';

import { browserLaunchError } from './diagnostics.js';

/** Owns only the isolated preview browser, never a user profile or CDP attachment. */
export class ManagedPreviewBrowser {
  #browser: Browser | undefined;
  #launch: Promise<Browser> | undefined;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  public constructor(private readonly launch: () => Promise<Browser>) {}

  public acquire(): Promise<Browser> {
    if (this.#closed) {
      return Promise.reject(
        new ChatSpliceError('BAD_REQUEST', 'The preview browser is shutting down.'),
      );
    }
    if (this.#browser?.isConnected()) return Promise.resolve(this.#browser);
    if (this.#launch !== undefined) return this.#launch;

    const pending = Promise.resolve()
      .then(() => this.launch())
      .catch((error: unknown) => {
        throw browserLaunchError(error);
      })
      .then(async (browser) => {
        if (this.#closed) {
          await browser.close();
          throw new ChatSpliceError('BAD_REQUEST', 'The preview browser is shutting down.');
        }
        if (!browser.isConnected()) {
          await browser.close().catch(() => undefined);
          throw new ChatSpliceError(
            'BAD_REQUEST',
            '[browser_disconnected] Chromium closed during startup. Retry open after inspecting the runtime.',
          );
        }
        this.#browser = browser;
        browser.once('disconnected', () => {
          if (this.#browser === browser) this.#browser = undefined;
        });
        return browser;
      });
    this.#launch = pending;
    const clear = (): void => {
      if (this.#launch === pending) this.#launch = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  public close(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#closed = true;
    const active = this.#browser;
    this.#browser = undefined;
    const pending = this.#launch;
    this.#shutdown = (async () => {
      // A browser whose launch completes after shutdown closes in acquire().
      // Wait for that cleanup; do not leave an orphan browser process behind.
      await Promise.allSettled([
        ...(active === undefined ? [] : [active.close()]),
        ...(pending === undefined ? [] : [pending]),
      ]);
    })();
    return this.#shutdown;
  }
}
