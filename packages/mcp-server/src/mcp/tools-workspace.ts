// Registers workspace.list and the fs.reference_* read-only cross-workspace tools.
import {
  listWorkspacePaths,
  readWorkspaceFile,
  searchWorkspaceText,
  ChatSpliceError,
} from '@chatsplice/core';
import {
  FsReferenceListInputSchema,
  FsReferenceListResultSchema,
  FsReferencePathsInputSchema,
  FsReferencePathsResultSchema,
  FsReferenceReadInputSchema,
  FsReferenceReadResultSchema,
  FsReferenceSearchInputSchema,
  FsReferenceSearchResultSchema,
  ReferenceRequestAwaitInputSchema,
  ReferenceRequestInputSchema,
  ReferenceRequestStatusSchema,
  WorkspaceListResultSchema,
} from '@chatsplice/protocol';
import * as z from 'zod/v4';

import { toolError } from './tool-error.js';
import type { McpToolContext } from './tool-context.js';

export function registerWorkspaceTools(ctx: McpToolContext): void {
  const {
    server,
    workspaceService,
    workspaceReferenceService,
    assertSourceBinding,
    assertMutationsAllowed,
    referenceRequestStore,
    directEditActivityStore,
  } = ctx;

  server.registerTool(
    'workspace.list',
    {
      title: 'List ChatSplice Workspaces',
      description:
        'Discover registered ChatSplice workspace labels and immutable IDs. Never select a workspace by list order, label similarity, desktop selection, or prior conversation. workspace.list does not return the workspace_binding required by other project-scoped tools. If the exact workspace_id and workspace_binding are not already present in the ChatGPT Project instructions or user message, stop and ask the user to copy the project binding from ChatSplice.',
      inputSchema: z.object({}).strict(),
      outputSchema: WorkspaceListResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const output = workspaceService.list();
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'fs.reference_list',
    {
      title: 'List Read-only Project References',
      description:
        'List only the ChatSplice projects explicitly linked as read-only references for this exact bound workspace. Call this before accessing another project. The result returns immutable reference_workspace_id values and names, never paths or bindings. Use a returned ID only with fs.reference_paths, fs.reference_search, or fs.reference_read. This tool never writes, runs checks, or grants any mutation authority over the referenced project.',
      inputSchema: FsReferenceListInputSchema,
      outputSchema: FsReferenceListResultSchema,
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
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const sourceWorkspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: sourceWorkspace.workspace_id,
          workspace_name: sourceWorkspace.display_name,
          tool: 'fs.reference_list',
          paths: ['읽기 전용 참조'],
          summary: '참조 프로젝트 확인 중',
        });
        activityId = activity.activity_id;
        const references = workspaceReferenceService.listTargets(sourceWorkspace.workspace_id);
        const output = FsReferenceListResultSchema.parse({
          source_workspace_id: sourceWorkspace.workspace_id,
          references,
          count: references.length,
        });
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: ['읽기 전용 참조'],
          summary: `${output.count}개 참조 프로젝트 확인`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '참조 프로젝트 확인 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.reference_paths',
    {
      title: 'List Paths in a Read-only Project Reference',
      description:
        'List bounded paths inside one reference_workspace_id previously returned by fs.reference_list. The source workspace binding is validated first, and ChatSplice verifies that this exact one-way read-only link exists. Use targeted path and glob values, respect pagination/truncation, and then read only the smallest needed files. This tool never writes, executes, or exposes the target workspace binding.',
      inputSchema: FsReferencePathsInputSchema,
      outputSchema: FsReferencePathsResultSchema,
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
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const sourceWorkspace = workspaceService.getRecord(input.workspace_id);
        const targetWorkspace = workspaceReferenceService.requireTarget(
          sourceWorkspace.workspace_id,
          input.reference_workspace_id,
        );
        const activity = directEditActivityStore.beginActivity({
          workspace_id: sourceWorkspace.workspace_id,
          workspace_name: sourceWorkspace.display_name,
          tool: 'fs.reference_paths',
          paths: [`${targetWorkspace.display_name}: ${input.path}`],
          summary: '참조 경로 목록 확인 중',
        });
        activityId = activity.activity_id;
        const listed = await listWorkspacePaths(workspaceService, {
          workspace_id: targetWorkspace.workspace_id,
          workspace_binding: input.workspace_binding,
          path: input.path,
          glob: input.glob,
          max_depth: input.max_depth,
          limit: input.limit,
          offset: input.offset,
          recursive: input.recursive,
        });
        const output = FsReferencePathsResultSchema.parse({
          ...listed,
          source_workspace_id: sourceWorkspace.workspace_id,
        });
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [`${targetWorkspace.display_name}: ${output.path}`],
          summary: `${output.count}개 참조 경로 확인${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '참조 경로 목록 확인 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.reference_search',
    {
      title: 'Search a Read-only Project Reference',
      description:
        'Search bounded UTF-8 text in one reference_workspace_id returned by fs.reference_list. ChatSplice validates the source binding and exact one-way read-only link before a literal search. Use a narrow path/glob and a single-line literal query; respect pagination/truncation and read only relevant matches. This tool never writes, executes, or exposes the target workspace binding.',
      inputSchema: FsReferenceSearchInputSchema,
      outputSchema: FsReferenceSearchResultSchema,
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
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const sourceWorkspace = workspaceService.getRecord(input.workspace_id);
        const targetWorkspace = workspaceReferenceService.requireTarget(
          sourceWorkspace.workspace_id,
          input.reference_workspace_id,
        );
        const activity = directEditActivityStore.beginActivity({
          workspace_id: sourceWorkspace.workspace_id,
          workspace_name: sourceWorkspace.display_name,
          tool: 'fs.reference_search',
          paths: [`${targetWorkspace.display_name}: ${input.path}`],
          summary: '참조 코드 위치 검색 중',
        });
        activityId = activity.activity_id;
        const searched = await searchWorkspaceText(workspaceService, {
          workspace_id: targetWorkspace.workspace_id,
          workspace_binding: input.workspace_binding,
          path: input.path,
          glob: input.glob,
          max_depth: input.max_depth,
          limit: input.limit,
          offset: input.offset,
          query: input.query,
          case_sensitive: input.case_sensitive,
        });
        const output = FsReferenceSearchResultSchema.parse({
          ...searched,
          source_workspace_id: sourceWorkspace.workspace_id,
        });
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [`${targetWorkspace.display_name}: ${output.path}`],
          summary: `${output.count}개 참조 위치 찾음${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '참조 코드 위치 검색 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.reference_read',
    {
      title: 'Read a File from a Read-only Project Reference',
      description:
        'Read one bounded UTF-8 file from a reference_workspace_id returned by fs.reference_list. ChatSplice first verifies the source workspace binding and that the explicit one-way read-only link exists. The result identifies both the bound source_workspace_id and the referenced workspace_id/name. It never writes, executes, or makes the target workspace mutable.',
      inputSchema: FsReferenceReadInputSchema,
      outputSchema: FsReferenceReadResultSchema,
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
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const sourceWorkspace = workspaceService.getRecord(input.workspace_id);
        const targetWorkspace = workspaceReferenceService.requireTarget(
          sourceWorkspace.workspace_id,
          input.reference_workspace_id,
        );
        const activity = directEditActivityStore.beginActivity({
          workspace_id: sourceWorkspace.workspace_id,
          workspace_name: sourceWorkspace.display_name,
          tool: 'fs.reference_read',
          paths: [`${targetWorkspace.display_name}: ${input.path}`],
          summary: '참조 파일 읽는 중',
        });
        activityId = activity.activity_id;
        const read = await readWorkspaceFile(workspaceService, {
          workspace_id: targetWorkspace.workspace_id,
          workspace_binding: input.workspace_binding,
          path: input.path,
          start_line: input.start_line,
          end_line: input.end_line,
          max_bytes: input.max_bytes,
        });
        const output = FsReferenceReadResultSchema.parse({
          ...read,
          source_workspace_id: sourceWorkspace.workspace_id,
        });
        directEditActivityStore.completeActivity(activity.activity_id, {
          paths: [`${targetWorkspace.display_name}: ${output.path}`],
          summary: `참조 파일 읽음${output.truncated ? ' (일부)' : ''}`,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: '참조 파일 읽기 실패' });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.reference_request',
    {
      title: 'Request an Ad-hoc Read-only Reference by Path',
      description:
        "Requests the owner's local approval to reference one absolute folder path outside the explicitly bound workspace, read-only. ChatSplice shows a native approval prompt on the owner's machine; nothing is granted until they approve it there, and this call never reads or lists that path itself. Poll the outcome with fs.reference_request_await using the returned request_id. Once approved, the path appears in fs.reference_list for this workspace and stays reachable only through fs.reference_paths/fs.reference_search/fs.reference_read — never for writes, and it is not added as a project.",
      inputSchema: ReferenceRequestInputSchema,
      outputSchema: ReferenceRequestStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertMutationsAllowed();
        const output = referenceRequestStore.submit(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'fs.reference_request_await',
    {
      title: 'Continuation Only — Existing Reference Request',
      description:
        'Continuation only: wait for a prior fs.reference_request decision using its returned request_id. Never use this for a new path; it does not create a request or grant access by itself.',
      inputSchema: ReferenceRequestAwaitInputSchema,
      outputSchema: ReferenceRequestStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const output = await referenceRequestStore.awaitResult(input.request_id, input.timeout_ms);
        if (output.workspace_id !== input.workspace_id) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'This reference request does not belong to the explicitly bound workspace.',
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
