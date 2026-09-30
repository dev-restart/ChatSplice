import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBashTool, type BashOperations } from '@earendil-works/pi-coding-agent';
import type { ProjectExecInput } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';

import { prepareOperation } from './pi-prepare.js';
import { executeSandboxedCommand, SANDBOX_EXECUTABLE } from './pi-sandbox.js';
import {
  badRequest,
  nodeRuntimeVersionSupported,
  prepareCargoHome,
  resolveCorepackCache,
  resolveExistingCwd,
  resolveTrustedExecutable,
} from './pi-trusted.js';
import type { ProcessResult, ProjectOperationOptions, ProjectOperationResult } from './pi-types.js';

export type {
  ProjectOperationOptions,
  ProjectOperationResult,
  ProjectOperationStart,
} from './pi-types.js';

const WORKSPACE_BINDING_PATTERN = /^wb_[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/u;
async function executeProjectOperationUnlocked(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  options: ProjectOperationOptions,
): Promise<ProjectOperationResult> {
  if (!WORKSPACE_BINDING_PATTERN.test(input.workspace_binding)) {
    badRequest('project.exec requires a valid workspace binding.');
  }
  if (!REQUEST_ID_PATTERN.test(input.request_id)) {
    badRequest('project.exec requires a valid request_id.');
  }
  if (input.timeout_ms < 1_000 || input.timeout_ms > 1_800_000) {
    badRequest('project.exec timeout_ms is outside the allowed range.');
  }
  if (!nodeRuntimeVersionSupported()) {
    badRequest(`Pi SDK execution requires Node.js >=22.19.0; found ${process.versions.node}.`);
  }
  if (process.platform !== 'darwin') {
    badRequest('Pi SDK project execution requires the macOS sandbox-exec boundary.');
  }
  const workspace = workspaceService.getRecord(input.workspace_id);
  if (workspace.kind !== 'user') badRequest('project.exec is available only for user workspaces.');
  const { canonicalRoot, cwd } = await resolveExistingCwd(workspaceService, input);
  await resolveTrustedExecutable(SANDBOX_EXECUTABLE, canonicalRoot);
  const runtimeDirectory = await realpath(
    await mkdtemp(join(tmpdir(), 'chatsplice-project-exec-')),
  );
  try {
    const cargoOperation =
      input.operation.kind === 'cargo' ||
      (input.operation.kind === 'install' && input.operation.ecosystem === 'rust');
    const cargoHome = cargoOperation
      ? await prepareCargoHome(canonicalRoot)
      : join(runtimeDirectory, 'cargo-home');
    const corepackCache = await resolveCorepackCache();
    await mkdir(cargoHome, { recursive: true, mode: 0o700 });
    const prepared = await prepareOperation(
      input,
      canonicalRoot,
      cwd,
      runtimeDirectory,
      cargoHome,
      corepackCache,
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
      processResult = operationResult ?? { exitCode: 0, timedOut: false, aborted: false };
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
    return {
      exit_code: processResult?.exitCode ?? null,
      duration_ms: Date.now() - startedAt,
      timed_out: processResult?.timedOut ?? false,
    };
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

export function executeProjectOperation(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  options: ProjectOperationOptions = {},
): Promise<ProjectOperationResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ exit_code: null, duration_ms: 0, timed_out: false });
  }
  return workspaceService.withOperation(input.workspace_id, () =>
    executeProjectOperationUnlocked(workspaceService, input, options),
  );
}
