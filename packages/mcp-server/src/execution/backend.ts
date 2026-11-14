import {
  executeProjectOperation as coreExecuteProjectOperation,
  resolveProjectExecutionAccess,
} from '@chatsplice/core';
import type {
  ExecutionPreflightProgress,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import type {
  ProjectExecInput,
  ProjectBrowserSnapshot,
  ProjectReadinessResult,
  ProjectEnvironmentResult,
} from '@chatsplice/protocol';

import { executeReadinessProbe } from '../readiness/service.js';
import { inspectProjectEnvironment } from '../environment/service.js';

export interface ProjectExecutionStart {
  readonly command: string;
  readonly used_network: boolean;
}

export interface ProjectExecutionResult {
  readonly cargo_cache_repaired?: true;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly browser_result?: ProjectBrowserSnapshot;
  readonly readiness_result?: ProjectReadinessResult;
  readonly environment_result?: ProjectEnvironmentResult;
  readonly image?: { readonly data: Buffer; readonly mimeType: 'image/jpeg' };
}

export interface ProjectExecutionBackendOptions {
  readonly referenceService?: WorkspaceReferenceService;
  readonly signal: AbortSignal;
  readonly onOutput: (chunk: string) => void;
  readonly onStart: (execution: ProjectExecutionStart) => void;
  readonly onPreflight?: (progress: ExecutionPreflightProgress) => void;
}

export type ProjectExecutionBackend = (
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  options: ProjectExecutionBackendOptions,
) => Promise<ProjectExecutionResult>;

export const executeProjectOperation: ProjectExecutionBackend = async (
  workspaceService,
  input,
  options,
) => {
  if (input.operation.kind === 'readiness' || input.operation.kind === 'environment') {
    const started = Date.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), input.timeout_ms);
    try {
      const signal = AbortSignal.any([options.signal, deadline.signal]);
      if (input.operation.kind === 'environment') {
        options.onStart({ command: 'environment inspection', used_network: false });
        const access = resolveProjectExecutionAccess(
          workspaceService,
          input,
          options.referenceService,
        );
        const result = await inspectProjectEnvironment(
          workspaceService,
          {
            ...input,
            workspace_id: access.target.workspace_id,
          },
          { signal },
        );
        options.onOutput(`${JSON.stringify(result)}\n`);
        return {
          exit_code: 0,
          duration_ms: Date.now() - started,
          timed_out: false,
          environment_result: result,
        };
      }
      const url = new URL(input.operation.url);
      options.onStart({ command: `HEAD ${url.origin}${url.pathname}`, used_network: true });
      return await executeReadinessProbe(input.operation, {
        signal,
        onOutput: options.onOutput,
      });
    } catch (error) {
      if (deadline.signal.aborted && !options.signal.aborted) {
        return { exit_code: null, duration_ms: Date.now() - started, timed_out: true };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return coreExecuteProjectOperation(workspaceService, input, options);
};
