import type {
  FsReferenceTarget,
  WorkspaceReference,
  WorkspaceReferenceListResult,
  WorkspaceReferenceMutationInput,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { WorkspaceRecord } from './repository.js';
import type { WorkspaceService } from './service.js';

/**
 * Owns ChatSplice's explicit, one-way read-only workspace relationships.
 * A relationship is an allow-list entry, not a source of additional bindings
 * or file-system authority.
 */
export class WorkspaceReferenceService {
  readonly #workspaceService: WorkspaceService;
  readonly #settingsRepository: SettingsRepository;

  public constructor(workspaceService: WorkspaceService, settingsRepository: SettingsRepository) {
    this.#workspaceService = workspaceService;
    this.#settingsRepository = settingsRepository;
  }

  public list(): WorkspaceReferenceListResult {
    return this.#settingsRepository.getWorkspaceReferences();
  }

  public listTargets(sourceWorkspaceId: string): FsReferenceTarget[] {
    this.#requireSourceWorkspace(sourceWorkspaceId);
    return this.list().references.flatMap((reference) => {
      if (reference.source_workspace_id !== sourceWorkspaceId) return [];
      try {
        const target = this.#requireTargetWorkspace(reference.reference_workspace_id);
        return [
          {
            workspace_id: target.workspace_id,
            workspace_name: target.display_name,
            created_at: reference.created_at,
          },
        ];
      } catch (error) {
        if (error instanceof ChatSpliceError && error.code === 'WORKSPACE_NOT_FOUND') return [];
        throw error;
      }
    });
  }

  public add(input: WorkspaceReferenceMutationInput): WorkspaceReference {
    const source = this.#requireSourceWorkspace(input.source_workspace_id);
    const target = this.#requireTargetWorkspace(input.reference_workspace_id);
    if (source.workspace_id === target.workspace_id) {
      throw new ChatSpliceError('BAD_REQUEST', 'A workspace cannot reference itself.');
    }
    return this.#settingsRepository.addWorkspaceReference({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      created_at: new Date().toISOString(),
    });
  }

  public remove(input: WorkspaceReferenceMutationInput): WorkspaceReferenceListResult {
    this.#requireSourceWorkspace(input.source_workspace_id);
    this.#requireTargetWorkspace(input.reference_workspace_id);
    return this.#settingsRepository.removeWorkspaceReference(input);
  }

  public removeWorkspace(workspaceId: string): WorkspaceReferenceListResult {
    return this.#settingsRepository.removeWorkspaceReferences(workspaceId);
  }

  public requireTarget(sourceWorkspaceId: string, referenceWorkspaceId: string): WorkspaceRecord {
    this.#requireSourceWorkspace(sourceWorkspaceId);
    const target = this.#requireTargetWorkspace(referenceWorkspaceId);
    const allowed = this.list().references.some(
      (reference) =>
        reference.source_workspace_id === sourceWorkspaceId &&
        reference.reference_workspace_id === referenceWorkspaceId,
    );
    if (!allowed) {
      throw new ChatSpliceError(
        'REFERENCE_NOT_ALLOWED',
        'This workspace is not an explicit read-only reference for the bound project. Add the relationship in ChatSplice first.',
      );
    }
    return target;
  }

  #requireSourceWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.#workspaceService.getRecord(workspaceId);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Only registered user workspaces can hold a reference to another workspace.',
      );
    }
    return workspace;
  }

  /** A reference target may be a full user project or an approved ad-hoc path. */
  #requireTargetWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.#workspaceService.getRecord(workspaceId);
    if (workspace.kind !== 'user' && workspace.kind !== 'reference') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Only registered user workspaces or approved reference paths can be linked as references.',
      );
    }
    return workspace;
  }
}
