export type CodeEditorDocument = {
  /** Stable identity for the open document. The path is not used as the identity. */
  id: string;
  path: string;
  content: string;
  /** Optional language hint. When omitted, the language is inferred from path. */
  language?: string;
  /** Increases only when the container has an explicit external file revision. */
  revision?: number;
  /** The container's persisted draft state. */
  dirty: boolean;
};

export type CodeEditorChange = {
  documentId: string;
  content: string;
  dirty: boolean;
};

export type CodeEditorSave = {
  documentId: string;
  content: string;
  dirty: boolean;
};
