import * as z from 'zod/v4';
import { ProjectExecSummarySchema } from './execution.js';

export const CONTROL_PROTOCOL_VERSION = 4 as const;
export const MCP_SERVER_NAME = 'chatsplice-mcp-server' as const;
export const MCP_SERVER_VERSION = '0.0.9' as const;
export const MCP_AUTH_HEADER = 'x-chatsplice-token' as const;
export const LEGACY_MCP_AUTH_HEADER = 'x-localchat-token' as const;
export const UiLocaleSchema = z.enum(['en', 'ko']);
export type UiLocale = z.infer<typeof UiLocaleSchema>;
export const IPC_CHANNELS = {
  getStatus: 'chatsplice:get-status',
  getExecutionJob: 'chatsplice:get-execution-job',
  cancelExecutionJob: 'chatsplice:cancel-execution-job',
  submitProjectExec: 'chatsplice:submit-project-exec',
  listWorkspaces: 'chatsplice:list-workspaces',
  openWorkspace: 'chatsplice:open-workspace',
  renameWorkspace: 'chatsplice:rename-workspace',
  updateWorkspaceRootPath: 'chatsplice:update-workspace-root-path',
  removeWorkspace: 'chatsplice:remove-workspace',
  listWorkspaceReferences: 'chatsplice:list-workspace-references',
  addWorkspaceReference: 'chatsplice:add-workspace-reference',
  removeWorkspaceReference: 'chatsplice:remove-workspace-reference',
  copyProjectBinding: 'chatsplice:copy-project-binding',
  automateChatGptProject: 'chatsplice:automate-chatgpt-project',
  automateProjectInstructionsUpdate: 'chatsplice:automate-project-instructions-update',
  listChatGptTabs: 'chatsplice:list-chatgpt-tabs',
  createChatGptTab: 'chatsplice:create-chatgpt-tab',
  activateChatGptTab: 'chatsplice:activate-chatgpt-tab',
  updateChatGptTab: 'chatsplice:update-chatgpt-tab',
  closeChatGptTab: 'chatsplice:close-chatgpt-tab',
  configureTunnel: 'chatsplice:configure-tunnel',
  requestTunnelCredential: 'chatsplice:request-tunnel-credential',
  checkTunnel: 'chatsplice:check-tunnel',
  startTunnel: 'chatsplice:start-tunnel',
  stopTunnel: 'chatsplice:stop-tunnel',
  installTunnelClient: 'chatsplice:install-tunnel-client',
  openTunnelSetupHelp: 'chatsplice:open-tunnel-setup-help',
  removeTunnelCredential: 'chatsplice:remove-tunnel-credential',
  listTerminalSessions: 'chatsplice:list-terminal-sessions',
  createTerminalSession: 'chatsplice:create-terminal-session',
  readTerminalSession: 'chatsplice:read-terminal-session',
  writeTerminalSession: 'chatsplice:write-terminal-session',
  resizeTerminalSession: 'chatsplice:resize-terminal-session',
  closeTerminalSession: 'chatsplice:close-terminal-session',
  getSidebarLayout: 'chatsplice:get-sidebar-layout',
  setSidebarWidth: 'chatsplice:set-sidebar-width',
  toggleSidebar: 'chatsplice:toggle-sidebar',
  setSidebarPreview: 'chatsplice:set-sidebar-preview',
  setModalOverlay: 'chatsplice:set-modal-overlay',
  getPanelState: 'chatsplice:get-panel-state',
  setPanelState: 'chatsplice:set-panel-state',
  listWorkspaceFiles: 'chatsplice:list-workspace-files',
  readWorkspaceFile: 'chatsplice:read-workspace-file',
  getEditorState: 'chatsplice:get-editor-state',
  getEditorDocument: 'chatsplice:get-editor-document',
  openEditorFile: 'chatsplice:open-editor-file',
  activateEditorTab: 'chatsplice:activate-editor-tab',
  updateEditorDocument: 'chatsplice:update-editor-document',
  saveEditorDocument: 'chatsplice:save-editor-document',
  reloadEditorDocument: 'chatsplice:reload-editor-document',
  closeEditorTab: 'chatsplice:close-editor-tab',
  selectWorkspace: 'chatsplice:select-workspace',
  openWorkspaceTerminal: 'chatsplice:open-workspace-terminal',
  openWorkspaceFinder: 'chatsplice:open-workspace-finder',
  setAutoAttach: 'chatsplice:set-auto-attach',
  setMcpAppName: 'chatsplice:set-mcp-app-name',
} as const;

export const SidebarLayoutSchema = z
  .object({
    width: z.number().int().min(280).max(560),
    collapsed: z.boolean(),
  })
  .strict();
export type SidebarLayout = z.infer<typeof SidebarLayoutSchema>;

export const SidebarWidthSchema = z.number().int().min(0).max(10000);

/**
 * 'reference' is a lightweight, path-only workspace created only by an
 * approved fs.reference_request — never independently opened as a project,
 * never issued a workspace_binding, and reachable only through the
 * fs.reference_* read-only tool family for the source workspace that
 * requested it.
 */
export const WorkspaceKindSchema = z.enum(['user', 'probe', 'reference']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const PANEL_FILES_WIDTH_DEFAULT = 340;
export const PANEL_CONSOLE_HEIGHT_DEFAULT = 260;

export const WorkspaceSummarySchema = z
  .object({
    workspace_id: z.string().regex(/^ws_[a-f0-9]{24}$/),
    display_name: z.string().min(1).max(120),
    kind: WorkspaceKindSchema,
    created_at: z.iso.datetime(),
  })
  .strict();
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const PanelStateSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable(),
    console_open: z.boolean(),
    files_open: z.boolean(),
    files_width: z.number().int().min(0).max(10_000).default(PANEL_FILES_WIDTH_DEFAULT),
    console_height: z.number().int().min(0).max(10_000).default(PANEL_CONSOLE_HEIGHT_DEFAULT),
  })
  .strict();
export type PanelState = z.infer<typeof PanelStateSchema>;

/** A partial update keeps two independent panel surfaces from overwriting one another. */
export const PanelStatePatchSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable().optional(),
    console_open: z.boolean().optional(),
    files_open: z.boolean().optional(),
    files_width: z.number().int().min(0).max(10_000).optional(),
    console_height: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type PanelStatePatch = z.infer<typeof PanelStatePatchSchema>;

