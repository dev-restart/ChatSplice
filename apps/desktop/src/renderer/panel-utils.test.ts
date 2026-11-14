import { describe, expect, it } from 'vitest';

import { fileRequestIsCurrent, joinWorkspacePath, parentWorkspacePath } from './panel-utils.js';

describe('workbench panel path and stale request guards', () => {
  it('keeps workspace paths relative while navigating one level at a time', () => {
    expect(joinWorkspacePath('.', 'src')).toBe('src');
    expect(joinWorkspacePath('src', 'main.ts')).toBe('src/main.ts');
    expect(parentWorkspacePath('src/main.ts')).toBe('src');
    expect(parentWorkspacePath('src')).toBe('.');
    expect(parentWorkspacePath('.')).toBeNull();
  });

  it('accepts only the response for the currently selected file', () => {
    expect(fileRequestIsCurrent(4, 4, 'ws_a', 'ws_a', 'README.md', 'README.md')).toBe(true);
    expect(fileRequestIsCurrent(3, 4, 'ws_a', 'ws_a', 'README.md', 'README.md')).toBe(false);
    expect(fileRequestIsCurrent(4, 4, 'ws_a', 'ws_b', 'README.md', 'README.md')).toBe(false);
    expect(fileRequestIsCurrent(4, 4, 'ws_a', 'ws_a', 'README.md', 'src/main.ts')).toBe(false);
  });
});
