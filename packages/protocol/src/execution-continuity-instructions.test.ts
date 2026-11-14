import { describe, expect, it } from 'vitest';

import { projectBindingText } from './project-instructions.js';

const workspaceId = 'ws_0123456789abcdef01234567';
const binding = 'wb_' + 'a'.repeat(64);

describe('owned execution continuity instructions', () => {
  it('uses returned jobs and endpoint evidence instead of requiring a host process listing', () => {
    const text = projectBindingText(workspaceId, binding, 'demo-project');
    expect(text).toContain('Keep job_id');
    expect(text).toContain('project.await_exec timeout_ms:0');
    expect(text).toContain('readiness: loopback HEAD');
    expect(text).toContain('Await foreground completion; inspect exit_code/output/truncation');
    expect(text).toContain('Never resubmit running jobs');
    expect(text).toContain('project.cancel_exec then await cleanup; no rollback');
    expect(text).toContain('No automatic shell retry');
    expect(text).toContain('Cargo checks: offline dependencies, loopback tests');
    expect(text).toContain('Fixtures: TMPDIR');
    expect(text).toContain('not runtime capabilities');
  });

  it('keeps an optional local permission error separate from model refusal and task completion', () => {
    const text = projectBindingText(workspaceId, binding, 'demo-project');
    expect(text).toContain('EPERM: local error, not model refusal');
    expect(text).toContain('Optional ps failure must not block other work');
    expect(text).toContain('Never print credentials or disable a sandbox after permission denial');
    expect(text).toContain('Report failed/unrun checks separately');
    expect(text).toContain('Complete needs current required evidence and terminal owned jobs');
    expect(text).toContain('no separate Pi/Codex model or coding worker is started');
  });
});
