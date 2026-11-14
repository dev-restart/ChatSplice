import type { ProjectExecSummary } from '@chatsplice/protocol';

import type { ExecutionTextKey } from './execution-diagnostics-text.js';

export type ExecutionFailureCause =
  | 'workspace_busy'
  | 'preflight_limit'
  | 'preflight_link'
  | 'tool_missing'
  | 'browser_missing'
  | 'browser_start'
  | 'browser_action'
  | 'readiness'
  | 'permission'
  | 'command'
  | 'timeout'
  | 'request'
  | 'unknown';

export type ExecutionFailureFilter = 'all' | 'failed' | ExecutionFailureCause;

export interface ExecutionFailureView {
  readonly cause: ExecutionFailureCause;
  readonly title: ExecutionTextKey;
  readonly detail: ExecutionTextKey;
  readonly next: ExecutionTextKey;
}

const PRESENTATION: Record<ExecutionFailureCause, Omit<ExecutionFailureView, 'cause'>> = {
  workspace_busy: {
    title: 'executionFailureWorkspaceBusy',
    detail: 'executionFailureWorkspaceBusyDetail',
    next: 'executionFailureWorkspaceBusyNext',
  },
  preflight_limit: {
    title: 'executionFailurePreflightLimit',
    detail: 'executionFailurePreflightLimitDetail',
    next: 'executionFailurePreflightLimitNext',
  },
  preflight_link: {
    title: 'executionFailurePreflightLink',
    detail: 'executionFailurePreflightLinkDetail',
    next: 'executionFailurePreflightLinkNext',
  },
  tool_missing: {
    title: 'executionFailureToolMissing',
    detail: 'executionFailureToolMissingDetail',
    next: 'executionFailureToolMissingNext',
  },
  browser_missing: {
    title: 'executionFailureBrowserMissing',
    detail: 'executionFailureBrowserMissingDetail',
    next: 'executionFailureBrowserMissingNext',
  },
  browser_start: {
    title: 'executionFailureBrowserStart',
    detail: 'executionFailureBrowserStartDetail',
    next: 'executionFailureBrowserStartNext',
  },
  browser_action: {
    title: 'executionFailureBrowserAction',
    detail: 'executionFailureBrowserActionDetail',
    next: 'executionFailureBrowserActionNext',
  },
  readiness: {
    title: 'executionFailureReadiness',
    detail: 'executionFailureReadinessDetail',
    next: 'executionFailureReadinessNext',
  },
  permission: {
    title: 'executionFailurePermission',
    detail: 'executionFailurePermissionDetail',
    next: 'executionFailurePermissionNext',
  },
  command: {
    title: 'executionFailureCommand',
    detail: 'executionFailureCommandDetail',
    next: 'executionFailureCommandNext',
  },
  timeout: {
    title: 'executionFailureTimeout',
    detail: 'executionFailureTimeoutDetail',
    next: 'executionFailureTimeoutNext',
  },
  request: {
    title: 'executionFailureRequest',
    detail: 'executionFailureRequestDetail',
    next: 'executionFailureRequestNext',
  },
  unknown: {
    title: 'executionFailureUnknown',
    detail: 'executionFailureUnknownDetail',
    next: 'executionFailureUnknownNext',
  },
};

function failureCause(job: ProjectExecSummary): ExecutionFailureCause {
  const message = job.message;
  if (message.startsWith('[WORKSPACE_OPERATION_WAIT_TIMEOUT]')) return 'workspace_busy';
  if (
    /^\[EXECUTION_PREFLIGHT_(?:ENTRY|TIME|DEPTH)_LIMIT\]/.test(message) ||
    message ===
      'The execution link inspection exceeded its bounded limit. Use a smaller workspace.' ||
    message === 'The execution link inspection depth limit was exceeded.'
  )
    return 'preflight_limit';
  if (
    message.startsWith(
      'Project execution requires hard-link aliases to remain inside the workspace',
    ) ||
    message === 'A linked file changed during execution inspection. Retry.' ||
    message === 'The execution directory changed.'
  )
    return 'preflight_link';
  if (message.startsWith('[browser_missing]')) return 'browser_missing';
  if (
    message.startsWith('[browser_permission_denied]') ||
    [
      'READ_ONLY_MODE_ENABLED',
      'REFERENCE_NOT_ALLOWED',
      'PATH_OUTSIDE_WORKSPACE',
      'PATH_DENIED',
    ].includes(job.error_code ?? '')
  )
    return 'permission';
  if (message.startsWith('[browser_launch_timeout]')) return 'timeout';
  if (/^\[browser_(?:launch_failed|disconnected)\]/.test(message)) return 'browser_start';
  if (
    /^A trusted [A-Za-z0-9_-]+ executable was not found on ChatSplice's PATH\.$/.test(message) ||
    message === 'A trusted real Rust toolchain executable was not found.'
  )
    return 'tool_missing';
  if (job.state === 'timed_out') return 'timeout';
  if (job.exit_code !== null && job.exit_code !== 0) {
    if (job.operation.kind === 'readiness') return 'readiness';
    return job.operation.kind === 'browser' && job.operation.action.kind !== 'setup'
      ? 'browser_action'
      : 'command';
  }
  if (job.error_code === 'BAD_REQUEST') return 'request';
  return 'unknown';
}

