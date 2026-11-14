import { describe, expect, it } from 'vitest';

import { projectBindingText } from './project-instructions.js';

const workspaceId = 'ws_0123456789abcdef01234567';
const binding = 'wb_' + 'a'.repeat(64);

describe('natural-language Goal workflow instructions', () => {
  it('routes explicit Goal requests through project discovery and persistent creation', () => {
    const text = projectBindingText(workspaceId, binding, 'demo-project');
    expect(text).toContain('Goals only when users request Goal/task tracking');
    expect(text).toContain('A plain-language objective suffices');
    expect(text).toContain(
      'read project.goal and inspect relevant files/manifests/scripts before project.goal_update create',
    );
    expect(text).toContain('concrete tracked files and verifiable criteria');
    expect(text).toContain('no manual-path request or placeholders');
    expect(text).toContain('Scope/tracked files/criteria are immutable');
    expect(text).toContain('reuse the requested saved Goal');
    expect(text).toContain('recheck files before explicit resume');
  });

  it('requires evidence, a saved next step and honest tool availability during continuation', () => {
    const text = projectBindingText(workspaceId, binding, 'demo-project');
    expect(text).toContain('implement/test/repair within Goal scope/budget');
    expect(text).toContain('Before pause/turn end, project.goal_update checkpoint');
    expect(text).toContain('summary (include blockers) and next_step with fresh expected_revision');
    expect(text).toContain('Complete needs current required evidence and terminal owned jobs');
    expect(text).toContain('Await existing jobs');
    expect(text).toContain('rerun stale checks');
    expect(text).toContain('Missing Goal tools: report the gap');
    expect(text).toContain('No registration/completion claim without successful result');
    expect(text).toContain('No automatic new GPT turn');
    expect(text).toContain('no separate Pi/Codex model or coding worker is started');
    expect(text).toContain('Scan Tools refreshes schemas; new code needs an app/daemon restart');
  });

  it('fits the project instruction field with maximum escaped labels and preserves the binding', () => {
    const text = projectBindingText(workspaceId, binding, '\\"'.repeat(60), 'a'.repeat(40));
    expect(text.length).toBeLessThan(6_000);
    expect(text).toContain(`- workspace_id: ${workspaceId}`);
    expect(text).toContain(`- workspace_binding: ${binding}`);
    expect(text).toContain('Keep the source binding');
    expect(text).toContain('No automatic new GPT turn');
    expect(text).toContain('--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---');
  });
});
