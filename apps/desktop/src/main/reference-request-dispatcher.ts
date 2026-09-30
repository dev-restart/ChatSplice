import { dialog } from 'electron';
import type { BaseWindow, MessageBoxOptions } from 'electron';

import type { ReferenceRequestListResult, ReferenceRequestStatus } from '@chatsplice/protocol';

type PendingReferenceRequest = ReferenceRequestListResult['requests'][number];

interface ReferenceRequestDispatchClient {
  listReferenceRequests(): Promise<ReferenceRequestListResult>;
  decideReferenceRequest(requestId: string, approved: boolean): Promise<ReferenceRequestStatus>;
}

interface ReferenceRequestDispatcherOptions {
  readonly pollIntervalMs?: number;
}

function dialogOptions(request: PendingReferenceRequest): MessageBoxOptions {
  return {
    type: 'question',
    buttons: ['Deny', 'Allow read-only'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Reference request',
    message: `${request.workspace_name} wants read-only access to another folder`,
    detail: [
      request.path,
      request.label ?? undefined,
      'Only this folder becomes visible, read-only, to that project. Nothing is written.',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n\n'),
  };
}

/**
 * Shows exactly one native approval prompt per pending ad-hoc reference
 * request and relays the owner's decision. Never approves or denies on its
 * own — a lost daemon response leaves the request pending for the next poll
 * or lets it expire on its own TTL.
 */
export class ReferenceRequestDispatcher {
  readonly #client: ReferenceRequestDispatchClient;
  readonly #getWindow: () => BaseWindow | undefined;
  readonly #pollIntervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #checking = false;
  #stopped = true;

  public constructor(
    client: ReferenceRequestDispatchClient,
    getWindow: () => BaseWindow | undefined,
    options: ReferenceRequestDispatcherOptions = {},
  ) {
    this.#client = client;
    this.#getWindow = getWindow;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  public async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.wake(), this.#pollIntervalMs);
    this.#timer.unref();
    await this.wake();
  }

  public async wake(): Promise<void> {
    if (this.#stopped || this.#checking) return;
    this.#checking = true;
    try {
      const pending = await this.#client.listReferenceRequests();
      const request = pending.requests[0];
      if (request === undefined || this.#stopped) return;
      const approved = await this.#promptOwner(request);
      if (this.#stopped) return;
      await this.#client.decideReferenceRequest(request.request_id, approved);
    } catch {
      // Intentionally swallowed — see class doc.
    } finally {
      this.#checking = false;
    }
  }

  public stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #promptOwner(request: PendingReferenceRequest): Promise<boolean> {
    const candidate = this.#getWindow();
    const focusable = candidate !== undefined && !candidate.isDestroyed() ? candidate : undefined;
    if (focusable !== undefined) {
      if (focusable.isMinimized()) focusable.restore();
      focusable.show();
      focusable.focus();
      focusable.flashFrame(true);
    }
    try {
      const result = await dialog.showMessageBox(dialogOptions(request));
      return result.response === 1;
    } finally {
      focusable?.flashFrame(false);
    }
  }
}
