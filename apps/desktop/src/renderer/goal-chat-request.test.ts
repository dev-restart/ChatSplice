import { describe, expect, it } from 'vitest';

import {
  GOAL_CHAT_REQUEST_MAX_LENGTH,
  goalChatRequest,
  goalContinueRequest,
} from './goal-chat-request.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const goal = {
  workspace_id: workspaceId,
  goal_id: 'goal_11111111-1111-4111-8111-111111111111',
  objective: 'Finish the settings page',
  state: 'active' as const,
  root_matches: true,
  checkpoint: {
    summary: 'Saved the form.',
    next_step: 'Check that save persists after reload.',
    files: [],
    saved_at: '2026-10-20T00:00:00.000Z',
  },
};

function requestData(request: string): unknown {
  const start = request.indexOf('\n{');
  const end = request.indexOf('\n\n1.', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(request.slice(start + 1, end));
}

describe('Goal chat handoff', () => {
  it('keeps the user request as bounded JSON data with only the selected workspace', () => {
    const objective = '설정 화면을 개선해 주세요.\n"다음 단계": 저장 확인 <script>';
    const request = goalChatRequest(workspaceId, `  ${objective}  `, 'ko');
    expect(requestData(request)).toEqual({ workspace_id: workspaceId, request: objective });
    expect(request).toContain('project.goal_update(create)');
    expect(request).toContain('파일 존재만으로 동작 성공을 판정하지');
    expect(request).not.toContain('workspace_binding');
    expect(request).not.toContain('expected_revision:');
  });

  it('rejects empty, oversized or unbound requests instead of generating an executable handoff', () => {
    for (const objective of ['', ' \n ', 'x'.repeat(GOAL_CHAT_REQUEST_MAX_LENGTH + 1)])
      expect(goalChatRequest(workspaceId, objective, 'en')).toBe('');
    for (const workspace of ['', 'wrong-project', `${workspaceId}\n`])
      expect(goalChatRequest(workspace, 'Update the page', 'en')).toBe('');
    const maximum = goalChatRequest(workspaceId, 'x'.repeat(GOAL_CHAT_REQUEST_MAX_LENGTH), 'en');
    expect(maximum).not.toBe('');
    expect(maximum.length).toBeLessThan(8_000);
  });

  it('provides English creation instructions without promising another automatic turn', () => {
    const request = goalChatRequest(workspaceId, 'Finish this feature', 'en');
    expect(request).toContain('Register this task as a Goal');
    expect(request).toContain('do not promise to start a new ChatGPT turn automatically');
    expect(request).toContain('do not claim registration');
    expect(request).toContain('follow next_offset while has_more is true');
  });

  it('targets a saved Goal and next step while requiring a fresh read, not a copied revision', () => {
    const request = goalContinueRequest(workspaceId, goal, 'ko');
    expect(requestData(request)).toEqual({
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      objective: goal.objective,
      saved_next_step: goal.checkpoint.next_step,
    });
    expect(request).toContain('최신 expected_revision');
    expect(request).toContain('pause → 최신 Goal 조회 → resume');
    expect(request).toContain('max_executions: 0');
    expect(request).toContain('누적 횟수와 보관된 receipt 개수는 서로 다릅니다');
    expect(request).not.toContain('128회');
    expect(request).not.toContain('workspace_binding');
  });

  it('preserves an existing unlimited budget without treating omission as a budget change', () => {
    const korean = goalContinueRequest(workspaceId, { ...goal, state: 'paused' }, 'ko');
    expect(korean).toContain('저장값이 이미 0이면 resume에서 max_executions를 생략');
    expect(korean).toContain('생략은 양수 예산도 그대로 보존');
    expect(korean).toContain('새 대화에서 확인');
    const english = goalContinueRequest(workspaceId, { ...goal, state: 'paused' }, 'en');
    expect(english).toContain('When the stored value is already 0, omit max_executions');
    expect(english).toContain('removing a positive budget requires explicit max_executions: 0');
    expect(english).toContain('check them in a new conversation');
  });

  it('allows explicit continuation from paused or interrupted records', () => {
    for (const state of ['active', 'paused', 'interrupted'] as const)
      expect(goalContinueRequest(workspaceId, { ...goal, state }, 'en')).toContain(goal.goal_id);
  });

  it('does not produce a continuation for terminal, cancelling, moved or foreign Goals', () => {
    for (const state of ['completed', 'cancelled', 'cancelling'] as const)
      expect(goalContinueRequest(workspaceId, { ...goal, state }, 'ko')).toBe('');
    expect(goalContinueRequest(workspaceId, { ...goal, root_matches: false }, 'ko')).toBe('');
    expect(goalContinueRequest(`ws_${'b'.repeat(24)}`, goal, 'ko')).toBe('');
    expect(goalContinueRequest(workspaceId, { ...goal, goal_id: 'invalid' }, 'ko')).toBe('');
  });

  it('bounds optional checkpoint context without copying receipts, paths or revisions', () => {
    const request = goalContinueRequest(
      workspaceId,
      {
        ...goal,
        objective: 'x'.repeat(4_000),
        checkpoint: { ...goal.checkpoint, next_step: 'y'.repeat(3_000) },
      },
      'en',
    );
    expect(requestData(request)).toEqual({
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      objective: 'x'.repeat(2_000),
      saved_next_step: 'y'.repeat(1_000),
    });
    expect(request.length).toBeLessThan(8_000);
    expect(
      requestData(goalContinueRequest(workspaceId, { ...goal, checkpoint: null }, 'en')),
    ).toEqual({
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      objective: goal.objective,
      saved_next_step: '',
    });
  });
});
