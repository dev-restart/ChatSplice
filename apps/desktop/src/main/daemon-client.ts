import { readFile } from 'node:fs/promises';
import { request } from 'node:http';

import {
  AutoAttachInputSchema,
  McpAppNameInputSchema,
  AutoAttachWorkspaceIdsSchema,
  ChatGptTabStateSchema,
  DaemonStatusSchema,
  CONTROL_PROTOCOL_VERSION,
  EXECUTION_CONTRACT_VERSION,
  ControlErrorSchema,
  LocalApplyProposalClaimActionInputSchema,
  LocalApplyProposalClaimResultSchema,
  LocalApplyProposalIdSchema,
  LocalApplyProposalListResultSchema,
  LocalApplyProposalStatusSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  ProjectExecSubmitInputSchema,
  ProjectExecTargetSchema,
  ProjectBindingRequestSchema,
  ProjectBindingResultSchema,
  ReadOnlyModeStateSchema,
  ReferenceRequestDecisionInputSchema,
  ReferenceRequestListResultSchema,
  ReferenceRequestStatusSchema,
  RemoveWorkspaceInputSchema,
  RenameWorkspaceInputSchema,
  UpdateWorkspaceRootPathInputSchema,
  RegisterWorkspaceInputSchema,
  WorkspaceDetailSchema,
  TunnelClientInstallResultSchema,
  TunnelConfigurationSchema,
  TunnelDoctorResultSchema,
  TunnelStartInputSchema,
  TunnelStatusSchema,
  WorkspaceDetailListResultSchema,
  WorkspaceFileListInputSchema,
  WorkspaceFileReadInputSchema,
  FsListResultSchema,
  FsReadResultSchema,
  GoalOwnerReadInputSchema,
  GoalOwnerUpdateInputSchema,
  GoalReadResultSchema,
  GoalUpdateResultSchema,
  WorkspaceEditorFileSchema,
  WorkspaceEditorReadInputSchema,
  WorkspaceEditorSaveInputSchema,
  WorkspaceSummarySchema,
  WorkspaceReferenceListResultSchema,
  WorkspaceReferenceMutationInputSchema,
  WorkspaceReferenceFolderInputSchema,
  WorkspaceReferenceAccessInputSchema,
  WorkspaceReferenceSchema,
} from '@chatsplice/protocol';
import type {
  AutoAttachInput,
  AutoAttachWorkspaceIds,
  ChatGptTabState,
  ControlErrorCode,
  DaemonStatus,
  LocalApplyProposalClaim,
  LocalApplyProposalListResult,
  LocalApplyProposalStatus,
  ProjectExecJob,
  ProjectExecSubmitInput,
  ProjectExecSummary,
  ProjectExecTarget,
  WorkspaceFileListInput,
  WorkspaceFileReadInput,
  FsListResult,
  FsReadResult,
  GoalOwnerReadInput,
  GoalOwnerUpdateInput,
  GoalReadResult,
  GoalUpdateResult,
  WorkspaceEditorFile,
  WorkspaceEditorReadInput,
  WorkspaceEditorSaveInput,
  ReadOnlyModeState,
  ReferenceRequestListResult,
  ReferenceRequestStatus,
  RegisterWorkspaceInput,
  RemoveWorkspaceInput,
  RenameWorkspaceInput,
  UpdateWorkspaceRootPathInput,
  WorkspaceDetail,
  TunnelClientInstallResult,
  TunnelConfiguration,
  TunnelDoctorResult,
  TunnelStartInput,
  TunnelStatus,
  WorkspaceDetailListResult,
  WorkspaceSummary,
  ProjectBindingResult,
  WorkspaceReference,
  WorkspaceReferenceListResult,
  WorkspaceReferenceMutationInput,
  WorkspaceReferenceFolderInput,
  WorkspaceReferenceAccessInput,
} from '@chatsplice/protocol';

import { getDesktopRuntimeIdentity } from './runtime-identity.js';
import type { DesktopRuntimeIdentity } from './runtime-identity.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Goal pages have a 2 MiB serialized budget plus an envelope; single records are at most 1 MiB.
const MAX_GOAL_RESPONSE_BYTES = 2 * 1024 * 1024 + 65_536;
const EDITOR_JSON_ENVELOPE_BYTES = 64 * 1024;
const MAX_EDITOR_RESPONSE_BYTES = 6 * 1024 * 1024 + EDITOR_JSON_ENVELOPE_BYTES;

