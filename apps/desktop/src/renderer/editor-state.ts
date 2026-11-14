import { EditorState, type Extension } from '@codemirror/state';

function hasLoneLineEnding(value: string, lineEnding: string): boolean {
  const remainder = value.replaceAll(lineEnding, '');
  return remainder.includes('\n') || remainder.includes('\r');
}

/** Detect only a consistent CRLF file. Mixed files stay byte-preserving text. */
export function codeEditorLineSeparator(doc: string): '\n' | '\r\n' {
  const hasCrLf = doc.includes('\r\n');
  if (hasCrLf && !hasLoneLineEnding(doc, '\r\n')) return '\r\n';
  return '\n';
}

/**
 * Configure the document's line break so new edits follow a consistent CRLF file.
 * Mixed line endings intentionally use LF as the internal separator, which keeps
 * the original CR characters in the document text.
 */
export function createCodeEditorState(doc: string, extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [EditorState.lineSeparator.of(codeEditorLineSeparator(doc)), ...extensions],
  });
}

/** Serialize a CodeMirror state using its configured source line separator. */
export function codeEditorDocumentText(state: EditorState): string {
  return state.sliceDoc();
}

export type CodeEditorExternalSnapshot = {
  currentContent: string;
  incomingContent: string;
  currentDirty: boolean;
  /** Undefined means the container has not supplied persisted dirty metadata. */
  incomingDirty?: boolean | undefined;
  incomingRevision?: number | undefined;
  knownRevision?: number | undefined;
};

/**
 * Decide whether an incoming container snapshot is a real external reload.
 * A same-content draft acknowledgement never replaces the live state, so it
 * cannot reset undo history or selection while a user is typing.
 */
export function shouldReplaceCodeEditorState(snapshot: CodeEditorExternalSnapshot): boolean {
  if (snapshot.currentContent === snapshot.incomingContent) return false;
  return (
    !snapshot.currentDirty ||
    snapshot.incomingDirty === false ||
    (snapshot.incomingRevision !== undefined &&
      snapshot.incomingRevision !== snapshot.knownRevision)
  );
}

export function shouldAdoptCodeEditorBaseline(snapshot: CodeEditorExternalSnapshot): boolean {
  return snapshot.currentContent === snapshot.incomingContent && snapshot.incomingDirty === false;
}
