import type { WorkspaceReferenceAccessMode } from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceRecord } from '../workspace/repository.js';
import type { WorkspaceReferenceService } from '../workspace/reference-service.js';
import type { WorkspaceService } from '../workspace/service.js';

export interface WorkspaceFileTargetInput {
  readonly workspace_id: string;
  readonly reference_workspace_id?: string | undefined;
}

export interface WorkspaceFileAccess {
  readonly source: WorkspaceRecord;
  readonly target: WorkspaceRecord;
}

export function resolveWorkspaceFileAccess(
  workspaceService: WorkspaceService,
  input: WorkspaceFileTargetInput,
  mode: WorkspaceReferenceAccessMode,
  references?: WorkspaceReferenceService,
): WorkspaceFileAccess {
  const source = workspaceService.getRecord(input.workspace_id);
  if (input.reference_workspace_id === undefined) {
    if (mode === 'read_write' && source.kind !== 'user') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Direct filesystem mutation requires a user workspace or an approved writable folder.',
      );
    }
    // Legacy reference readers and probe reads pass their target directly.
    return { source, target: source };
  }
  if (references === undefined) {
    throw new ChatSpliceError(
      'REFERENCE_NOT_ALLOWED',
      'Shared-folder access is unavailable for this operation.',
    );
  }
  return {
    source,
    target: references.requireTarget(source.workspace_id, input.reference_workspace_id, mode),
  };
}

export function workspaceFileResult(access: WorkspaceFileAccess): {
  workspace_id: string;
  workspace_name: string;
  reference_workspace_id?: string;
  reference_workspace_name?: string;
} {
  return {
    workspace_id: access.source.workspace_id,
    workspace_name: access.source.display_name,
    ...(access.target.workspace_id !== access.source.workspace_id
      ? {
          reference_workspace_id: access.target.workspace_id,
          reference_workspace_name: access.target.display_name,
        }
      : {}),
  };
}

/** Reserve the actual folders, then revalidate the grant at the start of queued work. */
export function withWorkspaceFileAccess<T>(
  workspaceService: WorkspaceService,
  input: WorkspaceFileTargetInput,
  mode: WorkspaceReferenceAccessMode,
  references: WorkspaceReferenceService | undefined,
  action: (access: WorkspaceFileAccess) => Promise<T>,
): Promise<T> {
  let accepted: WorkspaceFileAccess;
  try {
    accepted = resolveWorkspaceFileAccess(workspaceService, input, mode, references);
  } catch (error) {
    return Promise.reject(error);
  }
  const invoke = (): Promise<T> => {
    const current = resolveWorkspaceFileAccess(workspaceService, input, mode, references);
    if (
      current.source.rootPath !== accepted.source.rootPath ||
      current.target.rootPath !== accepted.target.rootPath
    ) {
      throw new ChatSpliceError(
        'PATH_OUTSIDE_WORKSPACE',
        'A project or shared folder changed while the operation was queued.',
      );
    }
    return action(current);
  };
  const workspaceIds = [...new Set([accepted.source.workspace_id, accepted.target.workspace_id])];
  if (mode !== 'read_write') {
    return workspaceService.withConcurrentOperations(workspaceIds, invoke);
  }

  // Bound only the time before the mutation starts. A request that times out
  // must leave the reservation queue, never run later after an ambiguous reply.
  // Once acquired, the atomic operation owns its normal completion and cleanup.
  const controller = new AbortController();
  const waitLimitMs = 15_000;
  const timer = setTimeout(
    () =>
      controller.abort(
        new ChatSpliceError(
          'BAD_REQUEST',
          '[WORKSPACE_OPERATION_WAIT_TIMEOUT] The file mutation was not started because another operation held a participating folder. ' +
            `wait_limit_ms=${waitLimitMs}; Check active project jobs before submitting the change again.`,
        ),
      ),
    waitLimitMs,
  );
  return workspaceService
    .withOperations(
      workspaceIds,
      () => {
        clearTimeout(timer);
        return invoke();
      },
      controller.signal,
    )
    .finally(() => clearTimeout(timer));
}
