import { lexer, type Token } from 'marked';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkdn']);

export function isMarkdownPath(path: string): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return path.includes('.') && MARKDOWN_EXTENSIONS.has(extension);
}

/**
 * Parses Markdown into marked's token tree. Tokens are rendered by Svelte as
 * text nodes only, so raw HTML in a document can never run or load anything.
 */
export function parseMarkdown(source: string): Token[] {
  try {
    return lexer(source, { gfm: true, breaks: false });
  } catch {
    return [];
  }
}

/** Only web and mail links are described to the reader; every other scheme is dropped. */
export function describableHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    // A relative path such as ./docs/setup.md stays readable as text.
    return /^[\w./~-][^:]*$/.test(trimmed) ? trimmed : null;
  }
}
