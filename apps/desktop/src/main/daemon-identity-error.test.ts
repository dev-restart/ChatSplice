import { describe, expect, it } from 'vitest';
import { assertDaemonToolSchemaCompatibility, IncompatibleDaemonError } from './daemon-client.js';

describe('owner runtime mismatch details', () => {
  it('shows only bounded identity fields and never reflects server credentials or control text', () => {
    const error = new IncompatibleDaemonError('Mismatch', {
      protocol_version: 4,
      execution_contract: 'old-runtime',
      build_id: 'a'.repeat(64),
      run_id: '00000000-0000-4000-8000-000000000000',
      tool_count: 22,
      credential: 'private-value',
      workspace_binding: 'private-binding',
      tool_schema_digest: 'malformed\nsecret',
    });
    expect(error.runtimeDetails).toContain('execution_contract: old-runtime');
    expect(error.runtimeDetails).toContain(`build_id: ${'a'.repeat(64)}`);
    expect(error.runtimeDetails).toContain('tool_count: 22');
    expect(error.runtimeDetails).not.toContain('private-value');
    expect(error.runtimeDetails).not.toContain('private-binding');
    expect(error.runtimeDetails).not.toContain('malformed');
  });
  it('does not reflect an invalid expected schema digest in mismatch details', () => {
    const error = new IncompatibleDaemonError('Mismatch', undefined, 'private\nschema');
    expect(error.runtimeDetails).not.toContain('private');
    expect(error.runtimeDetails).not.toContain('Expected tool_schema_digest');
  });
});

describe('daemon tool schema compatibility', () => {
  const expected = {
    status: 'verified' as const,
    expected_tool_schema_digest: 'a'.repeat(64),
  };

  it('accepts matching schemas without enforcing daemon build identity', () => {
    const daemon = { tool_schema_digest: 'a'.repeat(64), build_id: 'b'.repeat(64) };
    expect(() => assertDaemonToolSchemaCompatibility(daemon, expected)).not.toThrow();
  });

  it('reports both verified schema digests on a mismatch', () => {
    let caught: unknown;
    try {
      assertDaemonToolSchemaCompatibility({ tool_schema_digest: 'b'.repeat(64) }, expected);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IncompatibleDaemonError);
    expect(caught).toMatchObject({
      message: expect.stringContaining('different tool schema'),
      runtimeDetails: expect.stringContaining(`Expected tool_schema_digest: ${'a'.repeat(64)}`),
    });
    expect((caught as IncompatibleDaemonError).runtimeDetails).toContain(
      `tool_schema_digest: ${'b'.repeat(64)}`,
    );
  });

  it.each(['missing', 'changed', 'invalid'] as const)(
    'keeps %s desktop metadata in the existing unverified flow',
    (status) => {
      expect(() =>
        assertDaemonToolSchemaCompatibility(
          { tool_schema_digest: 'b'.repeat(64) },
          { ...expected, status },
        ),
      ).not.toThrow();
    },
  );

  it('does not infer a schema mismatch from missing metadata', () => {
    expect(() => assertDaemonToolSchemaCompatibility({}, expected)).not.toThrow();
    expect(() =>
      assertDaemonToolSchemaCompatibility({ tool_schema_digest: 'b'.repeat(64) }, undefined),
    ).not.toThrow();
    expect(() =>
      assertDaemonToolSchemaCompatibility(
        { tool_schema_digest: 'b'.repeat(64) },
        { ...expected, expected_tool_schema_digest: null },
      ),
    ).not.toThrow();
  });
});
