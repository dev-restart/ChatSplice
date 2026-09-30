import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage, type LanguageSupport } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';

export const CODE_EDITOR_LANGUAGES = [
  'typescript',
  'javascript',
  'jsx',
  'tsx',
  'json',
  'markdown',
  'python',
  'rust',
  'html',
  'css',
  'sql',
  'yaml',
  'shell',
  'plaintext',
] as const;

export type CodeEditorLanguage = (typeof CODE_EDITOR_LANGUAGES)[number];

const aliases: Record<string, CodeEditorLanguage> = {
  js: 'javascript',
  javascript: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkdn: 'markdown',
  py: 'python',
  pyw: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  html: 'html',
  htm: 'html',
  css: 'css',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  shell: 'shell',
  text: 'plaintext',
  txt: 'plaintext',
  plaintext: 'plaintext',
  plain: 'plaintext',
};

function normalizeHint(value: string | undefined): CodeEditorLanguage | undefined {
  if (value === undefined) return undefined;
  return aliases[value.trim().toLocaleLowerCase().replace(/^\./, '')];
}

function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1)?.toLocaleLowerCase() ?? '';
}

/** Infer a syntax mode from a workspace-relative path, with an optional explicit hint. */
export function codeEditorLanguageForPath(path: string, languageHint?: string): CodeEditorLanguage {
  const hinted = normalizeHint(languageHint);
  if (hinted !== undefined) return hinted;

  const name = basename(path);
  if (name === 'pkgbuild' || name === '.bashrc' || name === '.zshrc') return 'shell';
  const extension = name.slice(name.lastIndexOf('.') + 1);
  return aliases[extension] ?? 'plaintext';
}

function languageSupportExtension(support: LanguageSupport): Extension {
  return support.extension;
}

/** Return a CodeMirror language extension. Unknown extensions intentionally stay plain text. */
export function codeEditorLanguageExtension(path: string, languageHint?: string): Extension {
  switch (codeEditorLanguageForPath(path, languageHint)) {
    case 'typescript':
      return languageSupportExtension(javascript({ typescript: true }));
    case 'jsx':
      return languageSupportExtension(javascript({ jsx: true }));
    case 'tsx':
      return languageSupportExtension(javascript({ jsx: true, typescript: true }));
    case 'javascript':
      return languageSupportExtension(javascript());
    case 'json':
      return languageSupportExtension(json());
    case 'markdown':
      return languageSupportExtension(markdown());
    case 'python':
      return languageSupportExtension(python());
    case 'rust':
      return languageSupportExtension(rust());
    case 'html':
      return languageSupportExtension(html());
    case 'css':
      return languageSupportExtension(css());
    case 'sql':
      return languageSupportExtension(sql());
    case 'yaml':
      return languageSupportExtension(yaml());
    case 'shell':
      return StreamLanguage.define(shell).extension;
    case 'plaintext':
    default:
      return [];
  }
}
