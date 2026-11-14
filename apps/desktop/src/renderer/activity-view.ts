import type { DirectMcpActivity, ProjectExecState, ProjectExecSummary } from '@chatsplice/protocol';

import type { Translate } from './appearance.js';
import type { UiLocale } from './i18n.js';

// Pure selectors and status labels for the sidebar's per-project MCP/execution
// activity display. App.svelte passes daemon state slices in; nothing here
// reads component state directly, so each function is independently testable.

export function selectWorkspaceMcpActivities(
  activities: DirectMcpActivity[] | undefined,
  workspaceId: string,
): DirectMcpActivity[] {
  return (activities ?? []).filter((activity) => activity.workspace_id === workspaceId);
}

export function selectLatestMcpActivity(
  activities: DirectMcpActivity[] | undefined,
  workspaceId: string,
): DirectMcpActivity | undefined {
  const matches = selectWorkspaceMcpActivities(activities, workspaceId);
  return matches.find((activity) => activity.state === 'running') ?? matches[0];
}

export function selectWorkspaceExecutionJobs(
  jobs: ProjectExecSummary[] | undefined,
  workspaceId: string,
): ProjectExecSummary[] | undefined {
  return jobs?.filter((job) => job.workspace_id === workspaceId);
}

export function selectLatestExecutionJob(
  jobs: ProjectExecSummary[] | undefined,
  workspaceId: string,
): ProjectExecSummary | undefined {
  const matches = selectWorkspaceExecutionJobs(jobs, workspaceId);
  if (matches === undefined) return undefined;
  return (
    matches.find(
      (job) => job.state === 'queued' || job.state === 'running' || job.state === 'cancelling',
    ) ?? matches[0]
  );
}

export function executionStateLabel(t: Translate, state: ProjectExecState): string {
  if (state === 'queued') return t('executionQueued');
  if (state === 'running') return t('executionRunning');
  if (state === 'cancelling') return t('executionCancelling');
  if (state === 'succeeded') return t('executionSucceeded');
  if (state === 'failed') return t('executionFailed');
  if (state === 'cancelled') return t('executionCancelled');
  return t('executionTimedOut');
}

export function formatActivityTime(locale: UiLocale, value: string): string {
  return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function activityStateLabel(t: Translate, activity: DirectMcpActivity): string {
  if (activity.tool === 'local.prepare_apply') {
    if (activity.state === 'failed') return t('recentApplyRequestFailed');
    if (activity.state === 'running') return t('applyRequestInProgress');
    return t('recentApplyRequest');
  }
  const localApply = activity.source === 'local_apply';
  if (activity.state === 'failed') {
    return localApply ? t('recentApplyFailed') : t('recentMcpFailed');
  }
  if (activity.state === 'succeeded') {
    if (localApply) {
      return activity.tool === 'project.run'
        ? t('recentCheckSucceeded')
        : t('recentApplySucceeded');
    }
    if (activity.tool.startsWith('fs.reference_')) return t('recentReferenceSucceeded');
    if (activity.tool === 'fs.list' || activity.tool === 'fs.search') {
      return t('recentDiscoverySucceeded');
    }
    if (activity.tool === 'fs.read') return t('recentReadSucceeded');
    return activity.tool === 'project.run' ? t('recentCheckSucceeded') : t('recentEditSucceeded');
  }
  if (localApply)
    return activity.tool === 'project.run' ? t('localCheckInProgress') : t('localApplyInProgress');
  if (
    activity.tool === 'fs.reference_list' ||
    activity.tool === 'fs.reference_paths' ||
    activity.tool === 'fs.reference_search'
  ) {
    return t('mcpReferenceDiscoveryInProgress');
  }
  if (activity.tool === 'fs.reference_read') return t('mcpReferenceReadInProgress');
  if (activity.tool === 'fs.list' || activity.tool === 'fs.search') {
    return t('mcpDiscoveryInProgress');
  }
  if (activity.tool === 'fs.read') return t('mcpReadInProgress');
  if (activity.tool === 'project.run') return t('mcpCheckInProgress');
  return t('mcpEditInProgress');
}

export function workspaceMcpState(
  t: Translate,
  locale: UiLocale,
  activities: DirectMcpActivity[] | undefined,
  workspaceId: string,
): {
  label: string;
  shortLabel: string;
  tone: 'running' | 'succeeded' | 'failed';
} | null {
  const directActivity = selectLatestMcpActivity(activities, workspaceId);
  if (directActivity === undefined) return null;
  const stateLabels = {
    running: { tone: 'running' },
    succeeded: { tone: 'succeeded' },
    failed: { tone: 'failed' },
  } as const;
  return {
    label: t('recentMcpRecord', {
      tool: directActivity.tool,
      summary: directActivity.summary,
      time: formatActivityTime(locale, directActivity.completed_at ?? directActivity.started_at),
    }),
    shortLabel: activityStateLabel(t, directActivity),
    ...stateLabels[directActivity.state],
  };
}
