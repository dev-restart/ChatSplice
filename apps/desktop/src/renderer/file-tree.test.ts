import { describe, expect, it } from 'vitest';

import {
  cachePreviewContent,
  createFileTreeNode,
  flattenFileTree,
  mergeFileTreeChildren,
  mergeFileTreeChildrenBounded,
  countFileTreeNodes,
  type FileTreeNodeState,
} from './file-tree.js';

function node(path: string, type: 'file' | 'directory'): FileTreeNodeState {
  return createFileTreeNode({ path, type });
}

describe('file tree state', () => {
  it('sorts folders before files and only flattens expanded branches', () => {
    const roots = mergeFileTreeChildren(
      [],
      [
        { path: 'README.md', type: 'file' },
        { path: 'src', type: 'directory' },
      ],
      null,
    );
    const src = roots.find((item) => item.path === 'src');
    expect(roots.map((item) => item.path)).toEqual(['src', 'README.md']);
    expect(src?.childrenLoaded).toBe(false);
    expect(flattenFileTree(roots).nodes.map((item) => item.path)).toEqual(['src', 'README.md']);

    if (src === undefined) throw new Error('src fixture missing');
    src.children = [node('src/main.ts', 'file')];
    src.childrenLoaded = true;
    src.expanded = true;
    expect(flattenFileTree(roots).nodes.map((item) => item.path)).toEqual([
      'src',
      'src/main.ts',
      'README.md',
    ]);
  });

  it('keeps loaded search matches visible under a collapsed parent', () => {
    const roots = [node('src', 'directory')];
    const root = roots[0];
    if (root === undefined) throw new Error('root fixture missing');
    root.children = [node('src/needle.ts', 'file'), node('src/other.ts', 'file')];
    root.childrenLoaded = true;
    const result = flattenFileTree(roots, 'needle');

    expect(result.nodes.map((item) => item.path)).toEqual(['src', 'src/needle.ts']);
  });

  it('uses previewed content only for the content tab and enforces the row cap', () => {
    const roots = [node('src', 'directory')];
    const root = roots[0];
    if (root === undefined) throw new Error('root fixture missing');
    root.children = [node('src/one.ts', 'file'), node('src/two.ts', 'file')];
    root.childrenLoaded = true;
    const content = flattenFileTree(
      roots,
      'needle',
      'content',
      new Map([['src/two.ts', 'const needle = true;']]),
    );
    expect(content.nodes.map((item) => item.path)).toEqual(['src', 'src/two.ts']);

    root.expanded = true;
    const capped = flattenFileTree(roots, '', 'name', new Map(), 1);
    expect(capped.nodes).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('counts retained descendants when appending a bounded page', () => {
    const existing = [node('src', 'directory')];
    const src = existing[0];
    if (src === undefined) throw new Error('src fixture missing');
    src.children = [node('src/one.ts', 'file'), node('src/two.ts', 'file')];
    src.childrenLoaded = true;

    const merged = mergeFileTreeChildrenBounded(
      existing,
      [
        { path: 'aaa.md', type: 'file' },
        { path: 'zzz.json', type: 'file' },
      ],
      null,
      4,
    );

    expect(countFileTreeNodes(merged.children)).toBe(4);
    expect(merged.children.map((item) => item.path)).toEqual(['src', 'aaa.md']);
    expect(merged.truncated).toBe(true);
  });

  it('bounds preview search cache by file count and UTF-8 bytes', () => {
    let cache = new Map<string, string>();
    for (let index = 0; index < 21; index += 1) {
      cache = cachePreviewContent(cache, `file-${index}.txt`, 'x');
    }
    expect(cache.size).toBe(20);
    expect(cache.has('file-0.txt')).toBe(false);

    cache = cachePreviewContent(new Map(), 'old.txt', 'a'.repeat(700_000), 20, 1_000_000);
    cache = cachePreviewContent(cache, 'new.txt', 'b'.repeat(700_000), 20, 1_000_000);
    expect(cache.has('old.txt')).toBe(false);
    expect(cache.has('new.txt')).toBe(true);
  });
});