export const WorkspaceDetailSchema = WorkspaceSummarySchema.extend({
  root_path: z.string().min(1).max(4096),
});
export type WorkspaceDetail = z.infer<typeof WorkspaceDetailSchema>;

export const WorkspaceListResultSchema = z
  .object({
    workspaces: z.array(WorkspaceSummarySchema).max(500),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceListResult = z.infer<typeof WorkspaceListResultSchema>;

export const WorkspaceDetailListResultSchema = z
  .object({
    workspaces: z.array(WorkspaceDetailSchema).max(500),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type WorkspaceDetailListResult = z.infer<typeof WorkspaceDetailListResultSchema>;

export const ChatGptTabIdSchema = z.string().regex(/^tab_[a-f0-9]{24}$/);
export type ChatGptTabId = z.infer<typeof ChatGptTabIdSchema>;

export const ChatGptTabRecordSchema = z
  .object({
    chatgpt_tab_id: ChatGptTabIdSchema,
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable(),
    project_instructions_confirmed: z.boolean().default(false),
    label: z.string().trim().min(1).max(80),
    url: z.url().max(4096),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();
export type ChatGptTabRecord = z.infer<typeof ChatGptTabRecordSchema>;

export const ChatGptTabStateSchema = z
  .object({
    tabs: z.array(ChatGptTabRecordSchema).min(1).max(50),
    active_tab_id: ChatGptTabIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.tabs.map((tab) => tab.chatgpt_tab_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'ChatGPT tab IDs must be unique.' });
    }
    if (!ids.includes(value.active_tab_id)) {
      context.addIssue({ code: 'custom', message: 'The active ChatGPT tab must exist.' });
    }
  });
export type ChatGptTabState = z.infer<typeof ChatGptTabStateSchema>;

export const ChatGptTabSummarySchema = ChatGptTabRecordSchema.omit({
  url: true,
  created_at: true,
  updated_at: true,
}).extend({ active: z.boolean() });
export type ChatGptTabSummary = z.infer<typeof ChatGptTabSummarySchema>;

export const ChatGptTabListResultSchema = z
  .object({
    tabs: z.array(ChatGptTabSummarySchema).min(1).max(50),
    active_tab_id: ChatGptTabIdSchema,
  })
  .strict();
export type ChatGptTabListResult = z.infer<typeof ChatGptTabListResultSchema>;

export const CreateChatGptTabInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable(),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type CreateChatGptTabInput = z.infer<typeof CreateChatGptTabInputSchema>;

export const UpdateChatGptTabInputSchema = z
  .object({
    chatgpt_tab_id: ChatGptTabIdSchema,
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable().optional(),
    project_instructions_confirmed: z.boolean().optional(),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.workspace_id !== undefined ||
      value.project_instructions_confirmed !== undefined ||
      value.label !== undefined,
    {
      message:
        'A ChatGPT tab update must change the workspace association, Project instructions confirmation, or label.',
    },
  );
export type UpdateChatGptTabInput = z.infer<typeof UpdateChatGptTabInputSchema>;

export const RegisterWorkspaceInputSchema = z
  .object({
    root_path: z.string().min(1).max(4096),
    display_name: z.string().min(1).max(120).optional(),
  })
  .strict();
export type RegisterWorkspaceInput = z.infer<typeof RegisterWorkspaceInputSchema>;

/**
 * Removes only a ChatSplice user-workspace registration. It never removes the
 * folder itself or the corresponding remote ChatGPT Project.
 */
export const RemoveWorkspaceInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
  })
  .strict();
export type RemoveWorkspaceInput = z.infer<typeof RemoveWorkspaceInputSchema>;

/**
 * Renames only the local ChatSplice sidebar label for a workspace. The
 * filesystem folder name, workspace_id, and remote ChatGPT Project name are
 * untouched.
 */
export const RenameWorkspaceInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    display_name: z.string().min(1).max(120),
  })
  .strict();
export type RenameWorkspaceInput = z.infer<typeof RenameWorkspaceInputSchema>;

/**
 * Repoints a registered project at a different local folder. workspace_id
 * and workspace_binding never change, so a connected ChatGPT Project's saved
 * instructions stay valid after the move.
 */
export const UpdateWorkspaceRootPathInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    root_path: z.string().min(1).max(4096),
  })
  .strict();
export type UpdateWorkspaceRootPathInput = z.infer<typeof UpdateWorkspaceRootPathInputSchema>;

/**
 * A one-way, ChatSplice-owned permission for one workspace to inspect another
 * workspace. It deliberately carries IDs only; absolute paths and bindings
 * remain local to the daemon.
 */
export const WorkspaceReferenceSchema = z
  .object({
    source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    reference_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    created_at: z.iso.datetime(),
  })
  .strict()
  .refine((value) => value.source_workspace_id !== value.reference_workspace_id, {
    message: 'A workspace cannot reference itself.',
  });
export type WorkspaceReference = z.infer<typeof WorkspaceReferenceSchema>;

