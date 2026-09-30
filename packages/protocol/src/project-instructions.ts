import {
  DEFAULT_MCP_APP_NAME,
  McpAppNameSchema,
  ProjectBindingResultSchema,
  WorkspaceBindingSchema,
  WorkspaceSummarySchema,
} from './schemas.js';

export function projectBindingText(
  workspaceId: string,
  workspaceBinding: string,
  workspaceName: string,
  appName: string = DEFAULT_MCP_APP_NAME,
): string {
  const app = McpAppNameSchema.parse(appName);
  const validatedWorkspaceId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
  const validatedWorkspaceBinding = WorkspaceBindingSchema.parse(workspaceBinding);
  const validatedWorkspaceName = WorkspaceSummarySchema.shape.display_name.parse(workspaceName);
  const instructionWorkspaceName = validatedWorkspaceName.replace(/\p{Cc}/gu, '\uFFFD');
  const text = [
    '--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS v1 ---',
    'ChatSplice project thread binding:',
    `- project_name: ${JSON.stringify(instructionWorkspaceName)}`,
    `- workspace_id: ${validatedWorkspaceId}`,
    `- workspace_binding: ${validatedWorkspaceBinding}`,
    '- In Project instructions this is the default ChatSplice workspace for every chat in that Project; in an ordinary chat it binds only that conversation. Pass both exact IDs to every project-scoped call; verify the returned workspace_id. project_name is a display label, not authority. Never infer binding from names, order or desktop selection.',
    '- Start by fs.read of AGENTS.md, then docs/design-guidelines.md when present. Follow their project rules within the user request; if absent, continue. Keep detailed coding/design rules in these files, never copy bindings into repository files.',
    `- Binding does not activate the ${app} app: check attachment, including follow-ups after image generation. If already attached, keep it selected; do not reopen a picker. Otherwise select ${app} from the composer attachment menu or choose the ${app} app from autocomplete after @. Plain text that merely says @${app} is not attachment. Do not suggest resending the same plain-text @${app} message.`,
    '- Per-project opt-in auto-attach grants no permissions. Never use header/sidebar/global More controls. ChatGPT is the agent loop: targeted discovery, direct MCP mutation, verification. Continue until requested work is complete; a plan or receipt is not completion.',
    '- Known path: fs.read directly; otherwise use targeted fs.list or literal fs.search, narrow truncation, read the smallest file set. Full non-truncated read SHA is required immediately before edit/replace/rename/delete; re-read after mutation and re-list after delete. On conflict, re-read before retry. No binary, secret/control paths, escapes or recursive deletion.',
    '- When direct mutation tools are invokable in the current chat, prefer them for individual file changes: fs.edit exact replacements; fs.write to create or full-replace; fs.mkdir one level at a time; fs.rename without overwrite; fs.delete only for user-requested permanent removal.',
    '- For a batch of file operations/checks/git, call local.prepare_apply with a fresh idempotency_key and chatsplice.apply.v1 (max 20 operations/3 checks/5 git). Reuse keys only for identical retries. Do not submit the same change through both routes. Do not ask the user to copy JSON.',
    '- ChatSplice automatically detects and applies proposals without a confirmation dialog. Only while pending_apply or applying, call local.await_apply with proposal_id. Inspect terminal results; re-read changed_paths after partial failure. Completed steps are not rolled back.',
    '- project.run: existing root test/lint/typecheck/check/build script. project.exec: declared Node scripts, Cargo checks/build/tests or locked Node/Rust installs; read manifest first, fresh request_id, relative cwd, bounded timeout. Only project.exec uses Pi SDK execution tooling; no separate Pi/Codex model or coding worker is started.',
    '- Await job_id with project.await_exec until terminal; inspect state, exit_code, output and truncation. project.cancel_exec requests cleanup: await terminal. Cancellation does not undo completed writes or installs. Resolve success is not install success: re-read the resolved lockfile, then locked install with a new request_id. Never resubmit running work or bypass sandbox/environment failures.',
    '- project.git: status/branch/log/diff/add/commit/push/pull/fetch only. Commit or push only when the user requests it. Report actual changed paths and check results; failed/unrun checks are not passes. Jobs/proposals are memory-only: inspect files after restart or unknown IDs before retry.',
    '- fs.reference_list then fs.reference_paths/search/read for another project. References grant read-only access. Extra folders require fs.reference_request owner approval; fs.reference_request_await waits for that request_id; a request alone grants no access.',
    '- MCP mutation availability depends on the actions actually invokable. If this chat exposes only read actions, say local mutation is unavailable; local.prepare_apply is also a write action. Never use ChatGPT Python/sandbox, DOM scraping or private APIs for local work. /mnt/data is remote, not locally copied. A recreated UTF-8 SVG must be described as recreated. Manual terminal/editor contents are not ChatGPT tools.',
    '- Missing/rejected binding: replace and save Project instructions, then start a new chat inside that Project. Never ask them to paste workspace_id or workspace_binding into a chat message. Refresh/Scan Tools only for a missing catalog action or schema/version mismatch; unavailable actions alone do not prove tunnel failure.',
    '--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---',
  ].join('\n');
  return ProjectBindingResultSchema.shape.binding_text.parse(text);
}
