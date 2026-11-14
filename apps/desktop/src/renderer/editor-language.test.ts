import { describe, expect, it } from 'vitest';

import { history, undoDepth } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';

import { codeEditorLanguageExtension, codeEditorLanguageForPath } from './editor-language.js';
import {
  codeEditorDocumentText,
  codeEditorLineSeparator,
  createCodeEditorState,
  shouldAdoptCodeEditorBaseline,
  shouldReplaceCodeEditorState,
} from './editor-state.js';

describe('code editor language selection', () => {
  it.each([
    ['src/main.ts', undefined, 'typescript'],
    ['src/main.tsx', undefined, 'tsx'],
    ['src/main.jsx', undefined, 'jsx'],
    ['package.json', undefined, 'json'],
    ['docs/README.MD', undefined, 'markdown'],
    ['scripts/build.py', undefined, 'python'],
    ['src/lib.rs', undefined, 'rust'],
    ['public/index.html', undefined, 'html'],
    ['styles/site.css', undefined, 'css'],
    ['db/query.sql', undefined, 'sql'],
    ['config.yaml', undefined, 'yaml'],
    ['scripts/release.sh', undefined, 'shell'],
    ['notes/unknown.custom', undefined, 'plaintext'],
    ['notes/source.txt', 'typescript', 'typescript'],
  ] as const)('maps %s to %s', (path, hint, expected) => {
    expect(codeEditorLanguageForPath(path, hint)).toBe(expected);
  });

  it('recognizes shell dotfiles and keeps explicit hints authoritative', () => {
    expect(codeEditorLanguageForPath('.zshrc')).toBe('shell');
    expect(codeEditorLanguageForPath('notes.txt', '.yaml')).toBe('yaml');
    expect(codeEditorLanguageForPath('notes.txt', 'unknown-mode')).toBe('plaintext');
  });

  it('returns a plain extension for unknown files', () => {
    expect(codeEditorLanguageExtension('notes.custom')).toEqual([]);
  });
});

describe('code editor document state', () => {
  it('preserves CRLF and BOM when the document is opened without edits', () => {
    const source = '\ufefffirst\r\nsecond\r\n';
    const state = createCodeEditorState(source);
    expect(codeEditorLineSeparator(source)).toBe('\r\n');
    expect(codeEditorDocumentText(state)).toBe(source);
  });

  it('uses CRLF for new lines in a consistent CRLF document', () => {
    const source = 'first\r\nsecond\r\n';
    const state = createCodeEditorState(source);
    const updated = state.update({
      changes: { from: 5, insert: `${state.lineBreak}inserted` },
    }).state;
    expect(codeEditorDocumentText(updated)).toBe('first\r\ninserted\r\nsecond\r\n');
  });

  it('keeps undo history available for a cached editor state', () => {
    const initial = createCodeEditorState('abc', [history()]);
    const edited = initial.update({
      changes: { from: 3, insert: '!' },
      annotations: Transaction.userEvent.of('input'),
    }).state;
    expect(undoDepth(edited)).toBe(1);
  });

  it('keeps mixed line endings unchanged until the user edits them', () => {
    const source = 'first\r\nsecond\nthird\r\n';
    const state = createCodeEditorState(source);
    expect(codeEditorLineSeparator(source)).toBe('\n');
    expect(codeEditorDocumentText(state)).toBe(source);
  });

  it('does not replace a live draft for a same-content revision acknowledgement', () => {
    const acknowledged = {
      currentContent: 'draft',
      incomingContent: 'draft',
      currentDirty: true,
      incomingDirty: true,
      incomingRevision: 2,
      knownRevision: 1,
    };
    expect(shouldReplaceCodeEditorState(acknowledged)).toBe(false);
    expect(shouldAdoptCodeEditorBaseline(acknowledged)).toBe(false);
  });

  it('does not replace a newer dirty draft with stale dirty content', () => {
    expect(
      shouldReplaceCodeEditorState({
        currentContent: 'new draft',
        incomingContent: 'old draft',
        currentDirty: true,
        incomingDirty: true,
        incomingRevision: 4,
        knownRevision: 4,
      }),
    ).toBe(false);
  });

  it('accepts a clean save acknowledgement without replacing editor state', () => {
    const saved = {
      currentContent: 'draft',
      incomingContent: 'draft',
      currentDirty: true,
      incomingDirty: false,
      incomingRevision: 2,
      knownRevision: 2,
    };
    expect(shouldReplaceCodeEditorState(saved)).toBe(false);
    expect(shouldAdoptCodeEditorBaseline(saved)).toBe(true);
  });

  it('treats changed content at a new revision as an external reload', () => {
    expect(
      shouldReplaceCodeEditorState({
        currentContent: 'draft',
        incomingContent: 'disk',
        currentDirty: true,
        incomingDirty: false,
        incomingRevision: 3,
        knownRevision: 2,
      }),
    ).toBe(true);
  });
});
