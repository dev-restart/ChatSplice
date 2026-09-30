import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createServer, get } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  listWorkspacePaths,
  readWorkspaceEditorFile,
  readWorkspaceFile,
  saveWorkspaceEditorFile,
  ChatSpliceError,
  WorkspaceEditorConflictError,
} from '@chatsplice/core';
import type { WorkspaceReferenceService, WorkspaceService } from '@chatsplice/core';
import {
  AutoAttachInputSchema,
  McpAppNameInputSchema,
  ChatGptTabStateSchema,
  ControlErrorSchema,
  DaemonStatusSchema,
  LocalApplyProposalClaimActionInputSchema,
  LocalApplyProposalClaimResultSchema,
  LocalApplyProposalIdSchema,
  LocalApplyProposalListResultSchema,
  LocalApplyProposalStatusSchema,
  ProjectBindingRequestSchema,
  ReadOnlyModeStateSchema,
  ReferenceRequestDecisionInputSchema,
  ReferenceRequestListResultSchema,
  ReferenceRequestStatusSchema,
  RemoveWorkspaceInputSchema,
  RenameWorkspaceInputSchema,
  UpdateWorkspaceRootPathInputSchema,
  ProjectBindingResultSchema,
  RegisterWorkspaceInputSchema,
  TunnelConfigurationSchema,
  TunnelDoctorResultSchema,
  TunnelStartInputSchema,
  WorkspaceReferenceListResultSchema,
  WorkspaceReferenceMutationInputSchema,
  ProjectExecJobSchema,
  ProjectExecInputSchema,
  ProjectExecSubmitInputSchema,
  FsListInputSchema,
  FsReadInputSchema,
  FsListResultSchema,
  FsReadResultSchema,
  WorkspaceFileListInputSchema,
  WorkspaceFileReadInputSchema,
  WorkspaceEditorFileSchema,
  WorkspaceEditorReadInputSchema,
  WorkspaceEditorSaveInputSchema,
  ProjectExecSummarySchema,
  ProjectExecTargetSchema,
} from '@chatsplice/protocol';
import type { ControlErrorCode, DaemonStatus, WorkspaceBinding } from '@chatsplice/protocol';
import type { SettingsRepository } from '@chatsplice/core';

