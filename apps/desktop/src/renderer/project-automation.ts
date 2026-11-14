import type { ChatGptProjectAutomationResult } from '@chatsplice/protocol';
import type { Translate } from './appearance.js';

export type ProjectAutomationIssueReason = ChatGptProjectAutomationResult['reason'];

export function projectAutomationIssueMessage(
  t: Translate,
  reason: ProjectAutomationIssueReason,
): string {
  if (reason === 'chatgpt_login_required') return t('projectAutomationLoginRequired');
  if (reason === 'create_modal_not_opened') return t('projectAutomationCreateModalNotOpened');
  if (reason === 'chatgpt_ui_changed') return t('projectAutomationUiChanged');
  return t('projectAutomationFailed');
}

export function projectInstructionsUpdateIssueMessage(
  t: Translate,
  reason: ProjectAutomationIssueReason,
): string {
  if (reason === 'project_home_required') return t('projectInstructionsHomeRequired');
  if (reason === 'needs_manual_merge') return t('projectInstructionsAutoMergeFailed');
  if (reason === 'chatgpt_login_required') return t('projectAutomationLoginRequired');
  return t('projectAutomationUiChanged');
}

export interface WorkspaceProjectStateInput {
  workspaceId: string;
  automationIssueWorkspaceId: string | undefined;
  instructionVerificationRequired?: boolean;
  chatRefreshWorkspaceId: string;
  hasConfirmedTab: boolean;
  setupWorkspaceId: string;
}

/**
 * Inputs are pre-resolved values rather than raw controller state so this
 * classifier stays pure: the caller (App.svelte) decides which stores supply
 * each field. A fresh instruction check takes priority over historical tab
 * confirmations; an unrelated stale setup failure still does not hide them.
 */
export function workspaceProjectState(
  t: Translate,
  input: WorkspaceProjectStateInput,
): {
  label: string;
  tone: 'ready' | 'pending' | 'failed';
} {
  if (
    input.automationIssueWorkspaceId === input.workspaceId &&
    input.instructionVerificationRequired
  ) {
    return { label: t('projectInstructionsVerificationRequired'), tone: 'pending' };
  }
  if (input.chatRefreshWorkspaceId === input.workspaceId) {
    return { label: t('projectChatRefreshRequired'), tone: 'pending' };
  }
  if (input.hasConfirmedTab) {
    return { label: t('registered'), tone: 'ready' };
  }
  if (input.automationIssueWorkspaceId === input.workspaceId) {
    return { label: t('automaticSetupFailed'), tone: 'failed' };
  }
  return {
    label:
      input.setupWorkspaceId === input.workspaceId
        ? t('manualSetupInProgress')
        : t('setupRequired'),
    tone: 'pending',
  };
}
