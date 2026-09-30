import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import {
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_MCP_APP_NAME,
  LEGACY_MCP_APP_NAMES,
  projectBindingText,
  type DaemonStatus,
} from '@chatsplice/protocol';

import { startControlServer } from './control/server.js';
import { startMcpHttpServer } from './http/server.js';
import { log } from './logging.js';
import { ensureMcpToken } from './token.js';
import { TunnelSupervisor } from './tunnel/supervisor.js';
import { workspaceBindingFor } from './workspace-binding.js';
import { DirectEditActivityStore } from './mutation/direct-edit-activity-store.js';
import { LocalApplyProposalStore } from './mutation/local-apply-proposal-store.js';
import { ReferenceRequestStore } from './mutation/reference-request-store.js';
import { ProjectExecutionService } from './execution/service.js';
import type { ProjectExecutionBackend } from './execution/backend.js';

export interface ChatSpliceRuntimeOptions {
  readonly dataDirectory: string;
  readonly controlSocketPath: string;
  /** Test-only override for the native ChatSplice approval wait. */
  readonly localApplyStartWaitMs?: number;
  /** Test-only/fallback injection for the daemon's model-free execution backend. */
  readonly executionBackend?: ProjectExecutionBackend;
}

export interface ChatSpliceRuntime {
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly tokenPath: string;
  readonly probeWorkspaceId: string;
  status(): DaemonStatus;
  close(): Promise<void>;
}

export function resolveRuntimeDatabasePath(dataDirectory: string): string {
  const current = join(dataDirectory, 'chatsplice.sqlite');
  const legacy = join(dataDirectory, 'localchat.sqlite');
  if (existsSync(current) || !existsSync(legacy)) return current;
  return legacy;
}

export async function startChatSpliceRuntime(
  options: ChatSpliceRuntimeOptions,
): Promise<ChatSpliceRuntime> {
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const databasePath = resolveRuntimeDatabasePath(options.dataDirectory);
  const repository = new SqliteWorkspaceRepository(databasePath);
  const settingsRepository = new SqliteSettingsRepository(databasePath);
  const workspaceService = new WorkspaceService(repository);
  const workspaceReferenceService = new WorkspaceReferenceService(
    workspaceService,
    settingsRepository,
  );
  // Installations that already registered projects created their ChatGPT app
  // as "Local MCP"; keep that name instead of silently renaming it.
  if (settingsRepository.getMcpAppName() === undefined && workspaceService.list().count > 0) {
    settingsRepository.setMcpAppName(LEGACY_MCP_APP_NAMES[0]);
  }
  const currentMcpAppName = (): string =>
    settingsRepository.getMcpAppName() ?? DEFAULT_MCP_APP_NAME;
  let closed = false;
  let controlRuntime: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let mcpRuntime: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
  let tunnelSupervisor: TunnelSupervisor | undefined;
  const executionService = new ProjectExecutionService(workspaceService, {
    isReadOnly: () => settingsRepository.getReadOnlyMode(),
    ...(options.executionBackend === undefined ? {} : { backend: options.executionBackend }),
  });

  try {
    const probe = await workspaceService.ensureProbeWorkspace(options.dataDirectory);
    const tokenPath = join(options.dataDirectory, 'run', 'mcp-token');
    const mcpToken = await ensureMcpToken(tokenPath);
    const mutationToken = await ensureMcpToken(
      join(options.dataDirectory, 'run', 'control-mutation-token'),
    );
    const directEditActivityStore = new DirectEditActivityStore();
    const localApplyProposalStore = new LocalApplyProposalStore(
      workspaceService,
      mcpToken,
      directEditActivityStore,
    );
    const referenceRequestStore = new ReferenceRequestStore(
      workspaceService,
      mcpToken,
      directEditActivityStore,
    );
    mcpRuntime = await startMcpHttpServer(
      workspaceService,
      workspaceReferenceService,
      mcpToken,
      localApplyProposalStore,
      referenceRequestStore,
      directEditActivityStore,
      () => settingsRepository.getReadOnlyMode(),
      {
        ...(options.localApplyStartWaitMs === undefined
          ? {}
          : { localApplyStartWaitMs: options.localApplyStartWaitMs }),
        executionService,
      },
    );
    tunnelSupervisor = new TunnelSupervisor({
      dataDirectory: options.dataDirectory,
      mcpUrl: mcpRuntime.url,
      tokenPath,
      settingsRepository,
    });
    await tunnelSupervisor.refresh();

    const status = (): DaemonStatus => ({
      protocol_version: CONTROL_PROTOCOL_VERSION,
      healthy: !closed,
      ready: !closed && mcpRuntime !== undefined,
      mcp_url: mcpRuntime?.url ?? null,
      workspace_count: workspaceService.list().count,
      probe_workspace_id: probe.workspace_id,
      latest_direct_edits: directEditActivityStore.list(),
      latest_mcp_activities: directEditActivityStore.listActivities(),
      execution_jobs: executionService.list(),
      tunnel: tunnelSupervisor?.status() ?? {
        mode: 'none',
        state: 'unconfigured',
        healthy: false,
        ready: false,
        configuration: null,
        detected_executable_path: null,
        detected_tunnel_id: null,
        mcp_url: null,
        admin_url: null,
        error_code: null,
      },
      read_only_mode: settingsRepository.getReadOnlyMode(),
      auto_attach_workspace_ids: settingsRepository.getAutoAttachWorkspaceIds(),
      mcp_app_name: currentMcpAppName(),
    });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        closed = true;
        const executionDrain = executionService.shutdown();
        await controlRuntime?.close();
        await executionDrain;
        await localApplyProposalStore.drain();
        await tunnelSupervisor?.close();
        await mcpRuntime?.close();
        repository.close();
        settingsRepository.close();
        log('info', 'daemon_stopped');
      })();
      return closePromise;
    };

    controlRuntime = await startControlServer({
      socketPath: options.controlSocketPath,
      workspaceService,
      workspaceReferenceService,
      status,
      shutdown: () => {
        void close();
      },
      tunnelSupervisor,
      settingsRepository,
      localApplyProposalStore,
      referenceRequestStore,
      directEditActivityStore,
      mutationToken,
      localApplyWorkspaceBinding: (workspaceId) => workspaceBindingFor(mcpToken, workspaceId),
      executionService,
      projectBindingText: (workspaceId) => {
        const workspace = workspaceService.getRecord(workspaceId);
        return projectBindingText(
          workspaceId,
          workspaceBindingFor(mcpToken, workspaceId),
          workspace.display_name,
          currentMcpAppName(),
        );
      },
    });

    log('info', 'daemon_ready', {
      mcp_url: mcpRuntime.url,
      workspace_count: workspaceService.list().count,
    });

    return {
      mcpUrl: mcpRuntime.url,
      mcpToken,
      tokenPath,
      probeWorkspaceId: probe.workspace_id,
      status,
      close,
    };
  } catch (error) {
    await controlRuntime?.close().catch(() => undefined);
    await tunnelSupervisor?.close().catch(() => undefined);
    await mcpRuntime?.close().catch(() => undefined);
    await executionService.shutdown().catch(() => undefined);
    repository.close();
    settingsRepository.close();
    throw error;
  }
}
