import {
  WorkspaceReferenceAccessInputSchema,
  WorkspaceReferenceFolderInputSchema,
  type FsReferenceTarget,
  type WorkspaceReference,
  type WorkspaceReferenceAccessInput,
  type WorkspaceReferenceAccessMode,
  type WorkspaceReferenceFolderInput,
  type WorkspaceReferenceListResult,
  type WorkspaceReferenceMutationInput,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { WorkspaceRecord } from './repository.js';
import type { WorkspaceService } from './service.js';

/** One-way owner grants; a folder ID never supplies another project's binding. */
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
            access_mode: reference.access_mode ?? 'read_only',
            root_path: target.rootPath,
          },
        ];
      } catch (error) {
        if (error instanceof ChatSpliceError && error.code === 'WORKSPACE_NOT_FOUND') return [];
        throw error;
      }
    });
  }

  /** Legacy add never upgrades or downgrades an existing grant. */
  public add(input: WorkspaceReferenceMutationInput): WorkspaceReference {
    const source = this.#requireSourceWorkspace(input.source_workspace_id);
    const target = this.#requireTargetWorkspace(input.reference_workspace_id);
    this.#assertDifferent(source, target);
    this.#assertIdle(source, target);
    return this.#settingsRepository.addWorkspaceReference({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      created_at: new Date().toISOString(),
    });
  }

  /** Only owner control or an approved owner request calls this method. */
  public setAccess(input: WorkspaceReferenceAccessInput): WorkspaceReference {
    const validated = WorkspaceReferenceAccessInputSchema.parse(input);
    const source = this.#requireSourceWorkspace(validated.source_workspace_id);
    const target = this.#requireTargetWorkspace(validated.reference_workspace_id);
    this.#assertDifferent(source, target);
    this.#assertIdle(source, target);
    return this.#settingsRepository.setWorkspaceReference({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      created_at: new Date().toISOString(),
      access_mode: validated.access_mode,
      ...(validated.access_mode === 'read_write'
        ? { source_root_path: source.rootPath, reference_root_path: target.rootPath }
        : {}),
    });
  }

  public async addFolder(input: WorkspaceReferenceFolderInput): Promise<WorkspaceReference> {
    const validated = WorkspaceReferenceFolderInputSchema.parse(input);
    const source = this.#requireSourceWorkspace(validated.source_workspace_id);
    if (
      validated.expected_source_root_path !== undefined &&
      validated.expected_source_root_path !== source.rootPath
    ) {
      throw new ChatSpliceError(
        'PATH_OUTSIDE_WORKSPACE',
        'workspace_reference_source_changed: The source project folder changed. Reopen folder settings and try again.',
      );
    }
    if (this.#workspaceService.isBusy(source.rootPath)) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        "Finish this project's queued or running work before changing shared folders.",
      );
    }
    const target = await this.#workspaceService.register(
      { root_path: validated.root_path },
      'reference',
    );
    if (this.#requireSourceWorkspace(source.workspace_id).rootPath !== source.rootPath) {
      throw new ChatSpliceError(
        'PATH_OUTSIDE_WORKSPACE',
        'workspace_reference_source_changed: The source project folder changed while access was being prepared. Reopen folder settings and try again.',
      );
    }
    return this.setAccess({
      source_workspace_id: source.workspace_id,
      reference_workspace_id: target.workspace_id,
      access_mode: validated.access_mode,
    });
  }

  public remove(input: WorkspaceReferenceMutationInput): WorkspaceReferenceListResult {
    const source = this.#requireSourceWorkspace(input.source_workspace_id);
    const target = this.#requireTargetWorkspace(input.reference_workspace_id);
    this.#assertIdle(source, target);
    return this.#settingsRepository.removeWorkspaceReference(input);
  }

  public removeWorkspace(workspaceId: string): WorkspaceReferenceListResult {
    return this.#settingsRepository.removeWorkspaceReferences(workspaceId);
  }

  public requireTarget(
    sourceWorkspaceId: string,
    referenceWorkspaceId: string,
    requiredMode: WorkspaceReferenceAccessMode = 'read_only',
  ): WorkspaceRecord {
    const source = this.#requireSourceWorkspace(sourceWorkspaceId);
    const target = this.#requireTargetWorkspace(referenceWorkspaceId);
    const reference = this.list().references.find(
      (item) =>
        item.source_workspace_id === sourceWorkspaceId &&
        item.reference_workspace_id === referenceWorkspaceId,
    );
    if (reference === undefined) {
      throw new ChatSpliceError(
        'REFERENCE_NOT_ALLOWED',
        'This folder is not shared with the bound project. Add it in ChatSplice first.',
      );
    }
    if (requiredMode === 'read_write' && reference.access_mode !== 'read_write') {
      throw new ChatSpliceError(
        'REFERENCE_NOT_ALLOWED',
        'This folder is read-only. The owner must allow editing in ChatSplice before files can change.',
      );
    }
    if (
      reference.access_mode === 'read_write' &&
      (reference.source_root_path !== source.rootPath ||
        reference.reference_root_path !== target.rootPath)
    ) {
      throw new ChatSpliceError(
        'PATH_OUTSIDE_WORKSPACE',
        'A project folder changed after write access was granted. The owner must confirm editing access again.',
      );
    }
    return target;
  }

  #assertDifferent(source: WorkspaceRecord, target: WorkspaceRecord): void {
    if (source.workspace_id === target.workspace_id) {
      throw new ChatSpliceError('BAD_REQUEST', 'A workspace cannot reference itself.');
    }
  }

  #assertIdle(source: WorkspaceRecord, target: WorkspaceRecord): void {
    if (
      this.#workspaceService.isBusy(source.rootPath) ||
      this.#workspaceService.isBusy(target.rootPath)
    ) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Finish queued or running project and folder operations before changing shared-folder access.',
      );
    }
  }

  #requireSourceWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.#workspaceService.getRecord(workspaceId);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Only registered user workspaces can hold a shared folder.',
      );
    }
    return workspace;
  }

  #requireTargetWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.#workspaceService.getRecord(workspaceId);
    if (workspace.kind !== 'user' && workspace.kind !== 'reference') {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Only user workspaces or approved reference folders can be shared.',
      );
    }
    return workspace;
  }
}
