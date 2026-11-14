import type { ProjectExecInput } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceRecord } from '../workspace/repository.js';
import type { WorkspaceReferenceService } from '../workspace/reference-service.js';
import type { WorkspaceService } from '../workspace/service.js';

export interface ExecutionFolder {
  readonly workspace: WorkspaceRecord;
  readonly accessMode: 'read_only' | 'read_write';
}

export interface ProjectExecutionAccess {
  readonly source: WorkspaceRecord;
  readonly target: WorkspaceRecord;
  readonly folders: readonly ExecutionFolder[];
  readonly workspaceIds: readonly string[];
  readonly fingerprint: string;
}

/**
 * Resolve owner-approved folders, never caller-supplied absolute paths.
 * The service and Pi adapter both revalidate this snapshot inside their leases.
 */
export function resolveProjectExecutionAccess(
  workspaceService: WorkspaceService,
  input: ProjectExecInput,
  referenceService?: WorkspaceReferenceService,
): ProjectExecutionAccess {
  const source = workspaceService.getRecord(input.workspace_id);
  if (source.kind !== 'user') {
    throw new ChatSpliceError('BAD_REQUEST', 'Project execution requires a user workspace.');
  }
  if (
    input.reference_workspace_id !== undefined &&
    (input.operation.kind === 'browser' || input.operation.kind === 'readiness')
  ) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'Browser and readiness jobs use the bound project, without a folder target.',
    );
  }
  if (input.reference_workspace_id !== undefined && input.criterion_id !== undefined) {
    throw new ChatSpliceError(
      'BAD_REQUEST',
      'A check in an additional folder cannot verify a criterion that tracks the main project.',
    );
  }

  const folders: ExecutionFolder[] = [{ workspace: source, accessMode: 'read_write' }];
  const command =
    input.operation.kind !== 'browser' &&
    input.operation.kind !== 'readiness' &&
    input.operation.kind !== 'environment';

  if (command && referenceService !== undefined) {
    const references = referenceService.listTargets(source.workspace_id);
    if (references.length > 100) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Execution supports at most 100 additional folders.',
      );
    }
    for (const reference of references) {
      const accessMode = reference.access_mode ?? 'read_only';
      folders.push({
        workspace: referenceService.requireTarget(
          source.workspace_id,
          reference.workspace_id,
          accessMode,
        ),
        accessMode,
      });
    }
  }

  let target = source;
  if (input.reference_workspace_id !== undefined) {
    if (referenceService === undefined) {
      throw new ChatSpliceError('REFERENCE_NOT_ALLOWED', 'Additional folders are not configured.');
    }
    target = referenceService.requireTarget(
      source.workspace_id,
      input.reference_workspace_id,
      command ? 'read_write' : 'read_only',
    );
    if (!folders.some((folder) => folder.workspace.workspace_id === target.workspace_id)) {
      folders.push({ workspace: target, accessMode: command ? 'read_write' : 'read_only' });
    }
  }

  const ordered = [...folders].sort((left, right) =>
    left.workspace.workspace_id.localeCompare(right.workspace.workspace_id),
  );
  return {
    source,
    target,
    folders: ordered,
    workspaceIds: ordered.map((folder) => folder.workspace.workspace_id),
    fingerprint: JSON.stringify({
      source: source.workspace_id,
      target: target.workspace_id,
      folders: ordered.map((folder) => ({
        id: folder.workspace.workspace_id,
        root: folder.workspace.rootPath,
        mode: folder.accessMode,
      })),
    }),
  };
}
