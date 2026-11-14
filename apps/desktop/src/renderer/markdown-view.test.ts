import { describe, expect, it } from 'vitest';

import { describableHref, isMarkdownPath, parseMarkdown } from './markdown-view.js';

describe('markdown view helpers', () => {
  it('recognises Markdown files by extension only', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('notes.mdx')).toBe(false);
    expect(isMarkdownPath('md')).toBe(false);
    expect(isMarkdownPath('src/main.ts')).toBe(false);
  });

  it('describes only web, mail, anchor and relative links', () => {
    expect(describableHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(describableHref('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(describableHref('#install')).toBe('#install');
    expect(describableHref('./docs/setup.md')).toBe('./docs/setup.md');
    expect(describableHref('javascript:alert(1)')).toBeNull();
    expect(describableHref('data:text/html,<b>x</b>')).toBeNull();
    expect(describableHref('file:///etc/passwd')).toBeNull();
    expect(describableHref('  ')).toBeNull();
  });

  it('keeps raw HTML as a token so it can be shown as text', () => {
    const tokens = parseMarkdown('<script>alert(1)</script>\n\ntext');
    expect(tokens.some((token) => token.type === 'html')).toBe(true);
    expect(tokens.some((token) => token.type === 'paragraph')).toBe(true);
  });

  it('parses GFM tables and task lists', () => {
    const tokens = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n');
    expect(tokens.map((token) => token.type)).toEqual(expect.arrayContaining(['table', 'list']));
  });
});