function mutationCapabilityHeaders(token: string): Readonly<Record<string, string>> {
  return {
    'x-chatsplice-control-mutation-token': token,
    'x-localchat-control-mutation-token': token,
  };
}

export class IncompatibleDaemonError extends Error {
  public readonly runtimeDetails: string;

  public constructor(message: string, value?: unknown, expectedToolSchemaDigest?: string) {
    super(message);
    this.name = 'IncompatibleDaemonError';
    const details = [
      `Expected control: ${CONTROL_PROTOCOL_VERSION}`,
      `Expected execution: ${EXECUTION_CONTRACT_VERSION}`,
    ];
    if (
      expectedToolSchemaDigest !== undefined &&
      /^[a-f0-9]{64}$/u.test(expectedToolSchemaDigest)
    ) {
      details.push(`Expected tool_schema_digest: ${expectedToolSchemaDigest}`);
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of [
        'protocol_version',
        'execution_contract',
        'mcp_descriptor_version',
        'build_id',
        'run_id',
        'tool_count',
        'tool_schema_digest',
      ] as const) {
        const candidate = record[key];
        const valid =
          key === 'protocol_version' || key === 'tool_count'
            ? typeof candidate === 'number' &&
              Number.isInteger(candidate) &&
              candidate >= 0 &&
              candidate <= 10_000
            : typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(candidate);
        if (valid) details.push(`${key}: ${String(candidate)}`);
      }
    }
    this.runtimeDetails = details.join('\n');
  }
}

/** Compare verified catalog metadata without treating build-only changes as incompatibility. */
export function assertDaemonToolSchemaCompatibility(
  daemon: Pick<DaemonStatus, 'tool_schema_digest'>,
  desktop: Pick<DesktopRuntimeIdentity, 'status' | 'expected_tool_schema_digest'> | undefined,
): void {
  if (
    desktop?.status !== 'verified' ||
    desktop.expected_tool_schema_digest === null ||
    daemon.tool_schema_digest === undefined ||
    daemon.tool_schema_digest === desktop.expected_tool_schema_digest
  ) {
    return;
  }
  throw new IncompatibleDaemonError(
    'The running ChatSplice daemon advertises a different tool schema from this app. Preserve unsaved work and finish ongoing jobs, then normally close the previous app and its daemon before reopening ChatSplice. Refreshing ChatGPT tools is a separate step and does not restart the daemon.',
    daemon,
    desktop.expected_tool_schema_digest,
  );
}

export class DaemonControlError extends Error {
  public readonly code: ControlErrorCode;
  public readonly statusCode: number;

