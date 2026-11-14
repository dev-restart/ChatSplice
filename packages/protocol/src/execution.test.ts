import { describe, expect, it } from 'vitest';
import { ProjectExecInputSchema, ProjectExecCancelInputSchema } from './execution.js';

const input = {
  workspace_id: `ws_${'a'.repeat(24)}`,
  workspace_binding: `wb_${'a'.repeat(64)}`,
  request_id: 'request_001',
  operation: { kind: 'cargo', task: 'check' },
};

describe('model-free execution boundary', () => {
  it('accepts explicit structured operations but rejects shell, env, argv and model overrides', () => {
    expect(ProjectExecInputSchema.parse(input).cwd).toBe('.');
    for (const extra of [
      { command: 'echo arbitrary' },
      { env: { PATH: '/tmp' } },
      { argv: ['--unsafe'] },
      { model: 'anything' },
    ]) {
      expect(ProjectExecInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(
      ProjectExecInputSchema.safeParse({
        ...input,
        operation: { kind: 'install', ecosystem: 'system' },
      }).success,
    ).toBe(false);
  });
  it('requires exact binding and rejects absolute/traversal working directories', () => {
    expect(
      ProjectExecInputSchema.safeParse({ ...input, workspace_binding: undefined }).success,
    ).toBe(false);
    for (const cwd of ['/tmp', '../other', 'src/../other', 'C:\\repo', 'src\\other']) {
      expect(ProjectExecInputSchema.safeParse({ ...input, cwd }).success).toBe(false);
    }
    expect(ProjectExecInputSchema.parse({ ...input, cwd: 'apps/frontend' }).cwd).toBe(
      'apps/frontend',
    );
    expect(
      ProjectExecCancelInputSchema.safeParse({
        workspace_id: input.workspace_id,
        job_id: `exec_${'a'.repeat(36)}`,
      }).success,
    ).toBe(false);
  });
});
