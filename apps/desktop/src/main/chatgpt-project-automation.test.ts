import { describe, expect, it } from 'vitest';

import {
  buildChatGptProjectAutomationScript,
  buildChatGptProjectCreateClickScript,
  buildChatGptProjectInstructionsUpdateScript,
} from './chatgpt-project-automation.js';

const WORKSPACE_ID = 'ws_0123456789abcdef01234567';
const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

describe('ChatGPT Project setup automation', () => {
  it('limits the remote script to the fixed Projects UI flow', () => {
    const createClickSource = buildChatGptProjectCreateClickScript();
    const automation = buildChatGptProjectAutomationScript({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'netring',
      bindingText: `ChatSplice project thread binding:\n- workspace_id: ${WORKSPACE_ID}\n- workspace_binding: ${WORKSPACE_BINDING}`,
    });

    expect(automation.url).toBe('https://chatgpt.com/projects');
    expect(createClickSource).toContain('새 프로젝트');
    expect(createClickSource).toContain('newProject.click()');
    expect(createClickSource).not.toContain('document.cookie');
    expect(createClickSource).not.toContain('localStorage');
    expect(createClickSource).not.toContain('conversation');
    expect(automation.source).toContain('프로젝트 설정');
    expect(automation.source).toContain('workspace_binding');
    expect(automation.source).toContain('findProjectNameInput');
    expect(automation.source).toContain(
      'form[data-testid="create-new-project-form"] input#project-name',
    );
    expect(automation.source).toContain('findProjectInstructionsInput');
    expect(automation.source).toContain("'만들기'");
    expect(automation.source).toContain("'프로젝트 지침'");
    expect(automation.source).toContain('document.activeElement');
    expect(automation.source).toContain('element.click()');
    expect(automation.source).toContain('element.labels');
    expect(automation.source).toContain('aria-labelledby');
    expect(automation.source).toContain('instructions.closest(\'[role="dialog"]\')');
    expect(automation.source).toContain('프로젝트 설정 닫기');
    expect(automation.source).toContain('settingsDialog.isConnected');
    expect(automation.source).not.toContain('instructions.value');
    expect(automation.source).not.toContain('fetch(');
    expect(automation.source).not.toContain('document.cookie');
    expect(automation.source).not.toContain('localStorage');
    expect(automation.source).not.toContain('conversation');
  });

  it('rejects a malformed workspace before generating a remote script', () => {
    expect(() =>
      buildChatGptProjectAutomationScript({
        workspaceId: 'selected-project',
        workspaceName: 'netring',
        bindingText: 'binding',
      }),
    ).toThrow();
  });

  it('migrates both current and legacy Project instruction markers in place', () => {
    const update = buildChatGptProjectInstructionsUpdateScript({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'netring',
      bindingText: `--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS v1 ---\n- workspace_id: ${WORKSPACE_ID}\n- workspace_binding: ${WORKSPACE_BINDING}\n--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---`,
    });

    expect(update.source).toContain('BEGIN CHATSPLICE PROJECT INSTRUCTIONS');
    expect(update.source).toContain('BEGIN LOCALCHAT PROJECT INSTRUCTIONS');
    expect(update.source).toContain('MARKER_PAIRS.find');
  });
});