  public constructor(code: ControlErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'DaemonControlError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class DaemonClient {
  readonly #socketPath: string;
  readonly #mutationTokenPath: string;

  public constructor(socketPath: string, mutationTokenPath: string) {
    this.#socketPath = socketPath;
    this.#mutationTokenPath = mutationTokenPath;
  }

  async #request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
    timeoutMs = 2_000,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    preserveControlError = false,
  ): Promise<unknown> {
    const ownerToken = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/u.test(ownerToken)) {
      throw new Error('The private desktop control capability is invalid.');
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request_ = request(
        {
          socketPath: this.#socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: {
            ...extraHeaders,
            ...mutationCapabilityHeaders(ownerToken),
            ...(serialized === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(serialized),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Daemon response was interrupted.')));
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              response.destroy(new Error('Daemon response exceeded the size limit.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            let payload: unknown;
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new Error('Daemon returned invalid JSON.'));
              return;
            }
            const statusCode = response.statusCode ?? 500;
            if (statusCode >= 400) {
              if (preserveControlError) {
                const parsedError = ControlErrorSchema.safeParse(payload);
                if (parsedError.success) {
                  reject(
                    new DaemonControlError(
                      parsedError.data.error.code,
                      parsedError.data.error.message,
                      statusCode,
                    ),
                  );
                  return;
                }
              }
              reject(new Error('Daemon rejected the control request.'));
              return;
            }
            resolve(payload);
          });
        },
      );
      request_.on('timeout', () => request_.destroy(new Error('Daemon request timed out.')));
      request_.on('error', reject);
      if (serialized !== undefined) {
        request_.write(serialized);
      }
      request_.end();
    });
  }

  public async status(): Promise<DaemonStatus> {
    const value = await this.#request('GET', '/v1/status');
    if (
      typeof value === 'object' &&
      value !== null &&
      'protocol_version' in value &&
      value.protocol_version !== CONTROL_PROTOCOL_VERSION
    ) {
      throw new IncompatibleDaemonError(
        'A different ChatSplice daemon version is running. Close the old app and restart ChatSplice after its work finishes.',
        value,
      );
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      'protocol_version' in value &&
      value.protocol_version === CONTROL_PROTOCOL_VERSION &&
      (!('execution_contract' in value) || value.execution_contract !== EXECUTION_CONTRACT_VERSION)
    ) {
      throw new IncompatibleDaemonError(
        'A different ChatSplice execution contract is running. Preserve unsaved work and finish ongoing jobs, then normally close the old app and its daemon before restarting ChatSplice. Refreshing tools does not restart the daemon.',
        value,
      );
    }
    const status = DaemonStatusSchema.parse(value);
    assertDaemonToolSchemaCompatibility(status, getDesktopRuntimeIdentity());
    return status;
  }

  public async listWorkspaces(): Promise<WorkspaceDetailListResult> {
    return WorkspaceDetailListResultSchema.parse(await this.#request('GET', '/v1/workspaces'));
  }

  public async listGoals(input: GoalOwnerReadInput): Promise<GoalReadResult> {
    const validated = GoalOwnerReadInputSchema.parse(input);
    const query = new URLSearchParams({ workspace_id: validated.workspace_id });
    if (validated.goal_id !== undefined) query.set('goal_id', validated.goal_id);
    if (validated.offset !== undefined) query.set('offset', String(validated.offset));
    if (validated.limit !== undefined) query.set('limit', String(validated.limit));
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return GoalReadResultSchema.parse(
      await this.#request(
        'GET',
        `/v1/goals?${query}`,
        undefined,
        mutationCapabilityHeaders(token),
        10_000,
        MAX_GOAL_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async updateGoal(input: GoalOwnerUpdateInput): Promise<GoalUpdateResult> {
    const validated = GoalOwnerUpdateInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return GoalUpdateResultSchema.parse(
      await this.#request(
        'POST',
        '/v1/goals/update',
        validated,
        mutationCapabilityHeaders(token),
        30_000,
        MAX_GOAL_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async registerWorkspace(input: RegisterWorkspaceInput): Promise<WorkspaceSummary> {
    const validated = RegisterWorkspaceInputSchema.parse(input);
    return WorkspaceSummarySchema.parse(await this.#request('POST', '/v1/workspaces', validated));
  }

  public async renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceSummary> {
    const validated = RenameWorkspaceInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceSummarySchema.parse(
      await this.#request(
        'PUT',
        '/v1/workspaces/name',
        validated,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async updateWorkspaceRootPath(
    input: UpdateWorkspaceRootPathInput,
  ): Promise<WorkspaceDetail> {
    const validated = UpdateWorkspaceRootPathInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceDetailSchema.parse(
      await this.#request(
        'PUT',
        '/v1/workspaces/root-path',
        validated,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async listWorkspaceReferences(): Promise<WorkspaceReferenceListResult> {
    return WorkspaceReferenceListResultSchema.parse(
      await this.#request('GET', '/v1/workspace-references'),
    );
  }

  public async getExecutionJob(target: ProjectExecTarget): Promise<ProjectExecJob> {
    const validated = ProjectExecTargetSchema.parse(target);
    const query = new URLSearchParams({ workspace_id: validated.workspace_id });
    return ProjectExecJobSchema.parse(
      await this.#request(
        'GET',
        `/v1/execution-jobs/${encodeURIComponent(validated.job_id)}?${query.toString()}`,
      ),
    );
  }

  public async submitProjectExec(input: ProjectExecSubmitInput): Promise<ProjectExecSummary> {
    const validated = ProjectExecSubmitInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return ProjectExecSummarySchema.parse(
      await this.#request(
        'POST',
        '/v1/execution-jobs',
        validated,
        mutationCapabilityHeaders(token),
        2_000,
        MAX_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async cancelExecutionJob(target: ProjectExecTarget): Promise<ProjectExecJob> {
    const validated = ProjectExecTargetSchema.parse(target);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return ProjectExecJobSchema.parse(
      await this.#request(
        'POST',
        `/v1/execution-jobs/${encodeURIComponent(validated.job_id)}/cancel`,
        validated,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async listWorkspaceFiles(input: WorkspaceFileListInput): Promise<FsListResult> {
    const validated = WorkspaceFileListInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return FsListResultSchema.parse(
      await this.#request(
        'POST',
        '/v1/workspace-files/list',
        validated,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async readWorkspaceFile(input: WorkspaceFileReadInput): Promise<FsReadResult> {
    const validated = WorkspaceFileReadInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return FsReadResultSchema.parse(
      await this.#request(
        'POST',
        '/v1/workspace-files/read',
        validated,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async readWorkspaceEditorFile(
    input: WorkspaceEditorReadInput,
  ): Promise<WorkspaceEditorFile> {
    const validated = WorkspaceEditorReadInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceEditorFileSchema.parse(
      await this.#request(
        'POST',
        '/v1/workspace-editor/read',
        validated,
        mutationCapabilityHeaders(token),
        2_000,
        MAX_EDITOR_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async saveWorkspaceEditorFile(
    input: WorkspaceEditorSaveInput,
  ): Promise<WorkspaceEditorFile> {
    const validated = WorkspaceEditorSaveInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceEditorFileSchema.parse(
      await this.#request(
        'POST',
        '/v1/workspace-editor/save',
        validated,
        mutationCapabilityHeaders(token),
        2_000,
        MAX_EDITOR_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async listLocalApplyProposals(): Promise<LocalApplyProposalListResult> {
    return LocalApplyProposalListResultSchema.parse(
      await this.#request('GET', '/v1/local-apply-proposals'),
    );
  }

  public async claimLocalApplyProposal(
    proposalId: string,
  ): Promise<LocalApplyProposalClaim | null> {
    const validated = LocalApplyProposalIdSchema.parse(proposalId);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return LocalApplyProposalClaimResultSchema.parse(
      await this.#request(
        'POST',
        `/v1/local-apply-proposals/${encodeURIComponent(validated)}/claim`,
        {},
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async executeLocalApplyProposal(
    claimId: string,
  ): Promise<LocalApplyProposalStatus | null> {
    const input = LocalApplyProposalClaimActionInputSchema.parse({ claim_id: claimId });
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return LocalApplyProposalStatusSchema.nullable().parse(
      await this.#request(
        'POST',
        `/v1/local-apply-claims/${encodeURIComponent(input.claim_id)}/execute`,
        {},
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async releaseLocalApplyProposal(claimId: string): Promise<LocalApplyProposalListResult> {
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    const input = LocalApplyProposalClaimActionInputSchema.parse({ claim_id: claimId });
    return LocalApplyProposalListResultSchema.parse(
      await this.#request(
        'POST',
        `/v1/local-apply-claims/${encodeURIComponent(input.claim_id)}/release`,
        {},
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async listReferenceRequests(): Promise<ReferenceRequestListResult> {
    return ReferenceRequestListResultSchema.parse(
      await this.#request('GET', '/v1/reference-requests'),
    );
  }

  public async decideReferenceRequest(
    requestId: string,
    approved: boolean,
    accessMode?: NonNullable<ReferenceRequestStatus['access_mode']>,
  ): Promise<ReferenceRequestStatus> {
    const input = ReferenceRequestDecisionInputSchema.parse({
      request_id: requestId,
      approved,
      ...(accessMode === undefined ? {} : { access_mode: accessMode }),
    });
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return ReferenceRequestStatusSchema.parse(
      await this.#request(
        'POST',
        '/v1/reference-requests/decision',
        input,
        mutationCapabilityHeaders(token),
      ),
    );
  }

  public async addWorkspaceReference(
    input: WorkspaceReferenceMutationInput,
  ): Promise<WorkspaceReference> {
    const validated = WorkspaceReferenceMutationInputSchema.parse(input);
    const mutationToken = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceReferenceSchema.parse(
      await this.#request(
        'PUT',
        '/v1/workspace-references',
        validated,
        mutationCapabilityHeaders(mutationToken),
      ),
    );
  }

  public async addWorkspaceReferenceFolder(
    input: WorkspaceReferenceFolderInput,
  ): Promise<WorkspaceReference> {
    const validated = WorkspaceReferenceFolderInputSchema.parse(input);
    return WorkspaceReferenceSchema.parse(
      await this.#request(
        'POST',
        '/v1/workspace-reference-folders',
        validated,
        undefined,
        2_000,
        MAX_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async setWorkspaceReferenceAccess(
    input: WorkspaceReferenceAccessInput,
  ): Promise<WorkspaceReference> {
    const validated = WorkspaceReferenceAccessInputSchema.parse(input);
    return WorkspaceReferenceSchema.parse(
      await this.#request(
        'PUT',
        '/v1/workspace-references',
        validated,
        undefined,
        2_000,
        MAX_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async removeWorkspaceReference(
    input: WorkspaceReferenceMutationInput,
  ): Promise<WorkspaceReferenceListResult> {
    const validated = WorkspaceReferenceMutationInputSchema.parse(input);
    const mutationToken = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceReferenceListResultSchema.parse(
      await this.#request(
        'DELETE',
        '/v1/workspace-references',
        validated,
        mutationCapabilityHeaders(mutationToken),
        2_000,
        MAX_RESPONSE_BYTES,
        true,
      ),
    );
  }

  public async removeWorkspace(input: RemoveWorkspaceInput): Promise<WorkspaceDetailListResult> {
    const validated = RemoveWorkspaceInputSchema.parse(input);
    const mutationToken = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return WorkspaceDetailListResultSchema.parse(
      await this.#request(
        'DELETE',
        `/v1/workspaces/${validated.workspace_id}`,
        undefined,
        mutationCapabilityHeaders(mutationToken),
      ),
    );
  }

  public async projectBinding(workspaceId: string): Promise<ProjectBindingResult> {
    const input = ProjectBindingRequestSchema.parse({ workspace_id: workspaceId });
    return ProjectBindingResultSchema.parse(
      await this.#request('POST', '/v1/project-binding', input),
    );
  }

  public async setReadOnlyMode(enabled: boolean): Promise<ReadOnlyModeState> {
    const input = ReadOnlyModeStateSchema.parse({ enabled });
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return ReadOnlyModeStateSchema.parse(
      await this.#request('PUT', '/v1/read-only-mode', input, mutationCapabilityHeaders(token)),
    );
  }

  public async setAutoAttach(input: AutoAttachInput): Promise<AutoAttachWorkspaceIds> {
    const validated = AutoAttachInputSchema.parse(input);
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return AutoAttachWorkspaceIdsSchema.parse(
      await this.#request('PUT', '/v1/auto-attach', validated, mutationCapabilityHeaders(token)),
    );
  }

  public async setMcpAppName(name: string): Promise<string> {
    const validated = McpAppNameInputSchema.parse({ name });
    const token = (await readFile(this.#mutationTokenPath, 'utf8')).trim();
    return McpAppNameInputSchema.parse(
      await this.#request('PUT', '/v1/mcp-app-name', validated, mutationCapabilityHeaders(token)),
    ).name;
  }

  public async getChatGptTabState(): Promise<ChatGptTabState | undefined> {
    const value = await this.#request('GET', '/v1/chatgpt-tabs');
    return value === null ? undefined : ChatGptTabStateSchema.parse(value);
  }

  public async setChatGptTabState(state: ChatGptTabState): Promise<ChatGptTabState> {
    const validated = ChatGptTabStateSchema.parse(state);
    return ChatGptTabStateSchema.parse(await this.#request('PUT', '/v1/chatgpt-tabs', validated));
  }

  public async configureTunnel(input: TunnelConfiguration): Promise<TunnelStatus> {
    const validated = TunnelConfigurationSchema.parse(input);
    return TunnelStatusSchema.parse(
      await this.#request('PUT', '/v1/tunnel/configuration', validated),
    );
  }

  public async startTunnel(input: TunnelStartInput): Promise<TunnelStatus> {
    const validated = TunnelStartInputSchema.parse(input);
    return TunnelStatusSchema.parse(await this.#request('POST', '/v1/tunnel/start', validated));
  }

  public async doctorTunnel(input: TunnelStartInput): Promise<TunnelDoctorResult> {
    const validated = TunnelStartInputSchema.parse(input);
    return TunnelDoctorResultSchema.parse(
      await this.#request('POST', '/v1/tunnel/doctor', validated, undefined, 20_000),
    );
  }

  public async stopTunnel(): Promise<TunnelStatus> {
    return TunnelStatusSchema.parse(await this.#request('POST', '/v1/tunnel/stop', {}));
  }

  public async installTunnelClient(): Promise<TunnelClientInstallResult> {
    return TunnelClientInstallResultSchema.parse(
      await this.#request('POST', '/v1/tunnel/install', {}, undefined, 120_000),
    );
  }

  public async shutdown(): Promise<void> {
    await this.#request('POST', '/v1/shutdown', {});
  }
}
