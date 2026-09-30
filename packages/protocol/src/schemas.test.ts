import { describe, expect, it } from 'vitest';

import { ProjectExecSubmitInputSchema } from './execution.js';

import {
  ChatGptTabStateSchema,
  CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH,
  AutomateChatGptProjectInputSchema,
  FsDeleteInputSchema,
  FsEditInputSchema,
  FsListInputSchema,
  FsMkdirInputSchema,
  FsReferenceListInputSchema,
  FsReferenceReadInputSchema,
  FsReferenceSearchInputSchema,
  FsRenameInputSchema,
  FsSearchInputSchema,
  FsWriteInputSchema,
  IPC_CHANNELS,
  LocalApplyBundleSchema,
  LocalApplyProposalStateSchema,
  ProjectGitCommandSchema,
  ProjectGitInputSchema,
  ProjectRunInputSchema,
  RemoveWorkspaceInputSchema,
  UpdateChatGptTabInputSchema,
  FsReadInputSchema,
  PanelStatePatchSchema,
  PanelStateSchema,
  WorkspaceFileListInputSchema,
  WorkspaceFileReadInputSchema,
  WorkspaceSummarySchema,
  TunnelRuntimeApiKeySchema,
  TunnelDoctorResultSchema,
  WorkspaceReferenceMutationInputSchema,
} from './schemas.js';
import { projectBindingText } from './project-instructions.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

