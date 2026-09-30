import { randomBytes } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  RegisterWorkspaceInput,
  WorkspaceDetail,
  WorkspaceDetailListResult,
  WorkspaceKind,
  WorkspaceListResult,
  WorkspaceSummary,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceRecord, WorkspaceRepository } from './repository.js';
import { toWorkspaceDetail, toWorkspaceSummary } from './repository.js';
import { WorkspaceOperationLock } from './operation-lock.js';

const PROBE_CONTENT = [
  'ChatSplice Milestone 0 probe file.',
  'This file contains no credentials or user repository data.',
  '',
].join('\n');

export class WorkspaceService {
  readonly #repository: WorkspaceRepository;
  public readonly operations = new WorkspaceOperationLock();

  public constructor(repository: WorkspaceRepository) {
    this.#repository = repository;
  }

  public async register(
    input: RegisterWorkspaceInput,
    kind: WorkspaceKind = 'user',
  ): Promise<WorkspaceSummary> {
    const canonicalRoot = await realpath(input.root_path);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ChatSpliceError('BAD_REQUEST', 'The selected workspace root is not a directory.');
    }

    const existing = this.#repository.findByRoot(canonicalRoot);
    if (existing !== undefined) {
      return toWorkspaceSummary(existing);
    }

    const displayName = input.display_name?.trim() || basename(canonicalRoot) || 'Workspace';
    const record = this.#repository.create({
      workspaceId: `ws_${randomBytes(12).toString('hex')}`,
      displayName,
      rootPath: canonicalRoot,
      kind,
      createdAt: new Date().toISOString(),
    });
    return toWorkspaceSummary(record);
  }

  public async ensureProbeWorkspace(dataDirectory: string): Promise<WorkspaceSummary> {
    const probeRoot = join(dataDirectory, 'probe-workspace');
    await mkdir(probeRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(probeRoot, 'probe.txt'), PROBE_CONTENT, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return this.register(
      {
        root_path: probeRoot,
        display_name: 'ChatSplice Milestone 0 Probe',
      },
      'probe',
    );
  }

  public list(): WorkspaceListResult {
    const workspaces = this.#repository.list().map(toWorkspaceSummary);
    return { workspaces, count: workspaces.length };
  }

  public listDetailed(): WorkspaceDetailListResult {
    const workspaces = this.#repository.list().map(toWorkspaceDetail);
    return { workspaces, count: workspaces.length };
  }

  /**
   * Renames only the local ChatSplice sidebar label. It never touches the
   * filesystem folder name, the workspace_id, or the remote ChatGPT Project
   * name — those stay whatever they already were.
   */
  public rename(workspaceId: string, displayName: string): WorkspaceSummary {
    const workspace = this.getRecord(workspaceId);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError('BAD_REQUEST', 'The ChatSplice probe workspace cannot be renamed.');
    }
    const updated = this.#repository.rename(workspaceId, displayName);
    if (updated === undefined) {
      throw new ChatSpliceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace '${workspaceId}' is not registered.`,
      );
    }
    return toWorkspaceSummary(updated);
  }

  /**
   * Repoints a registered project at a different local folder — for example
   * after the user moved or renamed it on disk. workspace_id and the derived
   * workspace_binding never change, so an already-connected ChatGPT Project's
   * saved instructions stay valid.
   */
  public async updateRootPath(workspaceId: string, rootPath: string): Promise<WorkspaceDetail> {
    const workspace = this.getRecord(workspaceId);
    if (workspace.kind !== 'user') {
      throw new ChatSpliceError('BAD_REQUEST', 'Only a registered project folder can be changed.');
    }
    if (this.operations.isBusy(workspace.rootPath)) {
      throw new ChatSpliceError('BAD_REQUEST', 'This workspace has queued or running operations.');
    }
    const canonicalRoot = await realpath(rootPath);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ChatSpliceError('BAD_REQUEST', 'The selected folder is not a directory.');
    }
    const existing = this.#repository.findByRoot(canonicalRoot);
    if (existing !== undefined && existing.workspace_id !== workspaceId) {
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'Another registered project already uses that folder.',
      );
    }
    const updated = this.#repository.updateRootPath(workspaceId, canonicalRoot);
    if (updated === undefined) {
      throw new ChatSpliceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace '${workspaceId}' is not registered.`,
      );
    }
    return toWorkspaceDetail(updated);
  }

  /**
   * Removes the ChatSplice registry entry only. The selected filesystem folder
   * is deliberately left untouched.
   */
  public remove(workspaceId: string): WorkspaceDetailListResult {
    const workspace = this.getRecord(workspaceId);
    if (this.operations.isBusy(workspace.rootPath)) {
      throw new ChatSpliceError('BAD_REQUEST', 'This workspace has queued or running operations.');
    }
    if (workspace.kind === 'probe') {
      throw new ChatSpliceError('BAD_REQUEST', 'The ChatSplice probe workspace cannot be removed.');
    }
    if (!this.#repository.remove(workspaceId)) {
      throw new ChatSpliceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace '${workspaceId}' is not registered.`,
      );
    }
    return this.listDetailed();
  }

  public getRecord(workspaceId: string): WorkspaceRecord {
    const record = this.#repository.findById(workspaceId);
    if (record === undefined) {
      throw new ChatSpliceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace '${workspaceId}' is not registered. Call workspace.list and retry with an exact workspace_id.`,
      );
    }
    return record;
  }

  public async withOperation<T>(
    workspaceId: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const workspace = this.getRecord(workspaceId);
    return this.operations.run(
      workspace.rootPath,
      async () => {
        const current = this.getRecord(workspaceId);
        if (
          current.rootPath !== workspace.rootPath ||
          (await realpath(current.rootPath)) !== current.rootPath
        ) {
          throw new ChatSpliceError(
            'PATH_OUTSIDE_WORKSPACE',
            'The registered workspace root changed.',
          );
        }
        return action();
      },
      signal,
    );
  }
}

export { PROBE_CONTENT };
