import type { WorkspaceReferenceService } from '../workspace/reference-service.js';
import type { ExecutionPreflightProgress } from './execution-links.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface Manifest {
  readonly packageManager?: unknown;
  readonly pnpm?: unknown;
  readonly scripts?: Record<string, unknown>;
}

export interface TrustedExecutable {
  readonly path: string;
  readonly root: string;
  readonly searchDirectory?: string;
}

export interface PreparedOperation {
  readonly command: string;
  readonly args: readonly string[];
  readonly usedNetwork: boolean;
  readonly executable: TrustedExecutable;
  readonly nodeRuntime?: TrustedExecutable;
  readonly shimDirectory?: string;
  readonly workspaceRoot: string;
  readonly cargoHome: string;
  readonly cargoToolHome?: string;
  readonly corepackCache: string;
  readonly runtimeDirectory: string;
  readonly additionalFolders?: readonly {
    readonly rootPath: string;
    readonly accessMode: 'read_only' | 'read_write';
  }[];
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface ProjectOperationStart {
  readonly command: string;
  readonly used_network: boolean;
}

export interface ProjectOperationOptions {
  readonly referenceService?: WorkspaceReferenceService;
  readonly signal?: AbortSignal;
  readonly onOutput?: (data: string) => void;
  readonly onStart?: (start: ProjectOperationStart) => void;
  readonly onPreflight?: (progress: ExecutionPreflightProgress) => void;
}

export interface ProjectOperationResult {
  readonly cargo_cache_repaired?: true;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
}

export interface OutputBudget {
  bytes: number;
  lines: number;
}
