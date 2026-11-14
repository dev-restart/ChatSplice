import { describe, expect, it } from 'vitest';

import { ProjectBrowserActionSchema } from './browser.js';
import { projectBindingText } from './project-instructions.js';

describe('browser assertion contract', () => {
  it.each([
    { kind: 'visible', selector: '#result' },
    { kind: 'hidden', selector: '#spinner' },
    { kind: 'text', selector: '#result', text: 'Saved', exact: true },
    { kind: 'value', selector: '#name', value: 'demo' },
    { kind: 'url', url: 'http://127.0.0.1:5173/done' },
  ])('accepts a bounded $kind expectation', (expectation) => {
    expect(
      ProjectBrowserActionSchema.parse({ kind: 'assert', expectation, timeout_ms: 1000 }),
    ).toMatchObject({ kind: 'assert', expectation });
  });

  it.each([
    { kind: 'assert', expectation: { kind: 'url', url: 'https://chatgpt.com/' } },
    { kind: 'assert', expectation: { kind: 'visible' } },
    { kind: 'assert', expectation: { kind: 'text', selector: '#x' } },
    { kind: 'assert', expectation: { kind: 'value', selector: '#x', value: 'x'.repeat(4001) } },
    { kind: 'assert', expectation: { kind: 'visible', selector: '#x' }, timeout_ms: 10001 },
    { kind: 'assert', expectation: { kind: 'visible', selector: '#x', script: 'alert(1)' } },
  ])('rejects invalid, external or executable assertions', (value) => {
    expect(ProjectBrowserActionSchema.safeParse(value).success).toBe(false);
  });
});

describe('web agent workflow instructions', () => {
  it('requires outcome verification and safe resumption without another model', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      `wb_${'a'.repeat(64)}`,
      'Fixture',
    );
    expect(text).toContain('UI: browser open observed loopback URL');
    expect(text).toContain('Click success is not journey success');
    expect(text).toContain('docs/agent-progress.md');
    expect(text).toContain('Recheck files/job IDs on resume');
    expect(text).toContain('Use local managers/locks for required installs');
    expect(text).toContain('no separate Pi/Codex model or coding worker is started');
    expect(text).toContain('disable a sandbox after permission denial');
  });

  it('uses explicit Goals with revision guards and current evidence before completion', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      `wb_${'a'.repeat(64)}`,
      'Fixture',
    );
    expect(text).toContain('Goals only when users request Goal/task tracking');
    expect(text).toContain('project.goal_update');
    expect(text).toContain('criterion_id on project.exec');
    expect(text).toContain('verify_file reads current SHA');
    expect(text).toContain('expected_revision');
    expect(text).toContain('before explicit resume');
    expect(text).toContain('rerun stale checks');
    expect(text).toContain('current required evidence and terminal owned jobs');
    expect(text).toContain('No automatic new GPT turn');
  });
});