export const WorkspaceReferenceListResultSchema = z
  .object({
    references: z.array(WorkspaceReferenceSchema).max(1_000),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.references.map(
      (reference) => `${reference.source_workspace_id}:${reference.reference_workspace_id}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'Workspace references must be unique.' });
    }
  });
export type WorkspaceReferenceListResult = z.infer<typeof WorkspaceReferenceListResultSchema>;

export const WorkspaceReferenceMutationInputSchema = z
  .object({
    source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    reference_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
  })
  .strict()
  .refine((value) => value.source_workspace_id !== value.reference_workspace_id, {
    message: 'A workspace cannot reference itself.',
  });
export type WorkspaceReferenceMutationInput = z.infer<typeof WorkspaceReferenceMutationInputSchema>;

export const WorkspaceBindingSchema = z
  .string()
  .regex(/^wb_[a-f0-9]{64}$/)
  .describe('Opaque ChatSplice binding copied for this exact workspace.');
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;

export const ProjectBindingRequestSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
  })
  .strict();
export type ProjectBindingRequest = z.infer<typeof ProjectBindingRequestSchema>;

/**
 * Keep a safety margin below the currently observed 8,000-character ChatGPT
 * Project instructions field limit so setup never loses the binding text.
 */
export const CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH = 7_800;

export const ProjectBindingResultSchema = z
  .object({
    binding_text: z.string().min(1).max(CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH),
  })
  .strict();
export type ProjectBindingResult = z.infer<typeof ProjectBindingResultSchema>;

/**
 * The renderer may request a Project setup only for a registered local workspace.
 * It never supplies a browser script, ChatGPT URL, or workspace binding.
 */
export const AutomateChatGptProjectInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
  })
  .strict();
export type AutomateChatGptProjectInput = z.infer<typeof AutomateChatGptProjectInputSchema>;

export const AutomateChatGptProjectInstructionsInputSchema =
  AutomateChatGptProjectInputSchema.extend({ automatic: z.boolean().optional() }).strict();

export const ChatGptProjectAutomationResultSchema = z
  .object({
    status: z.enum(['completed', 'needs_user']),
    reason: z.enum([
      'created_and_bound',
      'instructions_updated',
      'instructions_current',
      'automation_deferred',
      'needs_manual_merge',
      'chatgpt_login_required',
      'chatgpt_ui_changed',
      'create_modal_not_opened',
      'project_setup_failed',
    ]),
    message: z.string().trim().min(1).max(240),
  })
  .strict();
export type ChatGptProjectAutomationResult = z.infer<typeof ChatGptProjectAutomationResultSchema>;

export const AutomateChatGptProjectResultSchema = z
  .object({
    automation: ChatGptProjectAutomationResultSchema,
    tabs: ChatGptTabListResultSchema,
  })
  .strict();
export type AutomateChatGptProjectResult = z.infer<typeof AutomateChatGptProjectResultSchema>;

export const RemoveWorkspaceResultSchema = z
  .object({
    workspaces: WorkspaceDetailListResultSchema,
    tabs: ChatGptTabListResultSchema,
  })
  .strict();
export type RemoveWorkspaceResult = z.infer<typeof RemoveWorkspaceResultSchema>;

export const FsReadInputSchema = z
  .object({
    workspace_id: z
      .string()
      .regex(/^ws_[a-f0-9]{24}$/)
      .describe('Immutable workspace ID from the ChatSplice Project instructions.'),
    workspace_binding: WorkspaceBindingSchema,
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe('UTF-8 relative file path inside the selected workspace.'),
    start_line: z.number().int().min(1).max(1_000_000).optional(),
    end_line: z.number().int().min(1).max(1_000_000).optional(),
    max_bytes: z.number().int().min(1).max(51_200).default(51_200),
  })
  .strict()
  .refine(
    (value) =>
      value.start_line === undefined ||
      value.end_line === undefined ||
      value.start_line <= value.end_line,
    { message: 'start_line must be less than or equal to end_line.' },
  );
export type FsReadInput = z.infer<typeof FsReadInputSchema>;

export const FsReadResultSchema = z
  .object({
    workspace_id: z.string(),
    workspace_name: z.string().min(1).max(120),
    path: z.string(),
    content: z.string(),
    start_line: z.number().int().positive(),
    end_line: z.number().int().nonnegative(),
    total_lines: z.number().int().nonnegative(),
    bytes_returned: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    truncated: z.boolean(),
  })
  .strict();
export type FsReadResult = z.infer<typeof FsReadResultSchema>;

const LocalWorkspacePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value === '.' ||
      (!value.startsWith('/') &&
        !/^[A-Za-z]:/.test(value) &&
        !value.includes('\\') &&
        !value.includes('\u0000') &&
        value.split('/').every((part) => part !== '..' && part !== '' && part !== '.')),
    'path must be a workspace-relative path without traversal.',
  );

/** Narrow owner-side file browser request; daemon fills the MCP binding. */
export const WorkspaceFileListInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    path: LocalWorkspacePathSchema.default('.'),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type WorkspaceFileListInput = z.infer<typeof WorkspaceFileListInputSchema>;

/** Narrow owner-side file preview request; daemon applies the normal fs.read guards. */
export const WorkspaceFileReadInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    path: LocalWorkspacePathSchema,
    start_line: z.number().int().min(1).max(1_000_000).optional(),
    end_line: z.number().int().min(1).max(1_000_000).optional(),
    max_bytes: z.number().int().min(1).max(51_200).default(51_200),
  })
  .strict()
  .refine(
    (value) =>
      value.start_line === undefined ||
      value.end_line === undefined ||
      value.start_line <= value.end_line,
    { message: 'start_line must be less than or equal to end_line.' },
  );
export type WorkspaceFileReadInput = z.infer<typeof WorkspaceFileReadInputSchema>;

const FsDiscoveryBaseInputSchema = z.object({
  workspace_id: WorkspaceSummarySchema.shape.workspace_id.describe(
    'Immutable workspace ID from the ChatSplice Project instructions.',
  ),
  workspace_binding: WorkspaceBindingSchema,
  path: z
    .string()
    .min(1)
    .max(4096)
    .default('.')
    .describe("Existing relative directory path; use '.' for the workspace root."),
  glob: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        !value.includes('\0') &&
        !value.includes('\\') &&
        !value.startsWith('/') &&
        !value.split('/').includes('..'),
      'glob must be a relative workspace pattern without traversal.',
    )
    .default('**/*')
    .describe("Bounded glob using '*', '**', and '?', relative to path."),
  max_depth: z.number().int().min(1).max(12).default(6),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export const FsListInputSchema = FsDiscoveryBaseInputSchema.extend({
  recursive: z.boolean().default(false),
}).strict();
export type FsListInput = z.infer<typeof FsListInputSchema>;

export const FsListEntrySchema = z
  .object({
    path: z.string().min(1).max(4096),
    type: z.enum(['file', 'directory', 'symlink']),
  })
  .strict();
export type FsListEntry = z.infer<typeof FsListEntrySchema>;

export const FsListResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    entries: z.array(FsListEntrySchema).max(200),
    count: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
    scanned_entries: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type FsListResult = z.infer<typeof FsListResultSchema>;

export const FsSearchInputSchema = FsDiscoveryBaseInputSchema.extend({
  query: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/[\r\n]/u.test(value), 'query must be a single-line literal string.'),
  case_sensitive: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
export type FsSearchInput = z.infer<typeof FsSearchInputSchema>;

export const FsSearchMatchSchema = z
  .object({
    path: z.string().min(1).max(4096),
    line_number: z.number().int().positive(),
    column: z.number().int().positive(),
    line: z.string().max(502),
  })
  .strict();
export type FsSearchMatch = z.infer<typeof FsSearchMatchSchema>;

export const FsSearchResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    query: z.string().min(1).max(500),
    matches: z.array(FsSearchMatchSchema).max(100),
    count: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
    files_scanned: z.number().int().nonnegative(),
    bytes_scanned: z.number().int().nonnegative(),
    skipped_files: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type FsSearchResult = z.infer<typeof FsSearchResultSchema>;

const FsReferenceBaseInputShape = {
  workspace_id: WorkspaceSummarySchema.shape.workspace_id.describe(
    'Immutable source workspace ID from the ChatSplice Project instructions.',
  ),
  workspace_binding: WorkspaceBindingSchema,
  reference_workspace_id: WorkspaceSummarySchema.shape.workspace_id.describe(
    'A ChatSplice read-only reference target returned by fs.reference_list.',
  ),
};

/** Lists only the projects explicitly allowed as read-only references. */
export const FsReferenceListInputSchema = z
  .object({
    workspace_id: FsReferenceBaseInputShape.workspace_id,
    workspace_binding: FsReferenceBaseInputShape.workspace_binding,
  })
  .strict();
export type FsReferenceListInput = z.infer<typeof FsReferenceListInputSchema>;

export const FsReferenceTargetSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    created_at: z.iso.datetime(),
  })
  .strict();
export type FsReferenceTarget = z.infer<typeof FsReferenceTargetSchema>;

export const FsReferenceListResultSchema = z
  .object({
    source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    references: z.array(FsReferenceTargetSchema).max(500),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type FsReferenceListResult = z.infer<typeof FsReferenceListResultSchema>;

const FsReferenceDiscoveryBaseInputSchema = z.object({
  ...FsReferenceBaseInputShape,
  path: z
    .string()
    .min(1)
    .max(4096)
    .default('.')
    .describe(
      "Existing relative directory path in the referenced workspace; use '.' for its root.",
    ),
  glob: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        !value.includes('\0') &&
        !value.includes('\\') &&
        !value.startsWith('/') &&
        !value.split('/').includes('..'),
      'glob must be a relative workspace pattern without traversal.',
    )
    .default('**/*')
    .describe("Bounded glob using '*', '**', and '?', relative to path."),
  max_depth: z.number().int().min(1).max(12).default(6),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export const FsReferencePathsInputSchema = FsReferenceDiscoveryBaseInputSchema.extend({
  recursive: z.boolean().default(false),
}).strict();
export type FsReferencePathsInput = z.infer<typeof FsReferencePathsInputSchema>;

export const FsReferencePathsResultSchema = FsListResultSchema.extend({
  source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
}).strict();
export type FsReferencePathsResult = z.infer<typeof FsReferencePathsResultSchema>;

export const FsReferenceSearchInputSchema = FsReferenceDiscoveryBaseInputSchema.extend({
  query: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/[\r\n]/u.test(value), 'query must be a single-line literal string.'),
  case_sensitive: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
export type FsReferenceSearchInput = z.infer<typeof FsReferenceSearchInputSchema>;

export const FsReferenceSearchResultSchema = FsSearchResultSchema.extend({
  source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
}).strict();
export type FsReferenceSearchResult = z.infer<typeof FsReferenceSearchResultSchema>;

export const FsReferenceReadInputSchema = z
  .object({
    ...FsReferenceBaseInputShape,
    path: z.string().min(1).max(4096),
    start_line: z.number().int().min(1).max(1_000_000).optional(),
    end_line: z.number().int().min(1).max(1_000_000).optional(),
    max_bytes: z.number().int().min(1).max(51_200).default(51_200),
  })
  .strict()
  .refine(
    (value) =>
      value.start_line === undefined ||
      value.end_line === undefined ||
      value.start_line <= value.end_line,
    { message: 'start_line must be less than or equal to end_line.' },
  );
export type FsReferenceReadInput = z.infer<typeof FsReferenceReadInputSchema>;

export const FsReferenceReadResultSchema = FsReadResultSchema.extend({
  source_workspace_id: WorkspaceSummarySchema.shape.workspace_id,
}).strict();
export type FsReferenceReadResult = z.infer<typeof FsReferenceReadResultSchema>;

export const FsEditOperationSchema = z
  .object({
    old_text: z
      .string()
      .min(1)
      .max(100_000)
      .describe('Exact current UTF-8 text copied from a bounded fs.read result.'),
    new_text: z.string().max(100_000).describe('Replacement UTF-8 text.'),
    replace_all: z
      .boolean()
      .default(false)
      .describe('Replace every exact match only when repeating the change is intentional.'),
  })
  .strict();
export type FsEditOperation = z.infer<typeof FsEditOperationSchema>;

export const FsEditInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id.describe(
      'Immutable workspace ID from the ChatSplice Project instructions.',
    ),
    workspace_binding: WorkspaceBindingSchema,
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe('Existing UTF-8 relative file path inside the selected workspace.'),
    expected_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('Full-file sha256 returned by the fs.read used to prepare these edits.'),
    edits: z.array(FsEditOperationSchema).min(1).max(20),
  })
  .strict();
export type FsEditInput = z.infer<typeof FsEditInputSchema>;

export const FsEditResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    previous_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    replacements: z.number().int().positive(),
    bytes_written: z.number().int().nonnegative(),
  })
  .strict();
export type FsEditResult = z.infer<typeof FsEditResultSchema>;

const WorkspaceMutationBaseShape = {
  workspace_id: WorkspaceSummarySchema.shape.workspace_id.describe(
    'Immutable workspace ID from the ChatSplice Project instructions.',
  ),
  workspace_binding: WorkspaceBindingSchema,
};

export const FsWriteInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...WorkspaceMutationBaseShape,
      path: z.string().min(1).max(4096),
      mode: z.literal('create'),
      content: z.string().max(10 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      ...WorkspaceMutationBaseShape,
      path: z.string().min(1).max(4096),
      mode: z.literal('replace'),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      content: z.string().max(10 * 1024 * 1024),
    })
    .strict(),
]);
export type FsWriteInput = z.infer<typeof FsWriteInputSchema>;

export const FsWriteResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    mode: z.enum(['create', 'replace']),
    previous_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes_written: z.number().int().nonnegative(),
  })
  .strict();
export type FsWriteResult = z.infer<typeof FsWriteResultSchema>;

export const FsMkdirInputSchema = z
  .object({
    ...WorkspaceMutationBaseShape,
    path: z.string().min(1).max(4096),
  })
  .strict();
export type FsMkdirInput = z.infer<typeof FsMkdirInputSchema>;

export const FsMkdirResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    created: z.literal(true),
  })
  .strict();
export type FsMkdirResult = z.infer<typeof FsMkdirResultSchema>;

export const FsRenameInputSchema = z
  .object({
    ...WorkspaceMutationBaseShape,
    source_path: z.string().min(1).max(4096),
    destination_path: z.string().min(1).max(4096),
    expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FsRenameInput = z.infer<typeof FsRenameInputSchema>;

export const FsRenameResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    source_path: z.string().min(1).max(4096),
    destination_path: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FsRenameResult = z.infer<typeof FsRenameResultSchema>;

export const FsDeleteInputSchema = z
  .object({
    ...WorkspaceMutationBaseShape,
    path: z.string().min(1).max(4096),
    expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FsDeleteInput = z.infer<typeof FsDeleteInputSchema>;

export const FsDeleteResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    deleted_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FsDeleteResult = z.infer<typeof FsDeleteResultSchema>;

export const ProjectRunTaskSchema = z.enum(['test', 'lint', 'typecheck', 'check', 'build']);
export type ProjectRunTask = z.infer<typeof ProjectRunTaskSchema>;

export const ProjectRunInputSchema = z
  .object({
    ...WorkspaceMutationBaseShape,
    task: ProjectRunTaskSchema,
    timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  })
  .strict();
export type ProjectRunInput = z.infer<typeof ProjectRunInputSchema>;

export const ProjectRunResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    task: ProjectRunTaskSchema,
    command: z.string().min(1).max(120),
    exit_code: z.number().int().nullable(),
    signal: z.string().max(40).nullable(),
    timed_out: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    stdout: z.string().max(102_400),
    stderr: z.string().max(102_400),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectRunResult = z.infer<typeof ProjectRunResultSchema>;

/**
 * A git ref (remote or branch) restricted to safe characters, no leading dash,
 * and no `..` so a structured value can never smuggle a flag or path traversal.
 */
export const GitRefNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Only ref characters are allowed.')
  .refine((value) => !value.includes('..'), 'A git ref may not contain "..".');

/** A workspace-relative path argument for git add/diff: no absolute path, traversal, or leading dash. */
export const GitRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.startsWith('-'), 'A path argument may not start with "-".')
  .refine((value) => !value.startsWith('/'), 'Only workspace-relative paths are allowed.')
  .refine(
    (value) => !value.split(/[\\/]/).includes('..'),
    'A path argument may not contain a ".." segment.',
  );

/**
 * The bounded git command set exposed by project.git. Each command is a
 * structured shape, never an arbitrary command or argument string, so there is
 * no shell and no way to run git subcommands outside this allowlist.
 */
export const ProjectGitCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('status') }).strict(),
  z.object({ command: z.literal('branch') }).strict(),
  z
    .object({
      command: z.literal('log'),
      max_count: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z
    .object({
      command: z.literal('diff'),
      staged: z.boolean().default(false),
      paths: z.array(GitRelativePathSchema).max(50).default([]),
    })
    .strict(),
  z
    .object({
      command: z.literal('add'),
      all: z.boolean().default(false),
      paths: z.array(GitRelativePathSchema).max(100).default([]),
    })
    .strict()
    .refine(
      (value) => value.all || value.paths.length > 0,
      'git add requires all=true or at least one path.',
    ),
  z
    .object({
      command: z.literal('commit'),
      message: z.string().min(1).max(2000),
      all: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      command: z.literal('push'),
      remote: GitRefNameSchema.default('origin'),
      branch: GitRefNameSchema.optional(),
      set_upstream: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      command: z.literal('pull'),
      remote: GitRefNameSchema.optional(),
      branch: GitRefNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('fetch'),
      remote: GitRefNameSchema.optional(),
    })
    .strict(),
]);
export type ProjectGitCommand = z.infer<typeof ProjectGitCommandSchema>;

/** Git commands that reach the network and therefore consume credentials. */
export const GIT_NETWORK_COMMANDS = ['push', 'pull', 'fetch'] as const;

export const ProjectGitInputSchema = z
  .object({
    ...WorkspaceMutationBaseShape,
    git: ProjectGitCommandSchema,
    timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  })
  .strict();
export type ProjectGitInput = z.infer<typeof ProjectGitInputSchema>;

export const ProjectGitResultSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    command: z.string().min(1).max(40),
    argv: z.string().min(1).max(400),
    used_network: z.boolean(),
    exit_code: z.number().int().nullable(),
    signal: z.string().max(40).nullable(),
    timed_out: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    stdout: z.string().max(102_400),
    stderr: z.string().max(102_400),
    truncated: z.boolean(),
  })
  .strict();
export type ProjectGitResult = z.infer<typeof ProjectGitResultSchema>;

export const LocalApplyOperationSchema = z.union([
  z
    .object({
      tool: z.literal('fs.edit'),
      path: z.string().min(1).max(4096),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      edits: z.array(FsEditOperationSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      tool: z.literal('fs.write'),
      path: z.string().min(1).max(4096),
      mode: z.literal('create'),
      content: z.string().max(512 * 1024),
    })
    .strict(),
  z
    .object({
      tool: z.literal('fs.write'),
      path: z.string().min(1).max(4096),
      mode: z.literal('replace'),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      content: z.string().max(512 * 1024),
    })
    .strict(),
  z
    .object({
      tool: z.literal('fs.mkdir'),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      tool: z.literal('fs.rename'),
      source_path: z.string().min(1).max(4096),
      destination_path: z.string().min(1).max(4096),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      tool: z.literal('fs.delete'),
      path: z.string().min(1).max(4096),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type LocalApplyOperation = z.infer<typeof LocalApplyOperationSchema>;

export const LocalApplyCheckSchema = z
  .object({
    task: ProjectRunTaskSchema,
    timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  })
  .strict();
export type LocalApplyCheck = z.infer<typeof LocalApplyCheckSchema>;

const bundleHasWork = (value: {
  operations: unknown[];
  checks: unknown[];
  git: unknown[];
}): boolean => value.operations.length > 0 || value.checks.length > 0 || value.git.length > 0;
const BUNDLE_WORK_MESSAGE =
  'A chatsplice.apply.v1 bundle needs at least one file operation, check, or git command.';

const LocalApplyBundleObjectSchema = z
  .object({
    format: z.enum(['chatsplice.apply.v1', 'localchat.apply.v1']),
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    idempotency_key: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{8,96}$/)
      .optional()
      .describe(
        'Reuse for retries of one logical request; choose a new key for an intentional new run.',
      ),
    operations: z.array(LocalApplyOperationSchema).max(20).default([]),
    checks: z.array(LocalApplyCheckSchema).max(3).default([]),
    git: z.array(ProjectGitCommandSchema).max(5).default([]),
  })
  .strict();

export const LocalApplyBundleSchema = LocalApplyBundleObjectSchema.refine(
  bundleHasWork,
  BUNDLE_WORK_MESSAGE,
);
export type LocalApplyBundle = z.infer<typeof LocalApplyBundleSchema>;

export const LocalApplyProposalIdSchema = z.string().regex(/^proposal_[a-f0-9]{24}$/);
export type LocalApplyProposalId = z.infer<typeof LocalApplyProposalIdSchema>;

export const LocalApplyProposalInputSchema = LocalApplyBundleObjectSchema.extend({
  workspace_binding: WorkspaceBindingSchema,
})
  .strict()
  .refine(bundleHasWork, BUNDLE_WORK_MESSAGE);
export type LocalApplyProposalInput = z.infer<typeof LocalApplyProposalInputSchema>;

export const LocalApplyStepResultSchema = z
  .object({
    tool: z.enum([
      'fs.edit',
      'fs.write',
      'fs.mkdir',
      'fs.rename',
      'fs.delete',
      'project.run',
      'project.git',
    ]),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2),
    summary: z.string().min(1).max(240),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    execution: z
      .object({
        exit_code: z.number().int().nullable(),
        timed_out: z.boolean(),
        stdout: z.string().max(16_384),
        stderr: z.string().max(16_384),
        truncated: z.boolean(),
        duration_ms: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LocalApplyStepResult = z.infer<typeof LocalApplyStepResultSchema>;

export const LocalApplyResultSchema = z
  .object({
    state: z.enum(['succeeded', 'failed']),
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    applied_steps: z.array(LocalApplyStepResultSchema).max(28),
    changed_paths: z.array(z.string().min(1).max(4096)).max(40),
    failed_step: z.number().int().nonnegative().max(27).nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();
export type LocalApplyResult = z.infer<typeof LocalApplyResultSchema>;

export const LocalApplyProposalStateSchema = z.enum([
  'pending_apply',
  'applying',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);
export type LocalApplyProposalState = z.infer<typeof LocalApplyProposalStateSchema>;

export const LocalApplyProposalStatusSchema = z
  .object({
    proposal_id: LocalApplyProposalIdSchema,
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    state: LocalApplyProposalStateSchema,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(40),
    operation_count: z.number().int().min(0).max(20),
    check_count: z.number().int().min(0).max(3),
    git_count: z.number().int().min(0).max(5).default(0),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    result: LocalApplyResultSchema.nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();
export type LocalApplyProposalStatus = z.infer<typeof LocalApplyProposalStatusSchema>;

export const LocalApplyProposalListResultSchema = z
  .object({
    proposals: z.array(LocalApplyProposalStatusSchema).max(500),
    count: z.number().int().nonnegative().max(500),
  })
  .strict();
export type LocalApplyProposalListResult = z.infer<typeof LocalApplyProposalListResultSchema>;

export const LocalApplyProposalClaimSchema = z
  .object({
    claim_id: z.string().regex(/^apply_claim_[a-f0-9]{24}$/),
    proposal: LocalApplyProposalStatusSchema,
    bundle: LocalApplyBundleSchema,
  })
  .strict();
export type LocalApplyProposalClaim = z.infer<typeof LocalApplyProposalClaimSchema>;

export const LocalApplyProposalClaimResultSchema = LocalApplyProposalClaimSchema.nullable();

export const LocalApplyProposalClaimActionInputSchema = z
  .object({
    claim_id: LocalApplyProposalClaimSchema.shape.claim_id,
  })
  .strict();
export type LocalApplyProposalClaimActionInput = z.infer<
  typeof LocalApplyProposalClaimActionInputSchema
>;

export const LocalApplyProposalCompletionInputSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      claim_id: LocalApplyProposalClaimSchema.shape.claim_id,
      outcome: z.literal('completed'),
      result: LocalApplyResultSchema,
    })
    .strict(),
  z
    .object({
      claim_id: LocalApplyProposalClaimSchema.shape.claim_id,
      outcome: z.literal('cancelled'),
      message: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      claim_id: LocalApplyProposalClaimSchema.shape.claim_id,
      outcome: z.literal('failed'),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);
export type LocalApplyProposalCompletionInput = z.infer<
  typeof LocalApplyProposalCompletionInputSchema
>;

export const LocalApplyProposalAwaitInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_binding: WorkspaceBindingSchema,
    proposal_id: LocalApplyProposalIdSchema,
    timeout_ms: z.number().int().min(0).max(30_000).default(30_000),
  })
  .strict();
export type LocalApplyProposalAwaitInput = z.infer<typeof LocalApplyProposalAwaitInputSchema>;

/**
 * A chat-initiated request for the owner to grant one new, ad-hoc read-only
 * reference by absolute path — approved locally in ChatSplice, never by the
 * chat itself. Approval creates a lightweight 'reference' workspace plus a
 * normal WorkspaceReference; it never appears as a project.
 */
export const ReferenceRequestIdSchema = z.string().regex(/^refreq_[a-f0-9]{24}$/);

export const ReferenceRequestStateSchema = z.enum([
  'pending_approval',
  'approved',
  'denied',
  'expired',
]);
export type ReferenceRequestState = z.infer<typeof ReferenceRequestStateSchema>;

export const ReferenceRequestInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_binding: WorkspaceBindingSchema,
    path: z.string().min(1).max(4096),
    label: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ReferenceRequestInput = z.infer<typeof ReferenceRequestInputSchema>;

export const ReferenceRequestStatusSchema = z
  .object({
    request_id: ReferenceRequestIdSchema,
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: z.string().min(1).max(4096),
    label: z.string().min(1).max(200).nullable(),
    state: ReferenceRequestStateSchema,
    reference_workspace_id: WorkspaceSummarySchema.shape.workspace_id.nullable(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    message: z.string().min(1).max(500),
  })
  .strict();
export type ReferenceRequestStatus = z.infer<typeof ReferenceRequestStatusSchema>;

export const ReferenceRequestListResultSchema = z
  .object({
    requests: z.array(ReferenceRequestStatusSchema).max(200),
    count: z.number().int().nonnegative().max(200),
  })
  .strict();
export type ReferenceRequestListResult = z.infer<typeof ReferenceRequestListResultSchema>;

export const ReferenceRequestAwaitInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_binding: WorkspaceBindingSchema,
    request_id: ReferenceRequestIdSchema,
    timeout_ms: z.number().int().min(0).max(30_000).default(30_000),
  })
  .strict();
export type ReferenceRequestAwaitInput = z.infer<typeof ReferenceRequestAwaitInputSchema>;

export const ReferenceRequestDecisionInputSchema = z
  .object({
    request_id: ReferenceRequestIdSchema,
    approved: z.boolean(),
  })
  .strict();
export type ReferenceRequestDecisionInput = z.infer<typeof ReferenceRequestDecisionInputSchema>;

export const DirectMcpToolSchema = z.enum([
  'fs.list',
  'fs.search',
  'fs.read',
  'fs.reference_list',
  'fs.reference_paths',
  'fs.reference_search',
  'fs.reference_read',
  'fs.reference_request',
  'fs.edit',
  'fs.write',
  'fs.mkdir',
  'fs.rename',
  'fs.delete',
  'project.run',
  'project.git',
  'local.prepare_apply',
]);
export type DirectMcpTool = z.infer<typeof DirectMcpToolSchema>;

export const DirectMcpActivityStateSchema = z.enum(['running', 'succeeded', 'failed']);
export type DirectMcpActivityState = z.infer<typeof DirectMcpActivityStateSchema>;

export const DirectMcpActivitySchema = z
  .object({
    activity_id: z.string().regex(/^activity_[a-f0-9]{24}$/),
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    source: z.enum(['mcp', 'local_apply']).default('mcp'),
    tool: DirectMcpToolSchema,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2),
    summary: z.string().min(1).max(240),
    state: DirectMcpActivityStateSchema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime().nullable(),
  })
  .strict();
export type DirectMcpActivity = z.infer<typeof DirectMcpActivitySchema>;

export const DirectEditActivitySchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    workspace_name: WorkspaceSummarySchema.shape.display_name,
    path: FsEditResultSchema.shape.path,
    replacements: FsEditResultSchema.shape.replacements,
    bytes_written: FsEditResultSchema.shape.bytes_written,
    completed_at: z.iso.datetime(),
  })
  .strict();
export type DirectEditActivity = z.infer<typeof DirectEditActivitySchema>;

export const TunnelConfigurationSchema = z
  .object({
    tunnel_id: z
      .string()
      .regex(/^tunnel_[A-Za-z0-9]+$/)
      .max(160),
    organization_id: z
      .string()
      .regex(/^org-[A-Za-z0-9]+$/)
      .max(160),
    executable_path: z.string().min(1).max(4096),
    automatic_start: z.boolean(),
  })
  .strict();
export type TunnelConfiguration = z.infer<typeof TunnelConfigurationSchema>;

export const TunnelStateSchema = z.enum([
  'unconfigured',
  'credential_missing',
  'stopped',
  'starting',
  'ready',
  'degraded',
  'failed',
]);
export type TunnelState = z.infer<typeof TunnelStateSchema>;

export const TunnelStatusSchema = z
  .object({
    mode: z.enum(['none', 'external', 'managed']),
    state: TunnelStateSchema,
    healthy: z.boolean(),
    ready: z.boolean(),
    configuration: TunnelConfigurationSchema.nullable(),
    detected_executable_path: z.string().min(1).max(4096).nullable(),
    detected_tunnel_id: z.string().max(160).nullable(),
    mcp_url: z.url().nullable(),
    admin_url: z.url().nullable(),
    error_code: z.string().min(1).max(160).nullable(),
  })
  .strict();
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const TunnelRuntimeApiKeySchema = z
  .string()
  .min(11)
  .max(2048)
  .regex(/^sk-[A-Za-z0-9_-]+$/);
export type TunnelRuntimeApiKey = z.infer<typeof TunnelRuntimeApiKeySchema>;

export const TunnelStartInputSchema = z
  .object({
    runtime_api_key: TunnelRuntimeApiKeySchema,
  })
  .strict();
export type TunnelStartInput = z.infer<typeof TunnelStartInputSchema>;

/**
 * A deliberately output-free result for `tunnel-client doctor --explain`.
 * Tunnel diagnostic output can contain environment-derived details, so the
 * renderer receives only a fixed, actionable result code.
 */
export const TunnelDoctorResultSchema = z
  .object({
    state: z.enum(['passed', 'failed']),
    error_code: z
      .enum([
        'tunnel_not_configured',
        'tunnel_client_not_found',
        'tunnel_doctor_launch_failed',
        'tunnel_doctor_failed',
        'tunnel_doctor_timed_out',
      ])
      .nullable(),
  })
  .strict();
export type TunnelDoctorResult = z.infer<typeof TunnelDoctorResultSchema>;

/**
 * Result of fetching and installing OpenAI's official `tunnel-client`
 * release. ChatSplice never bundles or forks this binary — it only downloads
 * the exact bytes OpenAI published for the current platform and verifies
 * them against OpenAI's own published checksums before running anything.
 */
export const TunnelClientInstallResultSchema = z
  .object({
    status: z.enum(['installed', 'already_installed', 'failed']),
    version: z.string().min(1).max(40).nullable(),
    executable_path: z.string().min(1).max(4096).nullable(),
    error_code: z
      .enum(['unsupported_platform', 'network_error', 'checksum_mismatch', 'extraction_failed'])
      .nullable(),
  })
  .strict();
export type TunnelClientInstallResult = z.infer<typeof TunnelClientInstallResultSchema>;

/**
 * Identifies which fixed OpenAI Platform page to open for a piece of tunnel
 * setup guidance. The renderer sends this key only — never a URL — so the
 * main process is the sole source of the destination it opens.
 */
export const TunnelSetupHelpTopicSchema = z.enum(['tunnel_id', 'organization_id', 'runtime_key']);
export type TunnelSetupHelpTopic = z.infer<typeof TunnelSetupHelpTopicSchema>;

/**
 * A single owner-controlled kill switch for every direct-MCP mutation tool
 * (fs.edit/fs.write/fs.mkdir/fs.rename/fs.delete/project.git) and the Pro
 * local-apply bridge (local.prepare_apply). Read/discovery tools stay
 * available. Mirrors the one-switch "read-only mode" pattern documented by
 * comparable local-MCP-bridge tools, adapted to ChatSplice's direct-MCP
 * tool set instead of a Chrome-extension-observed one.
 */
export const ReadOnlyModeStateSchema = z.object({ enabled: z.boolean() }).strict();
export type ReadOnlyModeState = z.infer<typeof ReadOnlyModeStateSchema>;

/**
 * Per-project, owner-controlled opt-in: while enabled, the desktop app
 * periodically re-selects the Local MCP app in that project's active
 * ChatGPT composer, so the owner does not have to pick it by hand on every
 * message. Off by default. This never grants a new capability by itself —
 * it only automates a click the owner could already make — and it fails
 * closed (does nothing) whenever ChatGPT's UI does not match.
 */
export const AutoAttachInputSchema = z
  .object({
    workspace_id: WorkspaceSummarySchema.shape.workspace_id,
    enabled: z.boolean(),
  })
  .strict();
export type AutoAttachInput = z.infer<typeof AutoAttachInputSchema>;

export const AutoAttachWorkspaceIdsSchema = z
  .array(WorkspaceSummarySchema.shape.workspace_id)
  .max(500);
export type AutoAttachWorkspaceIds = z.infer<typeof AutoAttachWorkspaceIdsSchema>;

/**
 * Display name of the custom ChatGPT app (Plugins → Create MCP App) that the
 * owner created for this bridge. It is only a label: the composer
 * auto-attach and the Project instructions refer to the app by this name.
 * It never affects the MCP server name, tools, or any permission.
 */
export const DEFAULT_MCP_APP_NAME = 'ChatSplice MCP';
export const LEGACY_MCP_APP_NAMES = ['Local MCP', '로컬 MCP'] as const;

export const McpAppNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}<>"`]+$/u, 'App name contains unsupported characters.');
export type McpAppName = z.infer<typeof McpAppNameSchema>;

export const McpAppNameInputSchema = z.object({ name: McpAppNameSchema }).strict();
export type McpAppNameInput = z.infer<typeof McpAppNameInputSchema>;

export const DaemonStatusSchema = z
  .object({
    protocol_version: z.literal(CONTROL_PROTOCOL_VERSION),
    healthy: z.boolean(),
    ready: z.boolean(),
    mcp_url: z.url().nullable(),
    workspace_count: z.number().int().nonnegative(),
    probe_workspace_id: z.string().nullable(),
    latest_direct_edits: z.array(DirectEditActivitySchema).max(500),
    latest_mcp_activities: z.array(DirectMcpActivitySchema).max(500),
    execution_jobs: z.array(ProjectExecSummarySchema).max(100).default([]),
    tunnel: TunnelStatusSchema,
    read_only_mode: z.boolean().default(false),
    auto_attach_workspace_ids: z
      .array(WorkspaceSummarySchema.shape.workspace_id)
      .max(500)
      .default([]),
    mcp_app_name: McpAppNameSchema.default(DEFAULT_MCP_APP_NAME),
  })
  .strict();
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

export const DesktopStatusSchema = z
  .object({
    daemon: DaemonStatusSchema,
    chatgpt_login_confirmed: z.boolean(),
    credential_store: z
      .object({
        available: z.boolean(),
        configured: z.boolean(),
        error_code: z.enum(['credential_unreadable']).nullable(),
      })
      .strict(),
  })
  .strict();
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;

export const ControlErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'INTERNAL_ERROR',
  'PATH_OUTSIDE_WORKSPACE',
  'PATH_NOT_FILE',
  'READ_ONLY_MODE_ENABLED',
  'SECRET_PATH_DENIED',
  'REFERENCE_NOT_ALLOWED',
  'UNSUPPORTED_ENCODING',
  'WORKSPACE_BINDING_REQUIRED',
  'WORKSPACE_NOT_FOUND',
]);
export type ControlErrorCode = z.infer<typeof ControlErrorCodeSchema>;