import { log } from '../logging.js';
import type { TunnelSupervisor } from '../tunnel/supervisor.js';
import type { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import { applyLocalBundle } from '../mutation/local-apply.js';
import type { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import type { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import type { ProjectExecutionService } from '../execution/service.js';

const MAX_CONTROL_BODY_BYTES = 1024 * 1024;
// A 1 MiB UTF-8 document plus JSON escaping and framing remains bounded
// without widening the limit for other control routes.
const EDITOR_JSON_ENVELOPE_BYTES = 64 * 1024;
const MAX_EDITOR_CONTROL_BODY_BYTES = 6 * 1024 * 1024 + EDITOR_JSON_ENVELOPE_BYTES;
const MUTATION_CAPABILITY_HEADER = 'x-chatsplice-control-mutation-token';
const LEGACY_MUTATION_CAPABILITY_HEADER = 'x-localchat-control-mutation-token';

export interface ControlServerRuntime {
  close(): Promise<void>;
}

interface ControlServerOptions {
  readonly socketPath: string;
  readonly workspaceService: WorkspaceService;
  readonly workspaceReferenceService: WorkspaceReferenceService;
  readonly status: () => DaemonStatus;
  readonly shutdown: () => void;
  readonly tunnelSupervisor: TunnelSupervisor;
  readonly settingsRepository: SettingsRepository;
  readonly projectBindingText: (workspaceId: string) => string;
  readonly localApplyWorkspaceBinding: (workspaceId: string) => WorkspaceBinding;
  readonly localApplyProposalStore: LocalApplyProposalStore;
  readonly referenceRequestStore: ReferenceRequestStore;
  readonly directEditActivityStore: DirectEditActivityStore;
  readonly mutationToken: string;
  /** Optional for older direct control-server tests; runtime always supplies it. */
  readonly executionService?: ProjectExecutionService;
}

function hasMutationCapability(request: IncomingMessage, expectedToken: string): boolean {
  const supplied =
    request.headers[MUTATION_CAPABILITY_HEADER] ??
    request.headers[LEGACY_MUTATION_CAPABILITY_HEADER];
  if (typeof supplied !== 'string') return false;
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new Error('Control request body is too large.');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

const EDITOR_ERROR_MESSAGES: Partial<Record<ControlErrorCode, string>> = {
  BAD_REQUEST: 'The workspace editor request was rejected.',
  PATH_OUTSIDE_WORKSPACE: 'The workspace editor path is outside the registered workspace.',
  PATH_NOT_FILE: 'The workspace editor requires a regular file.',
  SECRET_PATH_DENIED: 'The workspace editor cannot access this path.',
  UNSUPPORTED_ENCODING: 'The workspace editor supports valid UTF-8 text files only.',
  WORKSPACE_NOT_FOUND: 'The workspace is no longer registered.',
};

function workspaceEditorErrorResponse(
  error: unknown,
): { status: number; payload: { error: { code: ControlErrorCode; message: string } } } | undefined {
  if (error instanceof WorkspaceEditorConflictError) {
    return {
      status: 409,
      payload: {
        error: {
          code: 'BAD_REQUEST',
          message: 'The file changed after the editor read. Read it again and retry.',
        },
      },
    };
  }
  if (!(error instanceof ChatSpliceError)) return undefined;
  return {
    status: 400,
    payload: {
      error: {
        code: error.code,
        message: EDITOR_ERROR_MESSAGES[error.code] ?? 'The workspace editor request was rejected.',
      },
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function assertUserWorkspace(workspaceService: WorkspaceService, workspaceId: string): void {
  const workspace = workspaceService.getRecord(workspaceId);
  if (workspace.kind !== 'user') {
    throw new Error('The local project surface requires a registered user workspace.');
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const active = await new Promise<boolean>((resolve) => {
    const request = get({ socketPath, path: '/v1/status', timeout: 500 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(true);
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED');
    });
  });
  if (active) {
    throw new Error('Another chatspliced instance is already using the control socket.');
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

export async function startControlServer(
  options: ControlServerOptions,
): Promise<ControlServerRuntime> {
  await removeStaleSocket(options.socketPath);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://chatspliced');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        sendJson(response, 200, DaemonStatusSchema.parse(options.status()));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/execution-jobs') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        if (options.executionService === undefined) {
          sendJson(response, 404, {
            error: { code: 'BAD_REQUEST', message: 'Execution jobs are unavailable.' },
          });
          return;
        }
        const localInput = ProjectExecSubmitInputSchema.parse(await readJsonBody(request));
        assertUserWorkspace(options.workspaceService, localInput.workspace_id);
        const input = ProjectExecInputSchema.parse({
          ...localInput,
          workspace_binding: options.localApplyWorkspaceBinding(localInput.workspace_id),
        });
        sendJson(
          response,
          202,
          ProjectExecSummarySchema.parse(options.executionService.submit(input)),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workspace-files/list') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const localInput = WorkspaceFileListInputSchema.parse(await readJsonBody(request));
        assertUserWorkspace(options.workspaceService, localInput.workspace_id);
        const input = FsListInputSchema.parse({
          ...localInput,
          workspace_binding: options.localApplyWorkspaceBinding(localInput.workspace_id),
          glob: '**/*',
          recursive: false,
          max_depth: 1,
          limit: 200,
        });
        sendJson(
          response,
          200,
          FsListResultSchema.parse(await listWorkspacePaths(options.workspaceService, input)),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workspace-files/read') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const localInput = WorkspaceFileReadInputSchema.parse(await readJsonBody(request));
        assertUserWorkspace(options.workspaceService, localInput.workspace_id);
        const input = FsReadInputSchema.parse({
          ...localInput,
          workspace_binding: options.localApplyWorkspaceBinding(localInput.workspace_id),
        });
        sendJson(
          response,
          200,
          FsReadResultSchema.parse(await readWorkspaceFile(options.workspaceService, input)),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workspace-editor/read') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = WorkspaceEditorReadInputSchema.parse(
          await readJsonBody(request, MAX_EDITOR_CONTROL_BODY_BYTES),
        );
        assertUserWorkspace(options.workspaceService, input.workspace_id);
        sendJson(
          response,
          200,
          WorkspaceEditorFileSchema.parse(
            await readWorkspaceEditorFile(options.workspaceService, input),
          ),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workspace-editor/save') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = WorkspaceEditorSaveInputSchema.parse(
          await readJsonBody(request, MAX_EDITOR_CONTROL_BODY_BYTES),
        );
        assertUserWorkspace(options.workspaceService, input.workspace_id);
        sendJson(
          response,
          200,
          WorkspaceEditorFileSchema.parse(
            await saveWorkspaceEditorFile(options.workspaceService, input),
          ),
        );
        return;
      }
      const executionJobMatch = /^\/v1\/execution-jobs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && executionJobMatch?.[1] !== undefined) {
        if (options.executionService === undefined) {
          sendJson(response, 404, {
            error: { code: 'BAD_REQUEST', message: 'Execution jobs are unavailable.' },
          });
          return;
        }
        const target = ProjectExecTargetSchema.parse({
          workspace_id: url.searchParams.get('workspace_id'),
          job_id: decodeURIComponent(executionJobMatch[1]),
        });
        sendJson(
          response,
          200,
          ProjectExecJobSchema.parse(
            options.executionService.getJob(target.workspace_id, target.job_id),
          ),
        );
        return;
      }
      const executionCancelMatch = /^\/v1\/execution-jobs\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (request.method === 'POST' && executionCancelMatch?.[1] !== undefined) {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        if (options.executionService === undefined) {
          sendJson(response, 404, {
            error: { code: 'BAD_REQUEST', message: 'Execution jobs are unavailable.' },
          });
          return;
        }
        const body = ProjectExecTargetSchema.parse(await readJsonBody(request));
        const routeJobId = decodeURIComponent(executionCancelMatch[1]);
        if (body.job_id !== routeJobId) {
          sendJson(response, 400, {
            error: {
              code: 'BAD_REQUEST',
              message: 'The route job_id does not match the payload.',
            },
          });
          return;
        }
        sendJson(
          response,
          200,
          ProjectExecJobSchema.parse(
            options.executionService.cancel(body.workspace_id, body.job_id),
          ),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/workspaces') {
        sendJson(response, 200, options.workspaceService.listDetailed());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/workspace-references') {
        sendJson(
          response,
          200,
          WorkspaceReferenceListResultSchema.parse(options.workspaceReferenceService.list()),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/reference-requests') {
        sendJson(
          response,
          200,
          ReferenceRequestListResultSchema.parse(options.referenceRequestStore.list()),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/reference-requests/decision') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = ReferenceRequestDecisionInputSchema.parse(await readJsonBody(request));
        const pending = options.referenceRequestStore.getPending(input.request_id);
        if (pending === undefined) {
          sendJson(response, 404, {
            error: {
              code: 'BAD_REQUEST',
              message: 'The reference request does not exist or expired.',
            },
          });
          return;
        }
        if (!input.approved) {
          sendJson(
            response,
            200,
            ReferenceRequestStatusSchema.parse(
              options.referenceRequestStore.resolve(input.request_id, { approved: false }),
            ),
          );
          return;
        }
        const registered = await options.workspaceService.register(
          { root_path: pending.path },
          'reference',
        );
        options.workspaceReferenceService.add({
          source_workspace_id: pending.workspace_id,
          reference_workspace_id: registered.workspace_id,
        });
        sendJson(
          response,
          200,
          ReferenceRequestStatusSchema.parse(
            options.referenceRequestStore.resolve(input.request_id, {
              approved: true,
              referenceWorkspaceId: registered.workspace_id,
            }),
          ),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/local-apply-proposals') {
        sendJson(
          response,
          200,
          LocalApplyProposalListResultSchema.parse(options.localApplyProposalStore.list()),
        );
        return;
      }
      const claimLocalApplyMatch = /^\/v1\/local-apply-proposals\/([^/]+)\/claim$/u.exec(
        url.pathname,
      );
      if (request.method === 'POST' && claimLocalApplyMatch?.[1] !== undefined) {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const proposalId = LocalApplyProposalIdSchema.parse(
          decodeURIComponent(claimLocalApplyMatch[1]),
        );
        sendJson(
          response,
          200,
          LocalApplyProposalClaimResultSchema.parse(
            options.localApplyProposalStore.claim(proposalId),
          ),
        );
        return;
      }
      const localApplyClaimActionMatch =
        /^\/v1\/local-apply-claims\/([^/]+)\/(execute|release)$/u.exec(url.pathname);
      if (
        request.method === 'POST' &&
        localApplyClaimActionMatch?.[1] !== undefined &&
        localApplyClaimActionMatch[2] !== undefined
      ) {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = LocalApplyProposalClaimActionInputSchema.parse({
          claim_id: decodeURIComponent(localApplyClaimActionMatch[1]),
        });
        if (localApplyClaimActionMatch[2] === 'execute') {
          sendJson(
            response,
            202,
            LocalApplyProposalStatusSchema.nullable().parse(
              options.localApplyProposalStore.execute(input.claim_id, (bundle) =>
                applyLocalBundle(
                  options.workspaceService,
                  options.directEditActivityStore,
                  options.localApplyWorkspaceBinding(bundle.workspace_id),
                  bundle,
                ),
              ) ?? null,
            ),
          );
          return;
        }
        if (localApplyClaimActionMatch[2] === 'release') {
          sendJson(
            response,
            200,
            LocalApplyProposalListResultSchema.parse(
              options.localApplyProposalStore.release(input.claim_id),
            ),
          );
          return;
        }
      }
      if (request.method === 'PUT' && url.pathname === '/v1/workspace-references') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = WorkspaceReferenceMutationInputSchema.parse(await readJsonBody(request));
        sendJson(response, 200, options.workspaceReferenceService.add(input));
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/v1/workspace-references') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = WorkspaceReferenceMutationInputSchema.parse(await readJsonBody(request));
        sendJson(response, 200, options.workspaceReferenceService.remove(input));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workspaces') {
        const input = RegisterWorkspaceInputSchema.parse(await readJsonBody(request));
        sendJson(response, 201, await options.workspaceService.register(input));
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/workspaces/name') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = RenameWorkspaceInputSchema.parse(await readJsonBody(request));
        const workspace = options.workspaceService.getRecord(input.workspace_id);
        if (options.workspaceService.operations.isBusy(workspace.rootPath)) {
          sendJson(response, 400, {
            error: {
              code: 'BAD_REQUEST',
              message: 'This workspace has queued or running operations.',
            },
          });
          return;
        }
        sendJson(
          response,
          200,
          options.workspaceService.rename(input.workspace_id, input.display_name),
        );
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/workspaces/root-path') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = UpdateWorkspaceRootPathInputSchema.parse(await readJsonBody(request));
        sendJson(
          response,
          200,
          await options.workspaceService.updateRootPath(input.workspace_id, input.root_path),
        );
        return;
      }
      const removeWorkspaceMatch = /^\/v1\/workspaces\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'DELETE' && removeWorkspaceMatch?.[1] !== undefined) {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = RemoveWorkspaceInputSchema.parse({
          workspace_id: decodeURIComponent(removeWorkspaceMatch[1]),
        });
        const result = options.workspaceService.remove(input.workspace_id);
        options.localApplyProposalStore.removeWorkspace(input.workspace_id);
        options.referenceRequestStore.removeWorkspace(input.workspace_id);
        options.directEditActivityStore.removeWorkspace(input.workspace_id);
        options.workspaceReferenceService.removeWorkspace(input.workspace_id);
        options.settingsRepository.removeAutoAttach(input.workspace_id);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/project-binding') {
        const input = ProjectBindingRequestSchema.parse(await readJsonBody(request));
        options.workspaceService.getRecord(input.workspace_id);
        sendJson(
          response,
          200,
          ProjectBindingResultSchema.parse({
            binding_text: options.projectBindingText(input.workspace_id),
          }),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/chatgpt-tabs') {
        sendJson(response, 200, options.settingsRepository.getChatGptTabState() ?? null);
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/chatgpt-tabs') {
        const input = ChatGptTabStateSchema.parse(await readJsonBody(request));
        sendJson(response, 200, options.settingsRepository.setChatGptTabState(input));
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/tunnel/configuration') {
        const input = TunnelConfigurationSchema.parse(await readJsonBody(request));
        sendJson(response, 200, await options.tunnelSupervisor.configure(input));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/tunnel/start') {
        const input = TunnelStartInputSchema.parse(await readJsonBody(request));
        sendJson(response, 200, await options.tunnelSupervisor.start(input));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/tunnel/doctor') {
        const input = TunnelStartInputSchema.parse(await readJsonBody(request));
        sendJson(
          response,
          200,
          TunnelDoctorResultSchema.parse(await options.tunnelSupervisor.doctor(input)),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/tunnel/stop') {
        sendJson(response, 200, await options.tunnelSupervisor.stop());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/tunnel/install') {
        sendJson(response, 200, await options.tunnelSupervisor.install());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/read-only-mode') {
        sendJson(
          response,
          200,
          ReadOnlyModeStateSchema.parse({ enabled: options.settingsRepository.getReadOnlyMode() }),
        );
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/read-only-mode') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = ReadOnlyModeStateSchema.parse(await readJsonBody(request));
        sendJson(
          response,
          200,
          ReadOnlyModeStateSchema.parse({
            enabled: options.settingsRepository.setReadOnlyMode(input.enabled),
          }),
        );
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/auto-attach') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = AutoAttachInputSchema.parse(await readJsonBody(request));
        options.workspaceService.getRecord(input.workspace_id);
        sendJson(
          response,
          200,
          options.settingsRepository.setAutoAttach(input.workspace_id, input.enabled),
        );
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/v1/mcp-app-name') {
        if (!hasMutationCapability(request, options.mutationToken)) {
          sendJson(response, 403, {
            error: { code: 'BAD_REQUEST', message: 'Desktop mutation capability required.' },
          });
          return;
        }
        const input = McpAppNameInputSchema.parse(await readJsonBody(request));
        sendJson(response, 200, {
          name: options.settingsRepository.setMcpAppName(input.name),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
        sendJson(response, 202, { accepted: true });
        setTimeout(options.shutdown, 25).unref();
        return;
      }
      sendJson(response, 404, { error: { code: 'BAD_REQUEST', message: 'Unknown route.' } });
    })().catch((error: unknown) => {
      log('warn', 'control_request_rejected', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      if (!response.headersSent) {
        const editorError =
          request.method === 'POST' &&
          (request.url === '/v1/workspace-editor/read' ||
            request.url === '/v1/workspace-editor/save')
            ? workspaceEditorErrorResponse(error)
            : undefined;
        sendJson(
          response,
          editorError?.status ?? 400,
          ControlErrorSchema.parse(
            editorError?.payload ?? {
              error: { code: 'BAD_REQUEST', message: 'Invalid control request.' },
            },
          ),
        );
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => resolve());
  });
  await chmod(options.socketPath, 0o600);

  return {
    async close(): Promise<void> {
      await closeServer(server);
      await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    },
  };
}
