import type { DaemonStatus } from '@chatsplice/protocol';

import type { LocalMcpAutoAttachContext } from './chatgpt-tabs.js';

const FAILURE_COOLDOWN_BASE_MS = 30_000;
const FAILURE_COOLDOWN_MAX_MS = 120_000;
const FAILURE_CONTEXT_RETENTION_MS = 300_000;
const MAX_FAILURE_CONTEXTS = 32;

const SUCCESS_RESULTS = new Set(['attached', 'already_attached']);
const NO_ACTION_RESULTS = new Set([
  'skipped',
  'hidden',
  'busy',
  'awaiting_input',
  'user_input_active',
  'context_changed',
  'not_chatgpt',
  'not_visible',
  'composer_not_found',
]);

interface AutoAttachDispatchClient {
  status(): Promise<DaemonStatus>;
}

interface AutoAttachTarget {
  runLocalMcpAutoAttach(enabledWorkspaceIds: ReadonlySet<string>, appName: string): Promise<string>;
  getLocalMcpAutoAttachContext?: () => LocalMcpAutoAttachContext | undefined;
}

interface LocalMcpAutoAttachDispatcherOptions {
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

interface FailureCooldown {
  readonly attempts: number;
  readonly retryAt: number;
  readonly lastAttemptAt: number;
}

/**
 * Polls which projects have the owner's "auto-attach" toggle on
 * and re-picks the app in the active tab's composer for them. Never reads
 * the toggle state from anywhere but the daemon, never blocks on a slow or
 * failed attempt, and does nothing when no project has the toggle on.
 */
export class LocalMcpAutoAttachDispatcher {
  readonly #client: AutoAttachDispatchClient;
  readonly #tabs: AutoAttachTarget;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #inFlightGeneration: number | undefined;
  #scriptInFlight = false;
  #generation = 0;
  readonly #failureCooldowns = new Map<string, FailureCooldown>();
  #stopped = true;

  public constructor(
    client: AutoAttachDispatchClient,
    tabs: AutoAttachTarget,
    options: LocalMcpAutoAttachDispatcherOptions = {},
  ) {
    this.#client = client;
    this.#tabs = tabs;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.#now = options.now ?? Date.now;
  }

  public async start(): Promise<void> {
    if (!this.#stopped) return;
    const generation = ++this.#generation;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.wake(), this.#pollIntervalMs);
    this.#timer.unref();
    await this.wake(generation);
  }

  public async wake(expectedGeneration?: number): Promise<void> {
    const generation = expectedGeneration ?? this.#generation;
    if (this.#stopped || generation !== this.#generation) return;
    if (this.#inFlightGeneration === generation) return;
    this.#inFlightGeneration = generation;
    try {
      const status = await this.#client.status();
      if (!this.#isCurrent(generation)) return;
      if (status.auto_attach_workspace_ids.length === 0) return;
      const context = this.#tabs.getLocalMcpAutoAttachContext?.();
      const now = this.#now();
      this.#pruneFailureCooldowns(now);
      const key = context === undefined ? undefined : this.#contextKey(context);
      if (key !== undefined && this.#isCoolingDown(key, now)) return;
      if (this.#scriptInFlight) return;
      this.#scriptInFlight = true;
      let result: string;
      try {
        result = await this.#tabs.runLocalMcpAutoAttach(
          new Set(status.auto_attach_workspace_ids),
          status.mcp_app_name,
        );
      } catch {
        result = 'error';
      } finally {
        this.#scriptInFlight = false;
      }
      if (!this.#isCurrent(generation)) return;
      if (key === undefined) return;
      this.#recordResult(key, result, this.#now());
    } catch {
      // Best-effort — a lost status call or a failed script just tries again
      // on the next poll.
    } finally {
      if (this.#inFlightGeneration === generation) this.#inFlightGeneration = undefined;
    }
  }

  public stop(): void {
    this.#generation += 1;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #isCurrent(generation: number): boolean {
    return !this.#stopped && generation === this.#generation;
  }

  #contextKey(context: LocalMcpAutoAttachContext): string {
    return JSON.stringify([context.chatgpt_tab_id, context.workspace_id, context.url]);
  }

  #isCoolingDown(key: string, now: number): boolean {
    const cooldown = this.#failureCooldowns.get(key);
    if (cooldown === undefined) return false;
    if (now >= cooldown.retryAt) return false;
    return true;
  }

  #recordResult(key: string, result: string, now: number): void {
    if (SUCCESS_RESULTS.has(result) || NO_ACTION_RESULTS.has(result)) {
      this.#failureCooldowns.delete(key);
      return;
    }
    const previous = this.#failureCooldowns.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(FAILURE_COOLDOWN_BASE_MS * 2 ** (attempts - 1), FAILURE_COOLDOWN_MAX_MS);
    this.#failureCooldowns.set(key, {
      attempts,
      retryAt: now + delay,
      lastAttemptAt: now,
    });
    this.#pruneFailureCooldowns(now);
  }

  #pruneFailureCooldowns(now: number): void {
    for (const [key, cooldown] of this.#failureCooldowns) {
      if (now - cooldown.lastAttemptAt >= FAILURE_CONTEXT_RETENTION_MS) {
        this.#failureCooldowns.delete(key);
      }
    }
    while (this.#failureCooldowns.size > MAX_FAILURE_CONTEXTS) {
      const oldest = this.#failureCooldowns.keys().next().value;
      if (oldest === undefined) break;
      this.#failureCooldowns.delete(oldest);
    }
  }
}
