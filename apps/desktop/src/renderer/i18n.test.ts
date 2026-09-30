import { describe, expect, it } from 'vitest';

import { isUiLocale, systemUiLocale, uiText } from './i18n.js';

describe('renderer i18n', () => {
  it('uses English on non-Korean systems while retaining Korean as an explicit option', () => {
    expect(systemUiLocale('en-US')).toBe('en');
    expect(systemUiLocale('fr-FR')).toBe('en');
    expect(systemUiLocale('ko-KR')).toBe('ko');
    expect(isUiLocale('en')).toBe(true);
    expect(isUiLocale('ko')).toBe(true);
    expect(isUiLocale('ja')).toBe(false);
    expect(uiText('en', 'newChat')).toBe('New chat');
    expect(uiText('ko', 'newChat')).toBe('새 채팅');
  });

  it('interpolates values without changing the localized template', () => {
    expect(uiText('en', 'workspaceAdded', { name: 'api' })).toBe('Added api.');
    expect(uiText('ko', 'workspaceAdded', { name: 'api' })).toBe('api 프로젝트를 추가했습니다.');
  });

  it('keeps message-level MCP guidance clear in both locales', () => {
    expect(uiText('en', 'localMcpSelectionGuide')).toContain('@ menu');
    expect(uiText('en', 'localMcpSelectionGuide')).toContain('typing the name alone');
    expect(uiText('ko', 'localMcpSelectionGuide')).toContain('@ 목록');
    expect(uiText('ko', 'localMcpSelectionGuide')).toContain('이름만 입력하면');
    expect(uiText('en', 'tunnelCheckPassed')).toContain('current ChatGPT message');
    expect(uiText('ko', 'tunnelCheckPassed')).toContain('현재 ChatGPT 메시지');
  });

  it('injects the configured ChatGPT app name into guidance', () => {
    expect(uiText('en', 'autoAttachTitle')).toBe('Auto-attach ChatSplice MCP');
    expect(uiText('en', 'autoAttachTitle', { app: 'Local MCP' })).toBe('Auto-attach Local MCP');
    expect(uiText('ko', 'autoAttachTitle', { app: 'Local MCP' })).toBe('Local MCP 자동 첨부');
  });

  it('separates workspace registration from per-message Local MCP selection', () => {
    expect(uiText('en', 'localConnectionHelp')).toContain('registering a project');
    expect(uiText('ko', 'localConnectionHelp')).toContain('프로젝트를 등록');
  });

  it('explains how to recover an unreadable saved runtime key', () => {
    expect(uiText('en', 'runtimeKeyUnreadable')).toContain('Replace');
    expect(uiText('ko', 'runtimeKeyUnreadable')).toContain('교체');
  });

  it('does not ask macOS users to manage a tunnel-client path', () => {
    expect(uiText('en', 'tunnelConfigurationRequired')).not.toContain('path');
    expect(uiText('ko', 'tunnelConfigurationRequired')).not.toContain('경로');
    expect(uiText('en', 'tunnelClientPathRequired')).toContain('full path');
    expect(uiText('ko', 'tunnelClientPathRequired')).toContain('전체 경로');
  });

  it('does not present the local Project flag as remote verification', () => {
    expect(uiText('en', 'registered')).toBe('Instructions marked saved');
    expect(uiText('ko', 'registered')).toBe('지침 저장 표시됨');
    expect(uiText('en', 'projectMarkedConnected', { name: 'api' })).toContain('saved locally');
    expect(uiText('ko', 'projectMarkedConnected', { name: 'api' })).toContain('로컬에서');
    expect(uiText('en', 'projectConnectionSummary')).toContain('can’t verify');
    expect(uiText('ko', 'projectConnectionSummary')).toContain('확인할 수 없어요');
    expect(uiText('en', 'helpStatusBody')).toContain('remote instructions');
    expect(uiText('ko', 'helpStatusBody')).toContain('원격 지침');
  });

  it('tells users to replace updated Project instructions instead of appending duplicates', () => {
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('replace the previous text');
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('BEGIN marker');
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('old copy has no markers');
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('Do not append duplicates');
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('entire field');
    expect(uiText('ko', 'projectInstructionsPrompt')).toContain(
      'ChatSplice BEGIN 표시부터 END 표시까지',
    );
    expect(uiText('ko', 'projectInstructionsPrompt')).toContain('예전 복사본에 표시가 없으면');
    expect(uiText('ko', 'projectInstructionsPrompt')).toContain('중복 추가하지 마세요');
    expect(uiText('ko', 'projectInstructionsPrompt')).toContain('전체 입력란 기준');
  });

  it('requires a new Project chat after Project instructions change', () => {
    expect(uiText('en', 'projectInstructionsPrompt')).toContain('start a new chat');
    expect(uiText('ko', 'projectInstructionsPrompt')).toContain('새 채팅');
    expect(uiText('en', 'projectChatRefreshBody')).toContain('existing conversation');
    expect(uiText('en', 'projectChatRefreshBody')).not.toContain('paste');
    expect(uiText('ko', 'projectChatRefreshBody')).toContain('기존 대화');
    expect(uiText('ko', 'projectChatRefreshBody')).toContain('붙여 넣지');
    expect(uiText('en', 'projectInstructionsUpdated')).toContain('new chat');
    expect(uiText('ko', 'projectInstructionsUpdated')).toContain('새 채팅');
  });
});
