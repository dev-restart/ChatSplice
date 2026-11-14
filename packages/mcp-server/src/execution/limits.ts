import { ChatSpliceError } from '@chatsplice/core';

export interface ProjectExecutionConcurrency {
  readonly foreground: number;
  readonly background: number;
  readonly browser_sessions: number;
  readonly pending: number;
}

export const MAX_CONCURRENT_EXECUTIONS = 32;
export const EXECUTION_STORAGE_LIMITS = Object.freeze({
  retained_jobs: 100,
  image_bytes: 16 * 1024 * 1024,
  output_bytes: 64 * 1024,
  await_waiters: 128,
});

/** Conservative defaults for directly embedded service users. */
export const EMBEDDED_EXECUTION_CONCURRENCY: ProjectExecutionConcurrency = Object.freeze({
  foreground: 2,
  background: 4,
  browser_sessions: 4,
  pending: 20,
});

/** Shared production defaults for desktop, daemon and standalone MCP HTTP. */
export const DESKTOP_EXECUTION_CONCURRENCY: ProjectExecutionConcurrency = Object.freeze({
  foreground: 8,
  background: 12,
  browser_sessions: 12,
  pending: 64,
});

export function resolveExecutionConcurrency(
  input: ProjectExecutionConcurrency = EMBEDDED_EXECUTION_CONCURRENCY,
): ProjectExecutionConcurrency {
  for (const name of ['foreground', 'background', 'browser_sessions', 'pending'] as const) {
    const limit = input[name];
    const maximum =
      name === 'pending' ? EXECUTION_STORAGE_LIMITS.retained_jobs : MAX_CONCURRENT_EXECUTIONS;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
      throw new ChatSpliceError('BAD_REQUEST', `Invalid execution concurrency limit: ${name}.`);
  }
  return Object.freeze({ ...input });
}
