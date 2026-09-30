import { executeProjectOperation as coreExecuteProjectOperation } from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import type { ProjectExecInput } from '@chatsplice/protocol';

export interface ProjectExecutionStart {
  readonly command: string;
  readonly used_network: boolean;
}

export interface ProjectExecutionResult {
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
}

export interface ProjectExecutionBackendOptions {
  readonly signal: AbortSignal;
  readonly onOutput: (chunk: string) => void;
  readonly onStart: (execution: ProjectExecutionStart) => void;
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
  return coreExecuteProjectOperation(workspaceService, input, options);
};
