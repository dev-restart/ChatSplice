import * as z from 'zod/v4';

/**
 * Editor sessions are owner-side UI state. They are deliberately separate
 * from the MCP fs.* request and result schemas: the renderer never supplies a
 * workspace binding, absolute path, or replacement SHA for these calls.
 */
export const EDITOR_MAX_DOCUMENT_BYTES = 1024 * 1024;
export const EDITOR_MAX_TABS_PER_WORKSPACE = 16;
export const EDITOR_MAX_GLOBAL_TABS = 48;
export const EDITOR_MAX_COMBINED_BYTES = 32 * 1024 * 1024;

const WorkspaceIdSchema = z.string().regex(/^ws_[a-f0-9]{24}$/);

/** Editor paths are normalized, relative paths to regular files in a project. */
export const EditorPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\\') &&
      !value.includes('\u0000') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
    'path must be a normalized workspace-relative path without traversal.',
  );

export const EditorTabIdSchema = z.string().regex(/^edtab_[a-f0-9]{24}$/);
export type EditorTabId = z.infer<typeof EditorTabIdSchema>;

export const EditorWorkspaceIdSchema = WorkspaceIdSchema;
export type EditorWorkspaceId = z.infer<typeof EditorWorkspaceIdSchema>;

function isBoundedEditorText(value: string): boolean {
  if (value.includes('\u0000')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return new TextEncoder().encode(value).byteLength <= EDITOR_MAX_DOCUMENT_BYTES;
}

const EditorContentSchema = z
  .string()
  .refine(
    isBoundedEditorText,
    `editor content must be at most ${EDITOR_MAX_DOCUMENT_BYTES} UTF-8 bytes.`,
  );

/** A tab summary never carries the file body or a filesystem root. */
export const EditorTabSchema = z
  .object({
    editor_tab_id: EditorTabIdSchema,
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
    label: z.string().trim().min(1).max(240),
    dirty: z.boolean(),
    draft_revision: z.number().int().nonnegative(),
    loaded: z.boolean(),
  })
  .strict();
export type EditorTab = z.infer<typeof EditorTabSchema>;

/**
 * Current editor selection plus bounded summaries for the selected workspace.
 * open_document_ids covers all in-memory documents while tabs is scoped to the
 * current workspace so switching projects does not expose another project's
 * paths or bodies to the current editor surface.
 */
export const EditorStateSchema = z
  .object({
    workspace_id: WorkspaceIdSchema.nullable(),
    tabs: z.array(EditorTabSchema).max(EDITOR_MAX_TABS_PER_WORKSPACE),
    active_editor_tab_id: EditorTabIdSchema.nullable(),
    open_document_ids: z.array(EditorTabIdSchema).max(EDITOR_MAX_GLOBAL_TABS),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const tabIds = value.tabs.map((tab) => tab.editor_tab_id);
    if (new Set(tabIds).size !== tabIds.length) {
      context.addIssue({ code: 'custom', message: 'Editor tab IDs must be unique.' });
    }
    if (new Set(value.open_document_ids).size !== value.open_document_ids.length) {
      context.addIssue({ code: 'custom', message: 'Editor document IDs must be unique.' });
    }
    if (value.active_editor_tab_id !== null && !tabIds.includes(value.active_editor_tab_id)) {
      context.addIssue({ code: 'custom', message: 'The active editor tab must exist.' });
    }
    if (value.active_editor_tab_id !== null && value.workspace_id === null) {
      context.addIssue({
        code: 'custom',
        message: 'An active editor tab requires an active workspace.',
      });
    }
    if (value.tabs.some((tab) => tab.workspace_id !== value.workspace_id)) {
      context.addIssue({
        code: 'custom',
        message: 'Editor tabs must belong to the active workspace.',
      });
    }
    if (tabIds.some((tabId) => !value.open_document_ids.includes(tabId))) {
      context.addIssue({
        code: 'custom',
        message: 'Every visible editor tab must be present in open_document_ids.',
      });
    }
  });
export type EditorState = z.infer<typeof EditorStateSchema>;

/** A loaded document is returned only to the owner editor WebContentsView. */
export const EditorDocumentSchema = z
  .object({
    editor_tab_id: EditorTabIdSchema,
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
    content: EditorContentSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    draft_revision: z.number().int().nonnegative(),
    dirty: z.boolean(),
  })
  .strict();
export type EditorDocument = z.infer<typeof EditorDocumentSchema>;

export const EditorDocumentTargetSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    editor_tab_id: EditorTabIdSchema,
  })
  .strict();
export type EditorDocumentTarget = z.infer<typeof EditorDocumentTargetSchema>;

/** Full-file owner route input; unlike fs.read this has no line or preview cap. */
export const WorkspaceEditorReadInputSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
  })
  .strict();
export type WorkspaceEditorReadInput = z.infer<typeof WorkspaceEditorReadInputSchema>;

/** SHA-guarded full replacement used by the editor save path. */
export const WorkspaceEditorSaveInputSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
    expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: EditorContentSchema,
  })
  .strict();
export type WorkspaceEditorSaveInput = z.infer<typeof WorkspaceEditorSaveInputSchema>;

export const WorkspaceEditorFileSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
    content: EditorContentSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WorkspaceEditorFile = z.infer<typeof WorkspaceEditorFileSchema>;

export const OpenEditorFileInputSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    path: EditorPathSchema,
  })
  .strict();
export type OpenEditorFileInput = z.infer<typeof OpenEditorFileInputSchema>;

export const ActivateEditorTabInputSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    editor_tab_id: EditorTabIdSchema.nullable(),
  })
  .strict();
export type ActivateEditorTabInput = z.infer<typeof ActivateEditorTabInputSchema>;

/** Project selection is a scalar IPC argument so the caller cannot smuggle a tab or path. */
export const SelectWorkspaceInputSchema = WorkspaceIdSchema;
export type SelectWorkspaceInput = z.infer<typeof SelectWorkspaceInputSchema>;

export const UpdateEditorDocumentInputSchema = EditorDocumentTargetSchema.extend({
  expected_revision: z.number().int().nonnegative(),
  content: EditorContentSchema,
}).strict();
export type UpdateEditorDocumentInput = z.infer<typeof UpdateEditorDocumentInputSchema>;

export const EditorErrorCodeSchema = z.enum([
  'editor_file_not_found',
  'editor_path_denied',
  'editor_unsupported_encoding',
  'editor_too_large',
  'editor_conflict',
  'editor_stale_revision',
  'editor_workspace_changed',
  'editor_tab_not_found',
  'editor_limit_reached',
  'editor_unsaved_changes',
  'editor_selection_changed',
  'editor_cancelled',
]);
export type EditorErrorCode = z.infer<typeof EditorErrorCodeSchema>;

export const EditorErrorSchema = z
  .object({
    code: EditorErrorCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();
export type EditorError = z.infer<typeof EditorErrorSchema>;
