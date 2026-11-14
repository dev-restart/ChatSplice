import { rm } from 'node:fs/promises';

import { createBashTool, type BashOperations } from '@earendil-works/pi-coding-agent';
import { isBackgroundOperation, type ProjectExecInput } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';

import { prepareOperation } from './pi-prepare.js';
import {
  beginCargoCacheRepair,
  prepareManagedCargoCache,
  publishCargoCacheRepair,
} from './cargo-cache.js';
import { createProjectRuntimeDirectory } from './runtime-directory.js';
import { resolveProjectExecutionAccess, type ProjectExecutionAccess } from './execution-access.js';
import { assertExecutionWorkspaceLinks } from './execution-links.js';
import { executeSandboxedCommand, SANDBOX_EXECUTABLE } from './pi-sandbox.js';
import {
  badRequest,
  nodeRuntimeVersionSupported,
  resolveCorepackCache,
  resolveExistingCwd,
  resolveTrustedExecutable,
  revalidateTrustedExecutables,
} from './pi-trusted.js';
import type { ProcessResult, ProjectOperationOptions, ProjectOperationResult } from './pi-types.js';

export type {
  ProjectOperationOptions,
  ProjectOperationResult,
  ProjectOperationStart,
} from './pi-types.js';
export type { ExecutionPreflightProgress } from './execution-links.js';