/** Summary evidence only: no log scraping, model call, network call, or automatic retry. */
export function executionFailureView(job: ProjectExecSummary): ExecutionFailureView | null {
  if (job.state !== 'failed' && job.state !== 'timed_out') return null;
  const cause = failureCause(job);
  if (cause === 'preflight_limit') {
    if (job.message.startsWith('[EXECUTION_PREFLIGHT_ENTRY_LIMIT]')) {
      return {
        cause,
        title: PRESENTATION[cause].title,
        detail: 'executionFailureEntryLimitDetail',
        next: 'executionFailureEntryLimitNext',
      };
    }
    if (job.message.startsWith('[EXECUTION_PREFLIGHT_TIME_LIMIT]')) {
      return {
        cause,
        title: PRESENTATION[cause].title,
        detail: 'executionFailureTimeLimitDetail',
        next: 'executionFailureTimeLimitNext',
      };
    }
    if (
      job.message.startsWith('[EXECUTION_PREFLIGHT_DEPTH_LIMIT]') ||
      job.message === 'The execution link inspection depth limit was exceeded.'
    ) {
      return {
        cause,
        title: PRESENTATION[cause].title,
        detail: 'executionFailureDepthLimitDetail',
        next: 'executionFailureDepthLimitNext',
      };
    }
  }
  return { cause, ...PRESENTATION[cause] };
}

export function executionFailureTitle(cause: ExecutionFailureCause): ExecutionTextKey {
  return PRESENTATION[cause].title;
}

/** A browser/request policy is not measured traffic or evidence of a network denial. */
export function executionNetworkKey(job: ProjectExecSummary): ExecutionTextKey {
  if (job.operation.kind === 'environment') return 'executionNetworkNone';
  if (job.operation.kind === 'cargo') return 'executionNetworkCargoLocal';
  if (job.operation.kind === 'install') return 'executionNetworkEnabled';
  if (job.operation.kind === 'shell') {
    return job.operation.network === 'local' ? 'executionNetworkLocal' : 'executionNetworkEnabled';
  }
  if (job.operation.kind === 'browser') {
    return job.operation.action.kind === 'setup'
      ? 'executionNetworkEnabled'
      : 'executionNetworkLocal';
  }
  if (job.operation.kind === 'readiness' || job.operation.kind === 'node_script')
    return 'executionNetworkLocal';
  return 'executionNetworkOffline';
}

export function retainedWorkspaceExecutions(
  jobs: readonly ProjectExecSummary[] | undefined,
  workspaceId: string,
): ProjectExecSummary[] {
  const seen = new Set<string>();
  return (jobs ?? [])
    .filter((job) => job.workspace_id === workspaceId)
    .slice()
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .filter((job) => {
      if (seen.has(job.job_id)) return false;
      seen.add(job.job_id);
      return true;
    })
    .slice(0, 100);
}

export interface ExecutionFailureGroup {
  readonly cause: ExecutionFailureCause;
  readonly count: number;
}

export function groupExecutionFailures(
  jobs: readonly ProjectExecSummary[],
): ExecutionFailureGroup[] {
  const groups = new Map<ExecutionFailureCause, number>();
  for (const job of jobs) {
    const failure = executionFailureView(job);
    if (failure !== null) groups.set(failure.cause, (groups.get(failure.cause) ?? 0) + 1);
  }
  return [...groups]
    .map(([cause, count]) => ({ cause, count }))
    .sort((left, right) => right.count - left.count || left.cause.localeCompare(right.cause));
}

export function filterExecutionFailures(
  jobs: readonly ProjectExecSummary[],
  filter: ExecutionFailureFilter,
): ProjectExecSummary[] {
  return jobs.filter((job) => {
    if (filter === 'all') return true;
    const failure = executionFailureView(job);
    return failure !== null && (filter === 'failed' || failure.cause === filter);
  });
}
