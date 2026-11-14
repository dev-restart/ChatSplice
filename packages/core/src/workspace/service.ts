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
import { isWithinOrEqualRoot } from '../fs/path-policy.js';

const PROBE_CONTENT = [
  'ChatSplice Milestone 0 probe file.',
  'This file contains no credentials or user repository data.',
  '',
].join('\n');

export class WorkspaceService {
  readonly #repository: WorkspaceRepository;
  public readonly operations = new WorkspaceOperationLock();
  readonly #concurrentRoots = new Map<string, number>();

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
    if (this.isBusy(workspace.rootPath)) {
      throw new ChatSpliceError('BAD_REQUEST', 'This workspace has queued or running operations.');
    }
    const canonicalRoot = await realpath(rootPath);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ChatSpliceError('BAD_REQUEST', 'The selected folder is not a directory.');
    }
    // Folder validation yields to other operations. Recheck immediately before
    // the synchronous registry update so a new lease or another root change
    // cannot be overwritten by this stale request.
    const current = this.getRecord(workspaceId);
    if (current.rootPath !== workspace.rootPath) {
      throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'The registered workspace root changed.');
    }
    if (this.isBusy(current.rootPath)) {
      throw new ChatSpliceError('BAD_REQUEST', 'This workspace has queued or running operations.');
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
    if (this.isBusy(workspace.rootPath)) {
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

  public withOperation<T>(
    workspaceId: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withOperations([workspaceId], action, signal);
  }

  public async withOperations<T>(
    workspaceIds: readonly string[],
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const workspaces = this.#operationWorkspaces(workspaceIds);
    return this.operations.runMany(
      workspaces.map((workspace) => workspace.rootPath),
      async () => {
        await this.#assertOperationRoots(workspaces);
        signal?.throwIfAborted();
        return action();
      },
      signal,
    );
  }

  #operationWorkspaces(workspaceIds: readonly string[]): WorkspaceRecord[] {
    const ids = [...new Set(workspaceIds)];
    if (ids.length === 0 || ids.length > 101) {
      throw new ChatSpliceError('BAD_REQUEST', 'A workspace operation requires 1–101 folders.');
    }
    return ids.map((workspaceId) => this.getRecord(workspaceId));
  }

  async #assertOperationRoots(workspaces: readonly WorkspaceRecord[]): Promise<void> {
    for (const workspace of workspaces) {
      const canonical = await realpath(workspace.rootPath);
      if (
        canonical !== workspace.rootPath ||
        this.getRecord(workspace.workspace_id).rootPath !== workspace.rootPath
      ) {
        throw new ChatSpliceError(
          'PATH_OUTSIDE_WORKSPACE',
          'A participating workspace folder changed.',
        );
      }
    }
  }

  public isBusy(root: string): boolean {
    return (
      this.operations.isBusy(root) ||
      [...this.#concurrentRoots.keys()].some(
        (active) => isWithinOrEqualRoot(active, root) || isWithinOrEqualRoot(root, active),
      )
    );
  }

  /** Keep background process roots stable without holding the file mutation lock. */
  public withConcurrentOperation<T>(
    workspaceId: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withConcurrentOperations([workspaceId], action, signal);
  }

  /** Pin every folder used by a server while ordinary file edits remain available. */
  public async withConcurrentOperations<T>(
    workspaceIds: readonly string[],
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const workspaces = this.#operationWorkspaces(workspaceIds);
    const roots = [...new Set(workspaces.map((workspace) => workspace.rootPath))];
    for (const root of roots) {
      this.#concurrentRoots.set(root, (this.#concurrentRoots.get(root) ?? 0) + 1);
    }
    try {
      await this.#assertOperationRoots(workspaces);
      signal?.throwIfAborted();
      return await action();
    } finally {
      for (const root of roots) {
        const remaining = (this.#concurrentRoots.get(root) ?? 1) - 1;
        if (remaining === 0) this.#concurrentRoots.delete(root);
        else this.#concurrentRoots.set(root, remaining);
      }
    }
  }
}

export { PROBE_CONTENT };
