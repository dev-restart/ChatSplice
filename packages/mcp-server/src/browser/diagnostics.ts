import { ChatSpliceError } from '@chatsplice/core';

/** Classify without returning Playwright logs, paths, URLs or assertion values. */
export function browserLaunchError(error: unknown): ChatSpliceError {
  const message = error instanceof Error ? error.message.slice(0, 24000) : '';
  if (
    /EPERM|EACCES|operation not permitted|permission denied|sandbox initialization failed/i.test(
      message,
    )
  ) {
    return new ChatSpliceError(
      'BAD_REQUEST',
      '[browser_permission_denied] The execution environment denied browser startup. Do not disable the sandbox or repeatedly install Chromium. Use the dedicated browser tool for a local preview, or inspect the test runner environment.',
    );
  }
  if (/executable doesn.t exist|executable.*not found|please.*install.*browser/i.test(message)) {
    return new ChatSpliceError(
      'BAD_REQUEST',
      '[browser_missing] Managed Chromium is missing from this runtime cache. Run browser setup, await its exit status, then retry open. For repository tests, use browser:setup and test:browser so installation and execution use the same project-local cache.',
    );
  }
  if (/timeout.*exceeded|timed out/i.test(message)) {
    return new ChatSpliceError(
      'BAD_REQUEST',
      '[browser_launch_timeout] Chromium did not start before the deadline. Check local resources before retrying; no automatic installation was attempted.',
    );
  }
  return new ChatSpliceError(
    'BAD_REQUEST',
    '[browser_launch_failed] Chromium could not start. Inspect the runtime rather than assuming the browser is missing. No browser installation or security-policy change was attempted.',
  );
}

export function browserActionFailure(error: unknown, assertion: boolean): string {
  const message = error instanceof Error ? error.message.slice(0, 24000) : '';
  if (/strict mode violation/i.test(message)) return 'selector_ambiguous';
  if (assertion) return 'assertion_failed';
  if (/timeout.*exceeded|timed out/i.test(message)) return 'action_timeout';
  return 'action_failed';
}

/** Reserve part of the remaining job budget for failure evidence, never timeout:0. */
export function browserActionTimeout(
  started: number,
  total: number,
  now: number,
  requested = 30000,
): number {
  const remaining = Math.max(1, total - Math.max(0, now - started));
  const reserve = Math.min(1000, Math.floor(remaining / 4));
  return Math.max(1, Math.min(requested, remaining - reserve));
}
