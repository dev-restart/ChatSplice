// Registers the eight fs.* workspace file lifecycle tools (list/search/read/edit/write/mkdir/rename/delete).
import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  listWorkspacePaths,
  ChatSpliceError,
  makeWorkspaceDirectory,
  readWorkspaceFile,
  renameWorkspaceFile,
  searchWorkspaceText,
  writeWorkspaceFile,
} from '@chatsplice/core';
import {
  FsEditInputSchema,
  FsEditResultSchema,
  FsDeleteInputSchema,
  FsDeleteResultSchema,
  FsListInputSchema,
  FsListResultSchema,
  FsMkdirInputSchema,
  FsMkdirResultSchema,
  FsReadInputSchema,
  FsReadResultSchema,
  FsRenameInputSchema,
  FsRenameResultSchema,
  FsSearchInputSchema,
  FsSearchResultSchema,
  FsWriteInputSchema,
  FsWriteResultSchema,
} from '@chatsplice/protocol';

import { workspaceBindingMatches } from '../workspace-binding.js';
import { toolError } from './tool-error.js';
import type { McpToolContext } from './tool-context.js';

export function registerFsTools(ctx: McpToolContext): void {
  const {
    server,
    workspaceService,
    bindingSecret,
    assertMutationsAllowed,
    directEditActivityStore,
  } = ctx;

  server.registerTool(
    'fs.list',
    {
      title: 'List Workspace Paths',
      description:
        "Browse one explicitly bound workspace directory without reading file contents. Use this only when the relevant path is not already known. path defaults to '.', recursive defaults to false, and glob supports bounded '*', '**', and '?' matching relative to path. Recursive results skip default generated directories, never follow symlinks, omit secret/control paths, and stop at a hard discovery cap. Respect has_more/next_offset for ordinary pagination; if truncated is true, narrow path, glob, or max_depth instead of repeating the same broad call. Then use fs.read only on the smallest relevant files. This tool never writes or executes files.",
      inputSchema: FsListInputSchema,
      outputSchema: FsListResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id. Do not discover another workspace by name.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.list',
          paths: [input.path],
          summary: '경로 목록 확인 중',
        });
        activityId = activity.activity_id;
        const output = await listWorkspacePaths(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: `${output.count}개 경로 확인${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '경로 목록 확인 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.search',
    {
      title: 'Search Workspace Text',
      description:
        "Search existing UTF-8 workspace files for one literal single-line query. Use a targeted path and glob such as '**/*.ts'; this is literal search, not regular expression execution. The search never follows symlinks, omits secret/control paths and default generated directories, skips binary or oversized files, bounds depth/files/bytes/results, and returns path, line, column, and a short line excerpt. Respect has_more/next_offset for ordinary pagination; if truncated is true, narrow path, glob, max_depth, or query rather than repeating the same broad call. Read only matched files needed for the task. This tool never writes or executes files.",
      inputSchema: FsSearchInputSchema,
      outputSchema: FsSearchResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id. Do not search another workspace by name.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.search',
          paths: [input.path],
          summary: '코드 위치 검색 중',
        });
        activityId = activity.activity_id;
        const output = await searchWorkspaceText(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: `${output.count}개 위치 찾음${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '코드 위치 검색 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.read',
    {
      title: 'Read a Workspace File',
      description:
        'Read one bounded UTF-8 text file from an explicitly bound ChatSplice workspace. Requires the exact workspace_id and workspace_binding copied into the ChatGPT Project instructions or the first message of this project thread, plus a relative path. Never substitute a workspace discovered by workspace.list. Rejects mismatched bindings, traversal, symlink escape, non-regular files, and default secret-file patterns. Returns the verified workspace_id and workspace_name with content, line metadata, a full-file SHA-256, and truncation status. Confirm those workspace fields match the thread binding before answering. This tool never writes or executes files.',
      inputSchema: FsReadInputSchema,
      outputSchema: FsReadResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id. Do not choose another workspace from workspace.list. Ask the user to copy the exact project binding from ChatSplice.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.read',
          paths: [input.path],
          summary: '파일 읽는 중',
        });
        activityId = activity.activity_id;
        const output = await readWorkspaceFile(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: `파일 읽음${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '파일 읽기 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.edit',
    {
      title: 'Edit a Workspace File Directly',
      description:
        'Default mutation path for small exact replacements in existing UTF-8 text files in the explicitly bound ChatSplice workspace. If a path is unknown, first narrow it with fs.list or literal fs.search. Then call a full non-truncated fs.read for each exact path and pass its sha256 with bounded exact old_text/new_text replacements. ChatSplice rejects stale hashes, ambiguous matches unless replace_all is explicit, traversal, symlink escape, probe workspaces, and secret paths. After success, re-read each changed file once. Use fs.write/fs.mkdir/fs.rename/fs.delete for lifecycle changes and project.run for bounded checks; multi-file work uses multiple direct MCP calls.',
      inputSchema: FsEditInputSchema,
      outputSchema: FsEditResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id. Do not choose another workspace from workspace.list.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.edit',
          paths: [input.path],
          summary: '파일 수정 처리 중',
        });
        activityId = activity.activity_id;
        const output = await editWorkspaceFile(workspaceService, input);
        directEditActivityStore.record(output);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: `${output.replacements}회 exact replacement`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '파일 수정 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.write',
    {
      title: 'Create or Replace a Workspace File',
      description:
        "Create one new UTF-8 text file or replace one existing UTF-8 text file in the explicitly bound user workspace. For mode 'create', the parent directory must already exist and the destination must not exist. For mode 'replace', first read the full non-truncated file with fs.read and pass its sha256 as expected_sha256. The operation is size bounded, secret-path denied, workspace confined, and atomic. Re-read the resulting path once before answering. Use multiple direct MCP calls for coherent multi-file changes.",
      inputSchema: FsWriteInputSchema,
      outputSchema: FsWriteResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.write',
          paths: [input.path],
          summary: input.mode === 'create' ? '파일 생성 처리 중' : '파일 교체 처리 중',
        });
        activityId = activity.activity_id;
        const output = await writeWorkspaceFile(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary:
            output.mode === 'create'
              ? `${output.bytes_written} bytes 파일 생성`
              : `${output.bytes_written} bytes 전체 교체`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '파일 쓰기 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.mkdir',
    {
      title: 'Create a Workspace Directory',
      description:
        'Create one new directory whose parent already exists inside the explicitly bound user workspace. The destination must not exist, must remain inside the canonical workspace root, and may not use a secret/control path or a symlinked parent. Create nested directories one level at a time, then use fs.write to create files.',
      inputSchema: FsMkdirInputSchema,
      outputSchema: FsMkdirResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.mkdir',
          paths: [input.path],
          summary: '디렉터리 생성 처리 중',
        });
        activityId = activity.activity_id;
        const output = await makeWorkspaceDirectory(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: '디렉터리 생성',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '디렉터리 생성 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.rename',
    {
      title: 'Rename a Workspace File',
      description:
        'Rename or move one existing regular UTF-8 text file inside the explicitly bound user workspace. First read the source with a full non-truncated fs.read and pass its sha256 as expected_sha256. The destination parent must already exist and the destination must not exist. Secret paths, symlink escape, stale hashes, directories, and overwrite are rejected. Read the destination once after success.',
      inputSchema: FsRenameInputSchema,
      outputSchema: FsRenameResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.rename',
          paths: [input.source_path, input.destination_path],
          summary: '파일 이름/위치 변경 처리 중',
        });
        activityId = activity.activity_id;
        const output = await renameWorkspaceFile(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.source_path, output.destination_path],
          summary: '파일 이름/위치 변경',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '파일 이름/위치 변경 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.delete',
    {
      title: 'Delete a Workspace File',
      description:
        'Permanently delete one existing regular UTF-8 text file from the explicitly bound user workspace. This is intentionally narrow and destructive: first read the full non-truncated source with fs.read and pass its sha256 as expected_sha256. Directories, stale hashes, secret paths, and symlink escape are rejected. Call this only when the user explicitly requested removal, and verify the path no longer appears after success.',
      inputSchema: FsDeleteInputSchema,
      outputSchema: FsDeleteResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'fs.delete',
          paths: [input.path],
          summary: '파일 삭제 처리 중',
        });
        activityId = activity.activity_id;
        const output = await deleteWorkspaceFile(workspaceService, input);
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [output.path],
          summary: '파일 영구 삭제',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '파일 삭제 실패' });
        }
        return toolError(error);
      }
    },
  );
}