const WORKSPACE_BINDING_PATTERN = /^wb_[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/u;
async function executeProjectOperationUnlocked(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  options: ProjectOperationOptions,
  access: ProjectExecutionAccess,
): Promise<ProjectOperationResult> {
  if (!WORKSPACE_BINDING_PATTERN.test(input.workspace_binding)) {
    badRequest('project.exec requires a valid workspace binding.');
  }
  if (!REQUEST_ID_PATTERN.test(input.request_id)) {
    badRequest('project.exec requires a valid request_id.');
  }
  if (input.timeout_ms < 1_000 || input.timeout_ms > 86_400_000) {
    badRequest('project.exec timeout_ms is outside the allowed range.');
  }
  if (!nodeRuntimeVersionSupported()) {
    badRequest(`Pi SDK execution requires Node.js >=22.19.0; found ${process.versions.node}.`);
  }
  if (process.platform !== 'darwin') {
    badRequest('Pi SDK project execution requires the macOS sandbox-exec boundary.');
  }
  const { canonicalRoot, cwd } = await resolveExistingCwd(workspaceService, {
    ...input,
    workspace_id: access.target.workspace_id,
  });
  const sandboxExecutable = await resolveTrustedExecutable(SANDBOX_EXECUTABLE, canonicalRoot);
  const runtimeDirectory = await createProjectRuntimeDirectory('exec');
  try {
    // Shell commands and Node build hooks can invoke Cargo as well. Keep the
    // project dependency cache across jobs while HOME and other runtime state
    // remain private to this execution and are removed during cleanup.
    const repairing = input.operation.kind === 'install' && input.operation.repair_cache === true;
    if (
      repairing &&
      input.operation.kind === 'install' &&
      (input.operation.ecosystem !== 'rust' || input.operation.mode === 'resolve')
    ) {
      badRequest('repair_cache requires a locked Rust install.');
    }
    const repair = repairing
      ? await beginCargoCacheRepair(canonicalRoot, options.signal)
      : undefined;
    const { cargoHome, toolHome } = repair ?? (await prepareManagedCargoCache(canonicalRoot));
    const corepackCache = await resolveCorepackCache();
    const operation = await prepareOperation(
      input,
      canonicalRoot,
      cwd,
      runtimeDirectory,
      cargoHome,
      corepackCache,
      options.signal,
    );
    await revalidateTrustedExecutables(
      [
        sandboxExecutable,
        operation.executable,
        ...(operation.nodeRuntime === undefined ? [] : [operation.nodeRuntime]),
      ],
      access.folders
        .filter(
          (folder) =>
            folder.accessMode === 'read_write' &&
            folder.workspace.workspace_id !== access.target.workspace_id,
        )
        .map((folder) => folder.workspace.rootPath),
    );
    const prepared = {
      ...operation,
      cargoToolHome: toolHome,
      additionalFolders: access.folders
        .filter((folder) => folder.workspace.workspace_id !== access.target.workspace_id)
        .map((folder) => ({ rootPath: folder.workspace.rootPath, accessMode: folder.accessMode })),
    };
    await assertExecutionWorkspaceLinks(
      access.folders
        .filter((folder) => folder.accessMode === 'read_write')
        .map((folder) => folder.workspace.rootPath),
      options.signal,
      access.folders
        .filter((folder) => folder.accessMode === 'read_only')
        .map((folder) => folder.workspace.rootPath),
      options.onPreflight,
    );
    const startedAt = Date.now();
    let operationResult: ProcessResult | undefined;
    const operations: BashOperations = {
      exec: async (_command, commandCwd, commandOptions) => {
        const operationOptions: ProjectOperationOptions =
          commandOptions.signal === undefined
            ? options
            : { ...options, signal: commandOptions.signal };
        const result = await executeSandboxedCommand(
          prepared.command,
          commandCwd,
          input,
          prepared,
          prepared.usedNetwork,
          operationOptions,
          commandOptions.onData,
        );
        operationResult = result;
        if (result.aborted) throw new Error('aborted');
        if (result.timedOut) throw new Error(`timeout:${input.timeout_ms / 1000}`);
        return { exitCode: result.exitCode };
      },
    };
    const bashTool = createBashTool(cwd, {
      operations,
      exposeSessionEnvironment: false,
      spawnHook: (context) => ({ ...context, command: prepared.command, cwd }),
    });
    let processResult: ProcessResult | undefined;
    try {
      await bashTool.execute(
        `chatsplice-${input.request_id}`,
        { command: prepared.command, timeout: input.timeout_ms / 1000 },
        options.signal,
      );
      if (operationResult === undefined) {
        throw new Error('The Pi command operation did not run.');
      }
      processResult = operationResult;
    } catch (error) {
      if (operationResult !== undefined) {
        processResult = operationResult;
      } else {
        // createBashTool turns non-zero exits into an Error after the custom
        // operation has completed. Recover its structured process state from
        // the operation-local fields below instead of treating code failures
        // as spawn errors.
        const message = error instanceof Error ? error.message : '';
        const match = message.match(/Command exited with code (-?\d+)/u);
        if (match !== null) {
          processResult = { exitCode: Number(match[1]), timedOut: false, aborted: false };
        } else if (options.signal?.aborted) {
          processResult = { exitCode: null, timedOut: false, aborted: true };
        } else {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'The bounded Pi SDK operation could not be started.',
          );
        }
      }
    }
    let cargoCacheRepaired = false;
    if (repair !== undefined) {
      if (
        operationResult !== undefined &&
        operationResult.exitCode === 0 &&
        !operationResult.timedOut &&
        !operationResult.aborted &&
        !options.signal?.aborted
      ) {
        await publishCargoCacheRepair(repair, operationResult, options.signal);
        cargoCacheRepaired = true;
        options.onOutput?.(
          '\nCargo cache repair: locked fetch succeeded; the fresh dependency cache is now selected. Installed tools and the previous cache were retained.\n',
        );
      } else {
        options.onOutput?.(
          '\nCargo cache repair was not published; the previous cache selection was retained.\n',
        );
      }
    }
    return {
      ...(cargoCacheRepaired ? { cargo_cache_repaired: true } : {}),
      exit_code: processResult?.exitCode ?? null,
      duration_ms: Date.now() - startedAt,
      timed_out: processResult?.timedOut ?? false,
    };
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

export async function executeProjectOperation(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  options: ProjectOperationOptions = {},
): Promise<ProjectOperationResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ exit_code: null, duration_ms: 0, timed_out: false });
  }
  const access = resolveProjectExecutionAccess(workspaceService, input, options.referenceService);
  const action = () => {
    const current = resolveProjectExecutionAccess(
      workspaceService,
      input,
      options.referenceService,
    );
    if (current.fingerprint !== access.fingerprint) {
      throw new ChatSpliceError(
        'REFERENCE_NOT_ALLOWED',
        'The permitted execution folders changed. Submit the operation again.',
      );
    }
    return executeProjectOperationUnlocked(workspaceService, input, options, current);
  };
  return isBackgroundOperation(input.operation)
    ? workspaceService.withConcurrentOperations(access.workspaceIds, action, options.signal)
    : workspaceService.withOperations(access.workspaceIds, action, options.signal);
}
