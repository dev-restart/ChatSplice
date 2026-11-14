import { describe, expect, it } from 'vitest';

import {
  ProjectExecInputSchema,
  ProjectExecOperationSchema,
  ProjectExecSubmitInputSchema,
} from './execution.js';

describe('explicit locked Cargo cache repair contract', () => {
  const input = {
    workspace_id: 'ws_0123456789abcdef01234567',
    workspace_binding: `wb_${'0'.repeat(64)}`,
    request_id: 'cache_repair_fixture',
  };

  it.each([undefined, 'locked'] as const)(
    'accepts repair for a locked Rust fetch with mode %s',
    (mode) => {
      const operation = {
        kind: 'install',
        ecosystem: 'rust',
        repair_cache: true,
        ...(mode === undefined ? {} : { mode }),
      };
      expect(ProjectExecInputSchema.parse({ ...input, operation }).operation).toEqual(operation);
      expect(
        ProjectExecSubmitInputSchema.parse({
          workspace_id: input.workspace_id,
          request_id: input.request_id,
          operation,
        }).operation,
      ).toEqual(operation);
    },
  );

  it.each([
    { kind: 'install', ecosystem: 'node', repair_cache: true },
    { kind: 'install', ecosystem: 'rust', mode: 'resolve', repair_cache: true },
    { kind: 'install', ecosystem: 'rust', repair_cache: 1 },
    { kind: 'cargo', task: 'test', repair_cache: true },
  ])('rejects repair outside locked Rust install: %j', (operation) => {
    expect(ProjectExecInputSchema.safeParse({ ...input, operation }).success).toBe(false);
    expect(
      ProjectExecSubmitInputSchema.safeParse({
        workspace_id: input.workspace_id,
        request_id: input.request_id,
        operation,
      }).success,
    ).toBe(false);
  });

  it.each(['node', 'rust'] as const)(
    'preserves ordinary %s install semantics without opt-in',
    (ecosystem) => {
      for (const mode of ['locked', 'resolve']) {
        const operation = { kind: 'install', ecosystem, mode };
        expect(ProjectExecOperationSchema.parse(operation)).toEqual(operation);
        expect(ProjectExecOperationSchema.parse({ ...operation, repair_cache: false })).toEqual({
          ...operation,
          repair_cache: false,
        });
      }
    },
  );
});