export const ControlErrorSchema = z
  .object({
    error: z
      .object({
        code: ControlErrorCodeSchema,
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export const DesktopApiSchema = z.object({
  getStatus: z.function(),
  getPanelState: z.function(),
  setPanelState: z.function(),
  listWorkspaceFiles: z.function(),
  readWorkspaceFile: z.function(),
  openWorkspaceTerminal: z.function(),
  openWorkspaceFinder: z.function(),
  submitProjectExec: z.function(),
  listTerminalSessions: z.function(),
  createTerminalSession: z.function(),
  readTerminalSession: z.function(),
  writeTerminalSession: z.function(),
  resizeTerminalSession: z.function(),
  closeTerminalSession: z.function(),
  listWorkspaces: z.function(),
  openWorkspace: z.function(),
  listWorkspaceReferences: z.function(),
  addWorkspaceReference: z.function(),
  removeWorkspaceReference: z.function(),
  copyProjectBinding: z.function(),
  automateChatGptProject: z.function(),
  listChatGptTabs: z.function(),
  createChatGptTab: z.function(),
  activateChatGptTab: z.function(),
  updateChatGptTab: z.function(),
  closeChatGptTab: z.function(),
  configureTunnel: z.function(),
  requestTunnelCredential: z.function(),
  checkTunnel: z.function(),
  startTunnel: z.function(),
  stopTunnel: z.function(),
  removeTunnelCredential: z.function(),
});
