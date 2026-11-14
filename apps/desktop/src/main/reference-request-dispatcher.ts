import { app, dialog } from 'electron';
import type { BaseWindow, MessageBoxOptions } from 'electron';

import type { ReferenceRequestListResult, ReferenceRequestStatus } from '@chatsplice/protocol';

type PendingReferenceRequest = ReferenceRequestListResult['requests'][number];
type ReferenceAccessMode = NonNullable<PendingReferenceRequest['access_mode']>;
type OwnerDecision =
  | { readonly approved: false }
  | { readonly approved: true; readonly access_mode: ReferenceAccessMode };

interface ReferenceRequestDispatchClient {
  listReferenceRequests(): Promise<ReferenceRequestListResult>;
  decideReferenceRequest(
    requestId: string,
    approved: boolean,
    accessMode?: ReferenceAccessMode,
  ): Promise<ReferenceRequestStatus>;
}

interface ReferenceRequestDispatcherOptions {
  readonly pollIntervalMs?: number;
}

function dialogOptions(request: PendingReferenceRequest): MessageBoxOptions {
  // An absent mode can only come from a legacy request; keep it read-only.
  const readOnly = request.access_mode !== 'read_write';
  const korean = app.getLocale().toLowerCase().startsWith('ko');
  return {
    type: 'question',
    buttons: korean ? ['거부', '이 폴더에서 작업 허용'] : ['Deny', 'Allow work in this folder'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: korean ? '폴더 접근 권한 요청' : 'Folder access request',
    message: korean
      ? `${request.workspace_name} 프로젝트에서 이 폴더를 사용하도록 허용할까요?`
      : `Allow ${request.workspace_name} to work in this folder?`,
    detail: [
      request.path,
      request.label ?? undefined,
      korean
        ? '허용하면 이 프로젝트에서 AI가 작업에 필요한 파일 읽기·생성·수정·삭제와 명령 실행을 판단해 수행할 수 있습니다. 읽기 전용으로 연결하면 파일 조회만 허용됩니다.'
        : 'Allow this project to read, create, change and delete files and run commands in this folder as needed for your work. Connecting as read-only allows viewing files only.',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n\n'),
    checkboxLabel: korean ? '읽기 전용으로 연결' : 'Connect as read-only',
    checkboxChecked: readOnly,
  };
}

/**
 * Shows one native prompt per pending request and relays the owner's choice.
 * A lost daemon response retries only the same decision and access mode for
 * that request ID, without asking again, until it resolves or expires.
 */
export class ReferenceRequestDispatcher {
  readonly #client: ReferenceRequestDispatchClient;
  readonly #getWindow: () => BaseWindow | undefined;
  readonly #pollIntervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #checking = false;
  #stopped = true;
  readonly #decisions = new Map<string, OwnerDecision>();
  #lastAttemptedRequestId: string | undefined;

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
      const pendingIds = new Set(pending.requests.map((request) => request.request_id));
      for (const requestId of this.#decisions.keys()) {
        if (!pendingIds.has(requestId)) this.#decisions.delete(requestId);
      }
      if (pending.requests.length === 0 || this.#stopped) return;
      // A failed decision must not hold up requests for other projects.
      const previousIndex = pending.requests.findIndex(
        (request) => request.request_id === this.#lastAttemptedRequestId,
      );
      const request = pending.requests[(previousIndex + 1) % pending.requests.length];
      if (request === undefined) return;
      this.#lastAttemptedRequestId = request.request_id;
      let decision = this.#decisions.get(request.request_id);
      if (decision === undefined) {
        decision = await this.#promptOwner(request);
        this.#decisions.set(request.request_id, decision);
      }
      if (this.#stopped) return;
      if (decision.approved) {
        await this.#client.decideReferenceRequest(request.request_id, true, decision.access_mode);
      } else {
        await this.#client.decideReferenceRequest(request.request_id, false);
      }
    } catch {
      // Preserve the exact owner decision for retry; other requests still get a turn.
    } finally {
      this.#checking = false;
    }
  }

  public stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #promptOwner(request: PendingReferenceRequest): Promise<OwnerDecision> {
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
      if (result.response !== 1 || typeof result.checkboxChecked !== 'boolean') {
        return { approved: false };
      }
      return {
        approved: true,
        access_mode: result.checkboxChecked ? 'read_only' : 'read_write',
      };
    } finally {
      if (focusable !== undefined && !focusable.isDestroyed()) focusable.flashFrame(false);
    }
  }
}