describe('protocol schemas', () => {
  it('accepts only OpenAI-shaped Secure MCP Tunnel runtime keys', () => {
    expect(TunnelRuntimeApiKeySchema.safeParse('runtime-key').success).toBe(false);
    expect(TunnelRuntimeApiKeySchema.safeParse('sk-12345678').success).toBe(true);
  });

  it('keeps tunnel doctor results output-free and bounded to fixed error codes', () => {
    expect(TunnelDoctorResultSchema.parse({ state: 'passed', error_code: null })).toEqual({
      state: 'passed',
      error_code: null,
    });
    expect(() =>
      TunnelDoctorResultSchema.parse({
        state: 'failed',
        error_code: 'runtime_api_key=sk-secret',
      }),
    ).toThrow();
  });

  it('rejects unknown filesystem arguments', () => {
    expect(() =>
      FsReadInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'README.md',
        unexpected: true,
      }),
    ).toThrow();
  });

  it('requires a valid immutable workspace ID', () => {
    expect(() =>
      WorkspaceSummarySchema.parse({
        workspace_id: 'current',
        display_name: 'unsafe',
        kind: 'user',
        created_at: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('creates a binding without an absolute path', () => {
    const text = projectBindingText('ws_0123456789abcdef01234567', WORKSPACE_BINDING, 'netring');
    expect(text).toContain('ws_0123456789abcdef01234567');
    expect(text).toContain(WORKSPACE_BINDING);
    expect(text).toContain('project_name: "netring"');
    expect(text).toContain('default ChatSplice workspace for every chat in that Project');
    expect(text).toContain('it binds only that conversation');
    expect(text).toContain('targeted discovery, direct MCP mutation, verification');
    expect(text).toContain('use targeted fs.list or literal fs.search');
    expect(text).toContain('ChatGPT is the agent loop');
    expect(text).toContain('fs.write to create or full-replace');
    expect(text).toContain('fs.mkdir one level at a time');
    expect(text).toContain('project.run');
    expect(text).toContain('no separate Pi/Codex model or coding worker is started');
    expect(text).toContain('Never use ChatGPT Python/sandbox');
    expect(text).toContain('does not activate the ChatSplice MCP app');
    expect(text).toContain('including follow-ups after image generation');
    expect(text).toContain('/mnt/data');
    expect(text).toContain('select ChatSplice MCP from the composer attachment menu');
    expect(text).toContain('choose the ChatSplice MCP app from autocomplete');
    expect(text).toContain('Plain text that merely says @ChatSplice MCP');
    expect(text).toContain('Do not suggest resending the same plain-text @ChatSplice MCP message');
    expect(text).toContain('When direct mutation tools are invokable in the current chat');
    expect(text).toContain('MCP mutation availability depends on the actions actually invokable');
    expect(text).toContain('chatsplice.apply.v1');
    expect(text).toContain('call local.prepare_apply with a fresh idempotency_key');
    expect(text).toContain('automatically detects and applies');
    expect(text).toContain('without a confirmation dialog');
    expect(text).toMatch(/^--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS v1 ---$/mu);
    expect(text).toMatch(/^--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---$/mu);
    expect(text).not.toContain('native confirmation');
    expect(text).not.toContain('After approval');
    expect(text).toContain('Do not ask the user to copy JSON');
    expect(text).toContain('If this chat exposes only read actions');
    expect(text).not.toContain('manual ChatSplice fallback UI');
    expect(text).toContain('start a new chat inside that Project');
    expect(text).toContain(
      'Never ask them to paste workspace_id or workspace_binding into a chat message',
    );
    expect(text).not.toContain('In every new chat');
    expect(text).not.toContain('/Users/');
    expect(text.length).toBeLessThanOrEqual(CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH);
  });

  it('uses the configured ChatGPT app name in attachment guidance', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      WORKSPACE_BINDING,
      'netring',
      'Local MCP',
    );
    expect(text).toContain('does not activate the Local MCP app');
    expect(text).toContain('Plain text that merely says @Local MCP');
    expect(text).not.toContain('ChatSplice MCP app');
    expect(() =>
      projectBindingText('ws_0123456789abcdef01234567', WORKSPACE_BINDING, 'netring', 'a\nb'),
    ).toThrow();
  });

  it('describes direct files, batched apply and model-free execution without a retired fallback', () => {
    const text = projectBindingText('ws_0123456789abcdef01234567', WORKSPACE_BINDING, 'netring');

    expect(text).toContain('prefer them for individual file changes');
    expect(text).toContain('For a batch of file operations/checks/git');
    expect(text).toContain('Do not submit the same change through both routes');
    expect(text).toContain('Only project.exec uses Pi SDK execution tooling');
    expect(text).toContain('project.await_exec');
    expect(text).toContain('project.cancel_exec');
    expect(text).toContain('Cancellation does not undo completed writes or installs');
    expect(text).toContain('Resolve success is not install success');
    expect(text).toContain('Only while pending_apply or applying');
    expect(text).toContain('Completed steps are not rolled back');
    expect(text).toContain('Commit or push only when the user requests it');
    expect(text).not.toMatch(/code\.(?:request|await_result)|external worker|paid worker/u);
    expect(text).not.toContain('target local.prepare_apply as the start action');
  });

  it('preserves project identity through display-name changes and keeps reference access separate', () => {
    const workspaceId = 'ws_0123456789abcdef01234567';
    const first = projectBindingText(workspaceId, WORKSPACE_BINDING, 'Original');
    const renamed = projectBindingText(workspaceId, WORKSPACE_BINDING, 'Renamed');
    const otherBinding = `wb_${'1'.repeat(64)}`;
    const other = projectBindingText('ws_111111111111111111111111', otherBinding, 'Renamed');

    expect(renamed).toBe(first.replace('project_name: "Original"', 'project_name: "Renamed"'));
    expect(renamed).toContain(`- workspace_id: ${workspaceId}\n`);
    expect(renamed).toContain(`- workspace_binding: ${WORKSPACE_BINDING}\n`);
    expect(renamed).toContain('project_name is a display label');
    expect(renamed).not.toContain('workspace_name match this binding');
    expect(other).not.toContain(workspaceId);
    expect(other).not.toContain(WORKSPACE_BINDING);
    expect(other).toContain(`- workspace_binding: ${otherBinding}\n`);
    expect(renamed).toContain('fs.reference_request_await');
    expect(renamed).toContain('a request alone grants no access');
    expect(renamed).toContain('References grant read-only access');
  });

  it('keeps an existing app attachment without promising permissions or opening unrelated menus', () => {
    const text = projectBindingText('ws_0123456789abcdef01234567', WORKSPACE_BINDING, 'netring');

    expect(text).toContain('If already attached, keep it selected; do not reopen a picker');
    expect(text).toContain('Per-project opt-in auto-attach');
    expect(text).toContain('Never use header/sidebar/global More controls');
    expect(text).toContain('local.prepare_apply is also a write action');
    expect(text).not.toContain('App selection applies to one message');
    expect(text).not.toContain('do not inherit app selection');
  });

  it('keeps a maximally JSON-escaped workspace name below the observed field limit', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      WORKSPACE_BINDING,
      '\\"'.repeat(60),
    );

    expect(text.length).toBeLessThanOrEqual(CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH);
    expect(text.length).toBeLessThanOrEqual(8_000);
  });

  it('keeps control-character workspace names inside the Project instructions limit', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      WORKSPACE_BINDING,
      '\u0001'.repeat(120),
    );

    expect(text).not.toContain('\\u0001');
    expect(text.length).toBeLessThanOrEqual(CHATGPT_PROJECT_INSTRUCTIONS_MAX_LENGTH);
  });

  it('keeps generated startup instructions concise and loads detailed project rules from files', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      WORKSPACE_BINDING,
      '\\"'.repeat(60),
      'a'.repeat(40),
    );
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('docs/design-guidelines.md');
    expect(text).toContain('never copy bindings into repository files');
    expect(text.length).toBeLessThan(6_000);
  });

  it('accepts only bounded ChatSplice apply bundles', () => {
    const bundle = LocalApplyBundleSchema.parse({
      format: 'chatsplice.apply.v1',
      workspace_id: 'ws_0123456789abcdef01234567',
      operations: [
        {
          tool: 'fs.edit',
          path: 'README.md',
          expected_sha256: 'a'.repeat(64),
          edits: [{ old_text: 'before', new_text: 'after', replace_all: false }],
        },
      ],
      checks: [{ task: 'check', timeout_ms: 30_000 }],
    });
    expect(bundle.operations[0]?.tool).toBe('fs.edit');
    expect(LocalApplyBundleSchema.parse({ ...bundle, format: 'localchat.apply.v1' }).format).toBe(
      'localchat.apply.v1',
    );
    expect(() =>
      LocalApplyBundleSchema.parse({
        ...bundle,
        operations: [{ tool: 'project.run', command: 'rm -rf .' }],
      }),
    ).toThrow();
  });

  it('accepts checks-only and git-only apply bundles but rejects an empty one', () => {
    const checksOnlyBundle = LocalApplyBundleSchema.parse({
      format: 'chatsplice.apply.v1',
      workspace_id: 'ws_0123456789abcdef01234567',
      checks: [{ task: 'typecheck' }],
    });
    expect(checksOnlyBundle.operations).toEqual([]);
    expect(checksOnlyBundle.checks).toEqual([{ task: 'typecheck', timeout_ms: 60_000 }]);
    expect(checksOnlyBundle.git).toEqual([]);

    const bundle = LocalApplyBundleSchema.parse({
      format: 'chatsplice.apply.v1',
      workspace_id: 'ws_0123456789abcdef01234567',
      git: [
        { command: 'add', all: true },
        { command: 'commit', message: 'Ship it' },
      ],
    });
    expect(bundle.operations).toEqual([]);
    expect(bundle.git).toHaveLength(2);
    expect(() =>
      LocalApplyBundleSchema.parse({
        format: 'chatsplice.apply.v1',
        workspace_id: 'ws_0123456789abcdef01234567',
      }),
    ).toThrow();
  });

  it('reports automatic apply proposals as pending_apply without implying user confirmation', () => {
    expect(LocalApplyProposalStateSchema.parse('pending_apply')).toBe('pending_apply');
    expect(LocalApplyProposalStateSchema.safeParse('pending_user_confirmation').success).toBe(
      false,
    );
  });

  it('bounds project.git to a structured command allowlist', () => {
    expect(ProjectGitCommandSchema.parse({ command: 'push' })).toMatchObject({
      command: 'push',
      remote: 'origin',
      set_upstream: false,
    });
    expect(ProjectGitCommandSchema.parse({ command: 'commit', message: 'ok' }).command).toBe(
      'commit',
    );
    // commit requires a message.
    expect(() => ProjectGitCommandSchema.parse({ command: 'commit' })).toThrow();
    // add needs all=true or explicit paths.
    expect(() => ProjectGitCommandSchema.parse({ command: 'add' })).toThrow();
    // a ref may not smuggle a flag.
    expect(() =>
      ProjectGitCommandSchema.parse({ command: 'push', remote: '--upload-pack=x' }),
    ).toThrow();
    // a path may not traverse outside the workspace.
    expect(() =>
      ProjectGitCommandSchema.parse({ command: 'diff', paths: ['../secret'] }),
    ).toThrow();
    // there is no arbitrary command.
    expect(() => ProjectGitCommandSchema.parse({ command: 'rev-parse' })).toThrow();
    // the full input still requires the workspace binding.
    expect(() =>
      ProjectGitInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        git: { command: 'status' },
      }),
    ).toThrow();
  });

  it('requires an exact read hash and bounded replacement set for direct edits', () => {
    expect(
      FsEditInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'README.md',
        expected_sha256: '1'.repeat(64),
        edits: [{ old_text: 'before', new_text: 'after' }],
      }),
    ).toMatchObject({
      path: 'README.md',
      edits: [{ old_text: 'before', new_text: 'after', replace_all: false }],
    });
    expect(() =>
      FsEditInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'README.md',
        expected_sha256: 'stale',
        edits: [{ old_text: 'before', new_text: 'after' }],
      }),
    ).toThrow();
  });

  it('keeps direct file lifecycle and project checks narrow and explicitly bound', () => {
    expect(
      FsWriteInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'src/new.ts',
        mode: 'create',
        content: 'export {};\n',
      }),
    ).toMatchObject({ mode: 'create', path: 'src/new.ts' });
    expect(() =>
      FsWriteInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'src/new.ts',
        mode: 'replace',
        content: 'export {};\n',
      }),
    ).toThrow();
    expect(
      FsMkdirInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'src',
      }),
    ).toMatchObject({ path: 'src' });
    expect(
      FsRenameInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        source_path: 'before.ts',
        destination_path: 'after.ts',
        expected_sha256: '1'.repeat(64),
      }),
    ).toMatchObject({ destination_path: 'after.ts' });
    expect(
      FsDeleteInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        path: 'obsolete.ts',
        expected_sha256: '1'.repeat(64),
      }),
    ).toMatchObject({ path: 'obsolete.ts' });
    expect(
      ProjectRunInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        task: 'typecheck',
      }),
    ).toMatchObject({ task: 'typecheck', timeout_ms: 60_000 });
    expect(() =>
      ProjectRunInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        task: 'deploy',
      }),
    ).toThrow();
  });

  it('keeps workspace discovery bounded and literal', () => {
    expect(
      FsListInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
      }),
    ).toMatchObject({
      path: '.',
      glob: '**/*',
      recursive: false,
      max_depth: 6,
      limit: 100,
      offset: 0,
    });
    expect(
      FsSearchInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        query: 'literal text',
      }),
    ).toMatchObject({ case_sensitive: true, limit: 30 });
    expect(() =>
      FsSearchInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        query: 'first\nsecond',
      }),
    ).toThrow();
    expect(() =>
      FsListInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_binding: WORKSPACE_BINDING,
        glob: '../**/*',
      }),
    ).toThrow();
  });

  it('requires an explicit one-way read-only reference before cross-project inspection', () => {
    const sourceWorkspaceId = 'ws_0123456789abcdef01234567';
    const referenceWorkspaceId = 'ws_abcdef0123456789abcdef01';
    expect(
      WorkspaceReferenceMutationInputSchema.parse({
        source_workspace_id: sourceWorkspaceId,
        reference_workspace_id: referenceWorkspaceId,
      }),
    ).toEqual({
      source_workspace_id: sourceWorkspaceId,
      reference_workspace_id: referenceWorkspaceId,
    });
    expect(() =>
      WorkspaceReferenceMutationInputSchema.parse({
        source_workspace_id: sourceWorkspaceId,
        reference_workspace_id: sourceWorkspaceId,
      }),
    ).toThrow();
    expect(
      FsReferenceListInputSchema.parse({
        workspace_id: sourceWorkspaceId,
        workspace_binding: WORKSPACE_BINDING,
      }),
    ).toMatchObject({ workspace_id: sourceWorkspaceId });
    expect(
      FsReferenceSearchInputSchema.parse({
        workspace_id: sourceWorkspaceId,
        workspace_binding: WORKSPACE_BINDING,
        reference_workspace_id: referenceWorkspaceId,
        query: 'shared contract',
      }),
    ).toMatchObject({ path: '.', glob: '**/*', case_sensitive: true, limit: 30 });
    expect(() =>
      FsReferenceReadInputSchema.parse({
        workspace_id: sourceWorkspaceId,
        workspace_binding: WORKSPACE_BINDING,
        reference_workspace_id: referenceWorkspaceId,
        path: 'README.md',
        unexpected: true,
      }),
    ).toThrow();
  });

  it('never exposes the removed Codex/Pi worker surface', () => {
    expect('copyMcpCheckPrompt' in IPC_CHANNELS).toBe(false);
    expect('applyClipboardPatch' in IPC_CHANNELS).toBe(false);
    expect('readCodeTaskClipboard' in IPC_CHANNELS).toBe(false);
    expect('copyCodeReviewPrompt' in IPC_CHANNELS).toBe(false);
    expect('getCodeTaskStatus' in IPC_CHANNELS).toBe(false);
    expect('listWorkspaceCodePolicies' in IPC_CHANNELS).toBe(false);
    expect('setWorkspaceCodePolicy' in IPC_CHANNELS).toBe(false);
    expect('listCodeHandoffs' in IPC_CHANNELS).toBe(false);
    expect('dismissCodeHandoff' in IPC_CHANNELS).toBe(false);
    expect('startCodeTask' in IPC_CHANNELS).toBe(false);
    expect('cancelCodeTask' in IPC_CHANNELS).toBe(false);
  });

  it('requires a project binding for filesystem reads', () => {
    expect(() =>
      FsReadInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        path: 'README.md',
      }),
    ).toThrow();
  });

  it('keeps owner panel and local project execution inputs bounded', () => {
    const workspaceId = 'ws_0123456789abcdef01234567';
    expect(
      PanelStateSchema.parse({
        workspace_id: workspaceId,
        console_open: true,
        files_open: false,
      }),
    ).toMatchObject({
      workspace_id: workspaceId,
      console_open: true,
      files_width: 340,
      console_height: 260,
    });
    expect(PanelStatePatchSchema.parse({ files_open: true })).toEqual({ files_open: true });
    expect(PanelStatePatchSchema.parse({ files_width: 480 })).toEqual({ files_width: 480 });
    expect(() => PanelStatePatchSchema.parse({ console_height: -1 })).toThrow();
    expect(() => PanelStatePatchSchema.parse({ workspace_id: '../escape' })).toThrow();
    expect(WorkspaceFileListInputSchema.parse({ workspace_id: workspaceId })).toMatchObject({
      path: '.',
      offset: 0,
    });
    expect(() =>
      WorkspaceFileListInputSchema.parse({ workspace_id: workspaceId, path: '../secret' }),
    ).toThrow();
    expect(() =>
      WorkspaceFileReadInputSchema.parse({ workspace_id: workspaceId, path: 'a/../secret' }),
    ).toThrow();
    expect(
      ProjectExecSubmitInputSchema.parse({
        workspace_id: workspaceId,
        request_id: 'desktop-request-1',
        operation: { kind: 'node_script', script: 'test' },
      }),
    ).toMatchObject({ cwd: '.', timeout_ms: 600_000 });
    expect(() =>
      ProjectExecSubmitInputSchema.parse({
        workspace_id: workspaceId,
        request_id: 'desktop-request-1',
        operation: { kind: 'node_script', script: 'test' },
        workspace_binding: WORKSPACE_BINDING,
      }),
    ).toThrow();
  });

  it('allows Project automation to identify only a registered workspace', () => {
    expect(
      AutomateChatGptProjectInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
      }),
    ).toEqual({ workspace_id: 'ws_0123456789abcdef01234567' });
    expect(() =>
      AutomateChatGptProjectInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        script: 'document.body.innerText',
      }),
    ).toThrow();
  });

  it('allows only an immutable workspace ID for local registry removal', () => {
    expect(
      RemoveWorkspaceInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
      }),
    ).toEqual({ workspace_id: 'ws_0123456789abcdef01234567' });
    expect(() =>
      RemoveWorkspaceInputSchema.parse({
        workspace_id: 'ws_0123456789abcdef01234567',
        delete_folder: true,
      }),
    ).toThrow();
  });

  it('requires a unique, existing active ChatSplice browser tab', () => {
    const tab = {
      chatgpt_tab_id: 'tab_0123456789abcdef01234567',
      workspace_id: null,
      label: '일반 대화',
      url: 'https://chatgpt.com/',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(() =>
      ChatGptTabStateSchema.parse({
        tabs: [tab, tab],
        active_tab_id: tab.chatgpt_tab_id,
      }),
    ).toThrow();
    expect(() =>
      ChatGptTabStateSchema.parse({
        tabs: [tab],
        active_tab_id: 'tab_abcdefabcdefabcdefabcdef',
      }),
    ).toThrow();
  });

  it('migrates saved browser tabs to an unconfirmed Project instructions state', () => {
    const timestamp = new Date().toISOString();
    const state = ChatGptTabStateSchema.parse({
      tabs: [
        {
          chatgpt_tab_id: 'tab_0123456789abcdef01234567',
          workspace_id: 'ws_0123456789abcdef01234567',
          label: '기존 프로젝트 대화',
          url: 'https://chatgpt.com/',
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      active_tab_id: 'tab_0123456789abcdef01234567',
    });

    expect(state.tabs[0]?.project_instructions_confirmed).toBe(false);
    expect(
      UpdateChatGptTabInputSchema.parse({
        chatgpt_tab_id: 'tab_0123456789abcdef01234567',
        project_instructions_confirmed: true,
      }),
    ).toMatchObject({ project_instructions_confirmed: true });
  });
});
