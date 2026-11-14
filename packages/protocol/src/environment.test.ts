import { describe, expect, it } from 'vitest';
import { ProjectExecInputSchema } from './execution.js';

const bound = {
  workspace_id: `ws_${'a'.repeat(24)}`,
  workspace_binding: `wb_${'a'.repeat(64)}`,
  request_id: 'environment-schema-1',
};
describe('bounded environment operation', () => {
  it('accepts only the fixed inspection and existing relative cwd', () => {
    expect(
      ProjectExecInputSchema.parse({
        ...bound,
        cwd: 'apps/web',
        operation: { kind: 'environment' },
      }).operation,
    ).toEqual({ kind: 'environment' });
    for (const operation of [
      { kind: 'environment', command: 'install' },
      { kind: 'environment', install: true },
      { kind: 'environment', background: true },
      { kind: 'environment', paths: ['/private'] },
    ])
      expect(ProjectExecInputSchema.safeParse({ ...bound, operation }).success).toBe(false);
  });
});
