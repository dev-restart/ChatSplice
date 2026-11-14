import { describe, expect, it } from 'vitest';

import {
  projectInstructionsUpdateIssueMessage,
  workspaceProjectState,
} from './project-automation.js';

const t = (key: string): string => key;
const base = {
  workspaceId: 'w1',
  automationIssueWorkspaceId: undefined,
  chatRefreshWorkspaceId: '',
  hasConfirmedTab: false,
  setupWorkspaceId: '',
};

describe('workspaceProjectState', () => {
  it('reports a failure only while the project is not confirmed', () => {
    expect(workspaceProjectState(t, { ...base, automationIssueWorkspaceId: 'w1' })).toEqual({
      label: 'automaticSetupFailed',
      tone: 'failed',
    });
  });

  it('lets a confirmed tab outrank a stale automation failure', () => {
    expect(
      workspaceProjectState(t, {
        ...base,
        automationIssueWorkspaceId: 'w1',
        hasConfirmedTab: true,
      }),
    ).toEqual({ label: 'registered', tone: 'ready' });
  });

  it('ignores failures that belong to another workspace', () => {
    expect(workspaceProjectState(t, { ...base, automationIssueWorkspaceId: 'w2' })).toEqual({
      label: 'setupRequired',
      tone: 'pending',
    });
  });

  it('keeps a fresh instruction verification issue visible over older confirmations', () => {
    expect(
      workspaceProjectState(t, {
        ...base,
        automationIssueWorkspaceId: 'w1',
        instructionVerificationRequired: true,
        hasConfirmedTab: true,
      }),
    ).toEqual({ label: 'projectInstructionsVerificationRequired', tone: 'pending' });
  });

  it('does not apply another workspace instruction issue to a connected project', () => {
    expect(
      workspaceProjectState(t, {
        ...base,
        automationIssueWorkspaceId: 'w2',
        instructionVerificationRequired: true,
        hasConfirmedTab: true,
      }),
    ).toEqual({ label: 'registered', tone: 'ready' });
  });

  it('explains how to verify a retained Project home', () => {
    expect(projectInstructionsUpdateIssueMessage(t, 'project_home_required')).toBe(
      'projectInstructionsHomeRequired',
    );
  });
});
