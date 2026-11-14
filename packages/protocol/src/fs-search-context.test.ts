import {
  FsReferenceSearchInputSchema,
  FsSearchInputSchema,
  FsSearchResultSchema,
} from './schemas.js';
import { describe, expect, it } from 'vitest';

const input = {
  workspace_id: `ws_${'0'.repeat(24)}`,
  workspace_binding: `wb_${'0'.repeat(64)}`,
  reference_workspace_id: `ws_${'1'.repeat(24)}`,
  query: 'literal()',
};

describe('optional search context contract', () => {
  it.each([
    ['search', FsSearchInputSchema],
    ['reference search', FsReferenceSearchInputSchema],
  ] as const)(
    '%s keeps a zero default and rejects unbounded or fractional context',
    (_, schema) => {
      expect(schema.parse(input).context_lines).toBe(0);
      expect(schema.parse({ ...input, context_lines: 3 }).context_lines).toBe(3);
      for (const context_lines of [-1, 4, 0.5, '1']) {
        expect(schema.safeParse({ ...input, context_lines }).success).toBe(false);
      }
    },
  );

  it('accepts the old result shape and bounds every optional context array and line', () => {
    const result = {
      workspace_id: input.workspace_id,
      workspace_name: 'fixture',
      path: '.',
      query: 'literal()',
      matches: [{ path: 'sample.ts', line_number: 2, column: 1, line: 'literal()' }],
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      files_scanned: 1,
      bytes_scanned: 20,
      skipped_files: 0,
      truncated: false,
    };
    expect(FsSearchResultSchema.parse(result)).toEqual(result);
    const context = { line_number: 1, line: 'before', truncated: false };
    const withContext = (context_before: unknown[]) => ({
      ...result,
      context_truncated: false,
      matches: [{ ...result.matches[0], context_before, context_after: [] }],
    });
    expect(FsSearchResultSchema.safeParse(withContext([context])).success).toBe(true);
    expect(FsSearchResultSchema.safeParse(withContext(Array(4).fill(context))).success).toBe(false);
    expect(
      FsSearchResultSchema.safeParse(withContext([{ ...context, line: 'x'.repeat(202) }])).success,
    ).toBe(false);
  });
});
