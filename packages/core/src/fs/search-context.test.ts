import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsSearchInputSchema, FsSearchResultSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { searchWorkspaceText } from './discover-workspace.js';

describe('bounded search context', () => {
  let directory: string;
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let bound: { workspace_id: string; workspace_binding: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chatsplice-search-context-'));
    root = join(directory, 'workspace');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    bound = {
      workspace_id: (await service.register({ root_path: root })).workspace_id,
      workspace_binding: `wb_${'0'.repeat(64)}`,
    };
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function search(options: Record<string, unknown> = {}) {
    const result = await searchWorkspaceText(
      service,
      FsSearchInputSchema.parse({ ...bound, query: 'Needle', ...options }),
    );
    return FsSearchResultSchema.parse(result);
  }

  it('preserves the compact default and returns numbered CRLF context only on request', async () => {
    await writeFile(join(root, 'sample.ts'), 'before\r\n\r\nNeedle();\r\nafter\r\n');
    const compact = await search();
    expect(compact.matches).toEqual([
      { path: 'sample.ts', line_number: 3, column: 1, line: 'Needle();' },
    ]);
    expect(compact).not.toHaveProperty('context_truncated');
    expect(await search({ context_lines: 0 })).toEqual(compact);

    const result = await search({ context_lines: 2 });
    expect(result.matches[0]).toEqual({
      ...compact.matches[0],
      context_before: [
        { line_number: 1, line: 'before', truncated: false },
        { line_number: 2, line: '', truncated: false },
      ],
      context_after: [{ line_number: 4, line: 'after', truncated: false }],
    });
    expect(result.context_truncated).toBe(false);
  });

  it('does not invent context past the file boundary or its final newline', async () => {
    await writeFile(join(root, 'sample.txt'), 'Needle\n');
    const result = await search({ context_lines: 3 });
    expect(result.matches[0]).toMatchObject({ context_before: [], context_after: [] });
    expect(result.context_truncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('preserves match pagination and budgets only the requested page', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => `Needle ${index}\n${'가'.repeat(200)}`);
    await writeFile(join(root, 'sample.txt'), rows.join('\n') + '\n');
    const first = await search({ limit: 100, context_lines: 3 });
    expect(first.matches).toHaveLength(100);
    expect(first.matches[99]?.line_number).toBe(199);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(100);
    expect(first.context_truncated).toBe(true);
    expect(first.truncated).toBe(false);
    const context = first.matches.flatMap((match) => [
      ...(match.context_before ?? []),
      ...(match.context_after ?? []),
    ]);
    const bytes = context.reduce((sum, row) => sum + Buffer.byteLength(row.line, 'utf8'), 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024);

    const later = await search({ offset: 110, limit: 2, context_lines: 3 });
    expect(later.matches.map((match) => match.line_number)).toEqual([221, 223]);
    expect(later.matches[0]?.context_before?.map((row) => row.line_number)).toEqual([
      218, 219, 220,
    ]);
    expect(later.context_truncated).toBe(false);
    expect(later.next_offset).toBe(112);
    const final = await search({ offset: 119, limit: 2, context_lines: 3 });
    expect(final.matches).toHaveLength(1);
    expect(final.has_more).toBe(false);
    expect(final.next_offset).toBeNull();
  });

  it('shortens long context without splitting surrogate pairs and exposes the shortening', async () => {
    await writeFile(join(root, 'sample.txt'), 'a'.repeat(199) + '😀tail\nNeedle\n');
    const result = await search({ context_lines: 1 });
    expect(result.matches[0]?.context_before).toEqual([
      { line_number: 1, line: 'a'.repeat(199) + '…', truncated: true },
    ]);
    expect(result.context_truncated).toBe(true);
    expect(result.truncated).toBe(false);
    const context = result.matches[0]?.context_before?.[0]?.line ?? '';
    expect(Buffer.from(context, 'utf8').toString('utf8')).toBe(context);
  });

  it('counts multibyte excerpts and their ellipses in the shared context budget', async () => {
    const rows = Array.from(
      { length: 100 },
      (_, index) => `${'가'.repeat(201)}\nNeedle ${index}\n${'나'.repeat(201)}`,
    );
    await writeFile(join(root, 'sample.txt'), rows.join('\n'));
    const result = await search({ limit: 100, context_lines: 1 });
    const context = result.matches.flatMap((match) => [
      ...(match.context_before ?? []),
      ...(match.context_after ?? []),
    ]);
    expect(result.count).toBe(100);
    expect(result.has_more).toBe(false);
    expect(result.context_truncated).toBe(true);
    expect(context.every((row) => row.truncated && row.line.endsWith('…'))).toBe(true);
    const bytes = context.reduce((sum, row) => sum + Buffer.byteLength(row.line, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024);
    expect(bytes + 603).toBeGreaterThan(16 * 1024);
  });

  it('skips NUL-containing and malformed UTF-8 files even if their prefix matches', async () => {
    await writeFile(join(root, 'binary.dat'), Buffer.from('Needle\0payload'));
    await writeFile(
      join(root, 'invalid.dat'),
      Buffer.concat([Buffer.from('Needle'), Buffer.from([0xff])]),
    );
    await writeFile(join(root, 'valid.txt'), 'Needle\n');
    const result = await search({ context_lines: 3 });
    expect(result.matches.map((match) => match.path)).toEqual(['valid.txt']);
    expect(result.skipped_files).toBe(2);
    expect(result.context_truncated).toBe(false);
  });

  it('keeps literal matching and context unavailable when there are no hits', async () => {
    await writeFile(join(root, 'sample.txt'), 'not a wildcard\n');
    const result = await search({ query: '.*', context_lines: 3 });
    expect(result.matches).toEqual([]);
    expect(result.context_truncated).toBe(false);
    expect(result.has_more).toBe(false);
  });
});
