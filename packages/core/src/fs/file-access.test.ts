import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FsDeleteInputSchema,
  FsEditInputSchema,
  FsListInputSchema,
  FsMkdirInputSchema,
  FsReadInputSchema,
  FsRenameInputSchema,
  FsSearchInputSchema,
  FsWriteInputSchema,
} from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteSettingsRepository } from '../settings/sqlite-repository.js';
import { WorkspaceReferenceService } from '../workspace/reference-service.js';
import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { listWorkspacePaths, searchWorkspaceText } from './discover-workspace.js';
import { editWorkspaceFile } from './edit-file.js';
import { withWorkspaceFileAccess } from './file-access.js';
import {
  deleteWorkspaceFile,
  makeWorkspaceDirectory,
  renameWorkspaceFile,
  writeWorkspaceFile,
} from './file-lifecycle.js';
import { readWorkspaceFile } from './read-file.js';

const binding = `wb_${'0'.repeat(64)}`;
const initial = 'pub const EXTERNAL: bool = true;\n';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('owner-approved folder file access', () => {
  let temporaryDirectory: string;
  let sourceRoot: string;
  let sharedRoot: string;
  let repository: SqliteWorkspaceRepository;
  let settings: SqliteSettingsRepository;
  let service: WorkspaceService;
  let references: WorkspaceReferenceService;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-folder-files-'));
    sourceRoot = join(temporaryDirectory, 'source');
    sharedRoot = join(temporaryDirectory, 'shared');
    await mkdir(sourceRoot);
    await mkdir(sharedRoot);
    await writeFile(join(sourceRoot, 'main.rs'), '// source stays intact\n');
    await writeFile(join(sharedRoot, 'main.rs'), initial);
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    repository = new SqliteWorkspaceRepository(databasePath);
    settings = new SqliteSettingsRepository(databasePath);
    service = new WorkspaceService(repository);
    references = new WorkspaceReferenceService(service, settings);
    sourceId = (await service.register({ root_path: sourceRoot, display_name: 'Source' }))
      .workspace_id;
    targetId = (
      await service.register({ root_path: sharedRoot, display_name: 'Shared' }, 'reference')
    ).workspace_id;
  });

  afterEach(async () => {
    settings.close();
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const base = () => ({
    workspace_id: sourceId,
    workspace_binding: binding,
    reference_workspace_id: targetId,
  });
  const allow = (access_mode: 'read_only' | 'read_write' = 'read_write') =>
    references.setAccess({
      source_workspace_id: sourceId,
      reference_workspace_id: targetId,
      access_mode,
    });

  it('keeps legacy grants read-only and returns source and selected-folder identities', async () => {
    references.add({ source_workspace_id: sourceId, reference_workspace_id: targetId });
    const read = await readWorkspaceFile(
      service,
      FsReadInputSchema.parse({ ...base(), path: 'main.rs' }),
      references,
    );
    expect(read).toMatchObject({
      workspace_id: sourceId,
      workspace_name: 'Source',
      reference_workspace_id: targetId,
      reference_workspace_name: 'Shared',
      sha256: hash(initial),
    });
    expect(read.content).toContain('EXTERNAL');
    expect(references.listTargets(sourceId)).toEqual([
      expect.objectContaining({
        workspace_id: targetId,
        access_mode: 'read_only',
        root_path: service.getRecord(targetId).rootPath,
      }),
    ]);
    const listed = await listWorkspacePaths(service, FsListInputSchema.parse(base()), references);
    expect(listed).toMatchObject({ workspace_id: sourceId, reference_workspace_id: targetId });
    expect(listed.entries).toContainEqual({ path: 'main.rs', type: 'file' });
    const search = await searchWorkspaceText(
      service,
      FsSearchInputSchema.parse({ ...base(), query: 'EXTERNAL' }),
      references,
    );
    expect(search).toMatchObject({
      workspace_id: sourceId,
      reference_workspace_id: targetId,
      count: 1,
    });

    const attempts = [
      () =>
        editWorkspaceFile(
          service,
          FsEditInputSchema.parse({
            ...base(),
            path: 'main.rs',
            expected_sha256: hash(initial),
            edits: [{ old_text: 'true', new_text: 'false' }],
          }),
          references,
        ),
      () =>
        writeWorkspaceFile(
          service,
          FsWriteInputSchema.parse({
            ...base(),
            path: 'main.rs',
            mode: 'replace',
            expected_sha256: hash(initial),
            content: 'changed',
          }),
          references,
        ),
      () =>
        makeWorkspaceDirectory(
          service,
          FsMkdirInputSchema.parse({ ...base(), path: 'src' }),
          references,
        ),
      () =>
        renameWorkspaceFile(
          service,
          FsRenameInputSchema.parse({
            ...base(),
            source_path: 'main.rs',
            destination_path: 'lib.rs',
            expected_sha256: hash(initial),
          }),
          references,
        ),
      () =>
        deleteWorkspaceFile(
          service,
          FsDeleteInputSchema.parse({ ...base(), path: 'main.rs', expected_sha256: hash(initial) }),
          references,
        ),
    ];
    for (const attempt of attempts)
      await expect(attempt()).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    expect(await readFile(join(sharedRoot, 'main.rs'), 'utf8')).toBe(initial);
  });

  it('preserves legacy direct reference/probe reads while rejecting direct writes to them', async () => {
    const legacy = await readWorkspaceFile(
      service,
      FsReadInputSchema.parse({
        workspace_id: targetId,
        workspace_binding: binding,
        path: 'main.rs',
      }),
    );
    expect(legacy.workspace_id).toBe(targetId);
    expect(legacy.reference_workspace_id).toBeUndefined();
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          workspace_id: targetId,
          workspace_binding: binding,
          path: 'main.rs',
          expected_sha256: hash(initial),
          edits: [{ old_text: 'true', new_text: 'false' }],
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const probeRoot = join(temporaryDirectory, 'probe');
    await mkdir(probeRoot);
    await writeFile(join(probeRoot, 'probe.txt'), 'probe');
    const probe = await service.register({ root_path: probeRoot }, 'probe');
    expect(
      (
        await readWorkspaceFile(
          service,
          FsReadInputSchema.parse({
            workspace_id: probe.workspace_id,
            workspace_binding: binding,
            path: 'probe.txt',
          }),
        )
      ).content,
    ).toBe('probe');
    expect(() =>
      references.setAccess({
        source_workspace_id: sourceId,
        reference_workspace_id: probe.workspace_id,
        access_mode: 'read_write',
      }),
    ).toThrow();
    await expect(
      writeWorkspaceFile(
        service,
        FsWriteInputSchema.parse({
          workspace_id: probe.workspace_id,
          workspace_binding: binding,
          path: 'probe.txt',
          mode: 'replace',
          expected_sha256: hash('probe'),
          content: 'changed',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('edits, replaces and deletes Rust files only in the approved folder', async () => {
    allow();
    const edit = await editWorkspaceFile(
      service,
      FsEditInputSchema.parse({
        ...base(),
        path: 'main.rs',
        expected_sha256: hash(initial),
        edits: [{ old_text: 'true', new_text: 'false' }],
      }),
      references,
    );
    expect(edit).toMatchObject({ workspace_id: sourceId, reference_workspace_id: targetId });
    expect(await readFile(join(sourceRoot, 'main.rs'), 'utf8')).toBe('// source stays intact\n');
    expect(await readFile(join(sharedRoot, 'main.rs'), 'utf8')).toBe(
      initial.replace('true', 'false'),
    );
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          ...base(),
          path: 'main.rs',
          expected_sha256: hash(initial),
          edits: [{ old_text: 'false', new_text: 'true' }],
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const replaced = await writeWorkspaceFile(
      service,
      FsWriteInputSchema.parse({
        ...base(),
        path: 'main.rs',
        mode: 'replace',
        expected_sha256: edit.sha256,
        content: 'fn main() {}\n',
      }),
      references,
    );
    const made = await makeWorkspaceDirectory(
      service,
      FsMkdirInputSchema.parse({ ...base(), path: 'src' }),
      references,
    );
    expect(made).toMatchObject({
      workspace_id: sourceId,
      reference_workspace_id: targetId,
      created: true,
    });
    const deleted = await deleteWorkspaceFile(
      service,
      FsDeleteInputSchema.parse({
        ...base(),
        path: 'main.rs',
        expected_sha256: replaced.sha256,
      }),
      references,
    );
    expect(deleted).toMatchObject({ workspace_id: sourceId, reference_workspace_id: targetId });
    await expect(readFile(join(sharedRoot, 'main.rs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(sourceRoot, 'main.rs'), 'utf8')).toBe('// source stays intact\n');
  });

  it('creates and renames approved-folder files without overwriting an existing destination', async () => {
    allow();
    const created = await writeWorkspaceFile(
      service,
      FsWriteInputSchema.parse({
        ...base(),
        path: 'new.rs',
        mode: 'create',
        content: 'pub fn shared() {}\n',
      }),
      references,
    );
    expect(created).toMatchObject({ workspace_id: sourceId, reference_workspace_id: targetId });
    await expect(
      writeWorkspaceFile(
        service,
        FsWriteInputSchema.parse({
          ...base(),
          path: 'new.rs',
          mode: 'create',
          content: 'must not overwrite',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const moved = await renameWorkspaceFile(
      service,
      FsRenameInputSchema.parse({
        ...base(),
        source_path: 'new.rs',
        destination_path: 'renamed.rs',
        expected_sha256: created.sha256,
      }),
      references,
    );
    expect(moved).toMatchObject({ workspace_id: sourceId, reference_workspace_id: targetId });
    expect(await readFile(join(sharedRoot, 'renamed.rs'), 'utf8')).toBe('pub fn shared() {}\n');
    await expect(readFile(join(sharedRoot, 'new.rs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the exact one-way relationship and a real reference service', async () => {
    allow();
    const otherRoot = join(temporaryDirectory, 'other');
    await mkdir(otherRoot);
    const other = await service.register({ root_path: otherRoot });
    const read = FsReadInputSchema.parse({ ...base(), path: 'main.rs' });
    await expect(readWorkspaceFile(service, read)).rejects.toMatchObject({
      code: 'REFERENCE_NOT_ALLOWED',
    });
    await expect(
      readWorkspaceFile(service, { ...read, workspace_id: other.workspace_id }, references),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    await expect(
      readWorkspaceFile(
        service,
        { ...read, reference_workspace_id: other.workspace_id },
        references,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    await expect(
      readWorkspaceFile(service, { ...read, reference_workspace_id: sourceId }, references),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    expect(() =>
      references.setAccess({
        source_workspace_id: targetId,
        reference_workspace_id: other.workspace_id,
        access_mode: 'read_write',
      }),
    ).toThrow();
  });

  it('retains traversal and secret-path guards within approved folders', async () => {
    allow();
    await writeFile(join(sharedRoot, '.env'), 'SECRET=value');
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          ...base(),
          path: '.env',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          ...base(),
          path: '../source/main.rs',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(
      writeWorkspaceFile(
        service,
        FsWriteInputSchema.parse({
          ...base(),
          path: '.env',
          mode: 'replace',
          expected_sha256: hash('SECRET=value'),
          content: 'changed',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    expect(await readFile(join(sharedRoot, '.env'), 'utf8')).toBe('SECRET=value');
  });

  it('adds a folder directly, pins write scope and preserves legacy-add permissions', async () => {
    const grant = await references.addFolder({
      source_workspace_id: sourceId,
      root_path: sharedRoot,
      access_mode: 'read_write',
    });
    expect(grant).toMatchObject({
      source_workspace_id: sourceId,
      reference_workspace_id: targetId,
      access_mode: 'read_write',
      source_root_path: service.getRecord(sourceId).rootPath,
      reference_root_path: service.getRecord(targetId).rootPath,
    });
    expect(service.getRecord(targetId).kind).toBe('reference');
    expect(
      references.add({ source_workspace_id: sourceId, reference_workspace_id: targetId }),
    ).toEqual(grant);
    expect(() =>
      references.setAccess({
        source_workspace_id: sourceId,
        reference_workspace_id: sourceId,
        access_mode: 'read_write',
      }),
    ).toThrow();
  });

  it('rejects a stale folder-picker receipt before registering or granting the selected folder', async () => {
    const selectedRoot = join(temporaryDirectory, 'new-shared-folder');
    await mkdir(selectedRoot);
    const beforeWorkspaces = service.listDetailed();
    const beforeReferences = references.list();
    await expect(
      references.addFolder({
        source_workspace_id: sourceId,
        root_path: selectedRoot,
        access_mode: 'read_write',
        expected_source_root_path: join(temporaryDirectory, 'previous-source'),
      }),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
      message: expect.stringContaining('workspace_reference_source_changed'),
    });
    expect(service.listDetailed()).toEqual(beforeWorkspaces);
    expect(references.list()).toEqual(beforeReferences);
  });

  it('accepts a folder-picker receipt for the current source root', async () => {
    const grant = await references.addFolder({
      source_workspace_id: sourceId,
      root_path: sharedRoot,
      access_mode: 'read_write',
      expected_source_root_path: service.getRecord(sourceId).rootPath,
    });
    expect(grant).toMatchObject({
      source_workspace_id: sourceId,
      reference_workspace_id: targetId,
      access_mode: 'read_write',
      source_root_path: service.getRecord(sourceId).rootPath,
      reference_root_path: service.getRecord(targetId).rootPath,
    });
  });

  it('rejects stale write grants for both reading and writing after source root changes', async () => {
    allow();
    const movedRoot = join(temporaryDirectory, 'moved-source');
    await mkdir(movedRoot);
    await service.updateRootPath(sourceId, movedRoot);
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({ ...base(), path: 'main.rs' }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          ...base(),
          path: 'main.rs',
          expected_sha256: hash(initial),
          edits: [{ old_text: 'true', new_text: 'false' }],
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    allow();
    expect(
      (
        await readWorkspaceFile(
          service,
          FsReadInputSchema.parse({ ...base(), path: 'main.rs' }),
          references,
        )
      ).sha256,
    ).toBe(hash(initial));
  });

  it('pins a linked user project root as well as the source root', async () => {
    const linkedRoot = join(temporaryDirectory, 'linked');
    const movedRoot = join(temporaryDirectory, 'moved-linked');
    await mkdir(linkedRoot);
    await mkdir(movedRoot);
    await writeFile(join(linkedRoot, 'main.rs'), 'original');
    await writeFile(join(movedRoot, 'main.rs'), 'replacement must stay unread');
    const linked = await service.register({ root_path: linkedRoot });
    references.setAccess({
      source_workspace_id: sourceId,
      reference_workspace_id: linked.workspace_id,
      access_mode: 'read_write',
    });
    await service.updateRootPath(linked.workspace_id, movedRoot);
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({
          ...base(),
          reference_workspace_id: linked.workspace_id,
          path: 'main.rs',
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('blocks permission changes while either reserved folder has active work', async () => {
    allow();
    for (const id of [sourceId, targetId]) {
      const release = service.operations.tryReserve(service.getRecord(id).rootPath);
      expect(release).toBeTypeOf('function');
      try {
        expect(() => allow('read_only')).toThrow();
        expect(() =>
          references.remove({ source_workspace_id: sourceId, reference_workspace_id: targetId }),
        ).toThrow();
      } finally {
        release?.();
      }
    }
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const active = withWorkspaceFileAccess(service, base(), 'read_only', references, async () => {
      started();
      await held;
    });
    await ready;
    try {
      expect(() => allow('read_only')).toThrow();
      await expect(service.updateRootPath(sourceId, sourceRoot)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    } finally {
      release();
      await active;
    }
    allow('read_only');
    await expect(
      editWorkspaceFile(
        service,
        FsEditInputSchema.parse({
          ...base(),
          path: 'main.rs',
          expected_sha256: hash(initial),
          edits: [{ old_text: 'true', new_text: 'false' }],
        }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    references.remove({ source_workspace_id: sourceId, reference_workspace_id: targetId });
    await expect(
      readWorkspaceFile(
        service,
        FsReadInputSchema.parse({ ...base(), path: 'main.rs' }),
        references,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
  });

  it('expires a queued write without leaving a mutation that can run later', async () => {
    allow();
    const release = service.operations.tryReserve(service.getRecord(targetId).rootPath)!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mutate = vi.fn(async () => {
      await writeFile(join(sharedRoot, 'main.rs'), 'must never be written');
    });
    const pending = withWorkspaceFileAccess(service, base(), 'read_write', references, mutate);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(mutate).not.toHaveBeenCalled();
      expect(service.operations.isBusy(service.getRecord(sourceId).rootPath)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('[WORKSPACE_OPERATION_WAIT_TIMEOUT]'),
      });
      expect(service.operations.isBusy(service.getRecord(sourceId).rootPath)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      release();
      await service.withOperation(targetId, async () => undefined);
      expect(mutate).not.toHaveBeenCalled();
      expect(await readFile(join(sharedRoot, 'main.rs'), 'utf8')).toBe(initial);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('clears the wait deadline once a write starts and waits for its real result', async () => {
    allow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let start!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = withWorkspaceFileAccess(service, base(), 'read_write', references, async () => {
      start();
      await held;
      await writeFile(join(sharedRoot, 'main.rs'), 'completed after waiting deadline');
      return 'completed';
    });
    try {
      await ready;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.operations.isBusy(service.getRecord(targetId).rootPath)).toBe(true);
      finish();
      await expect(running).resolves.toBe('completed');
      expect(await readFile(join(sharedRoot, 'main.rs'), 'utf8')).toBe(
        'completed after waiting deadline',
      );
      expect(service.operations.isBusy(service.getRecord(targetId).rootPath)).toBe(false);
    } finally {
      finish();
      await running;
      vi.useRealTimers();
    }
  });

  it('rechecks the persisted grant before a queued mutation starts', async () => {
    allow();
    const release = service.operations.tryReserve(service.getRecord(targetId).rootPath);
    expect(release).toBeTypeOf('function');
    const queued = editWorkspaceFile(
      service,
      FsEditInputSchema.parse({
        ...base(),
        path: 'main.rs',
        expected_sha256: hash(initial),
        edits: [{ old_text: 'true', new_text: 'false' }],
      }),
      references,
    );
    const rejected = expect(queued).rejects.toMatchObject({ code: 'REFERENCE_NOT_ALLOWED' });
    // Simulate policy restoration outside the normal busy-guarded owner API.
    settings.removeWorkspaceReference({
      source_workspace_id: sourceId,
      reference_workspace_id: targetId,
    });
    release?.();
    await rejected;
    expect(await readFile(join(sharedRoot, 'main.rs'), 'utf8')).toBe(initial);
  });
});
