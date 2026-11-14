import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteWorkspaceRepository, WorkspaceService } from '@chatsplice/core';
import type { ReferenceRequestInput, ReferenceRequestStatus } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceBindingFor } from '../workspace-binding.js';
import { DirectEditActivityStore } from './direct-edit-activity-store.js';
import { ReferenceRequestStore } from './reference-request-store.js';

const SECRET = 'reference-request-test-binding';
const TARGET_ID = 'ws_111111111111111111111111';

describe('owner folder request scope', () => {
  let directory: string;
  let repository: SqliteWorkspaceRepository;
  let store: ReferenceRequestStore;
  let workspaces: WorkspaceService;
  let input: ReferenceRequestInput;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cs-ref-request-'));
    const root = join(directory, 'source');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(':memory:');
    workspaces = new WorkspaceService(repository);
    const workspace = await workspaces.register({ root_path: root });
    store = new ReferenceRequestStore(workspaces, SECRET, new DirectEditActivityStore());
    input = {
      workspace_id: workspace.workspace_id,
      workspace_binding: workspaceBindingFor(SECRET, workspace.workspace_id),
      path: join(directory, 'extra'),
      access_mode: 'read_only',
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('deduplicates only pending requests with the same source, path, label and access mode', () => {
    const legacy = store.submit(input);
    expect(legacy.access_mode).toBe('read_only');
    expect(store.submit({ ...input, access_mode: 'read_only' }).request_id).toBe(legacy.request_id);
    const write = store.submit({ ...input, access_mode: 'read_write' });
    expect(write.request_id).not.toBe(legacy.request_id);
    expect(write.access_mode).toBe('read_write');
    expect(store.submit({ ...input, label: 'Different purpose' }).request_id).not.toBe(
      legacy.request_id,
    );
    expect(store.submit({ ...input, path: join(directory, 'other') }).request_id).not.toBe(
      legacy.request_id,
    );
    expect(store.list().count).toBe(4);

    store.resolve(legacy.request_id, { approved: true, referenceWorkspaceId: TARGET_ID });
    expect(store.submit(input).request_id).not.toBe(legacy.request_id);
    expect(store.getPending(write.request_id)?.access_mode).toBe('read_write');
  });

  it('does not let returned pending values change the folder or permission being approved', async () => {
    const first = store.submit(input);
    const requestId = first.request_id;
    function tamper(status: ReferenceRequestStatus): void {
      status.access_mode = 'read_write';
      status.path = join(directory, 'changed');
      status.workspace_id = TARGET_ID;
    }
    tamper(first);
    tamper(store.submit(input));
    tamper(store.getPending(requestId)!);
    tamper(store.list().requests[0]!);
    tamper(await store.awaitResult(requestId, 0));
    expect(store.getPending(requestId)).toMatchObject({
      workspace_id: input.workspace_id,
      path: input.path,
      access_mode: 'read_only',
      state: 'pending_approval',
    });

    const approved = store.resolve(requestId, { approved: true, referenceWorkspaceId: TARGET_ID });
    expect(approved.access_mode).toBe('read_only');
    tamper(approved);
    const awaited = await store.awaitResult(requestId, 0);
    expect(awaited).toMatchObject({
      workspace_id: input.workspace_id,
      path: input.path,
      access_mode: 'read_only',
      state: 'approved',
    });
    tamper(awaited);
    expect((await store.awaitResult(requestId, 0)).access_mode).toBe('read_only');
  });

  it('never reuses denied or expired scope for a new write approval', async () => {
    vi.useFakeTimers();
    const denied = store.submit({ ...input, access_mode: 'read_write' });
    store.resolve(denied.request_id, { approved: false });
    const retry = store.submit({ ...input, access_mode: 'read_write' });
    expect(retry.request_id).not.toBe(denied.request_id);
    expect((await store.awaitResult(denied.request_id, 0)).state).toBe('denied');

    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(store.getPending(retry.request_id)).toBeUndefined();
    expect((await store.awaitResult(retry.request_id, 0)).state).toBe('expired');
    expect(store.submit({ ...input, access_mode: 'read_write' }).request_id).not.toBe(
      retry.request_id,
    );
  });

  it('keeps approved mode and scope intact while resolving a waiting caller', async () => {
    const pending = store.submit({ ...input, access_mode: 'read_write' });
    const waiting = store.awaitResult(pending.request_id, 1000);
    store.resolve(pending.request_id, { approved: true, referenceWorkspaceId: TARGET_ID });
    await expect(waiting).resolves.toMatchObject({
      state: 'approved',
      path: input.path,
      access_mode: 'read_write',
      reference_workspace_id: TARGET_ID,
    });
  });

  it('rejects a mismatched binding before retaining an owner request', () => {
    expect(() =>
      store.submit({
        ...input,
        workspace_binding: workspaceBindingFor(SECRET, TARGET_ID),
        access_mode: 'read_write',
      }),
    ).toThrow('binding');
    expect(store.list().count).toBe(0);
  });

  it('proposes read/write work for a new request with no explicit mode', () => {
    const pending = store.submit({
      workspace_id: input.workspace_id,
      workspace_binding: input.workspace_binding,
      path: input.path,
    });
    expect(pending).toMatchObject({
      state: 'pending_approval',
      access_mode: 'read_write',
      reference_workspace_id: null,
    });
    expect(store.submit({ ...input, access_mode: 'read_write' }).request_id).toBe(
      pending.request_id,
    );
    expect(store.submit(input).request_id).not.toBe(pending.request_id);
  });

  it.each([
    ['read_only', 'read_write'],
    ['read_write', 'read_only'],
  ] as const)(
    'returns the actual mode when %s was requested and %s was selected',
    async (requestedMode, selectedMode) => {
      const pending = store.submit({ ...input, access_mode: requestedMode });
      const grant = vi.fn(async () => TARGET_ID);
      const expectedRoot = workspaces.getRecord(input.workspace_id).rootPath;
      const result = await store.decide(
        { request_id: pending.request_id, approved: true, access_mode: selectedMode },
        grant,
      );
      expect(grant).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          request_id: pending.request_id,
          workspace_id: input.workspace_id,
          path: input.path,
          access_mode: requestedMode,
        }),
        selectedMode,
        expectedRoot,
      );
      expect(result).toMatchObject({
        request_id: pending.request_id,
        workspace_id: input.workspace_id,
        path: input.path,
        state: 'approved',
        access_mode: selectedMode,
        reference_workspace_id: TARGET_ID,
      });
      expect(await store.awaitResult(pending.request_id, 0)).toEqual(result);
    },
  );

  it.each(['read_only', 'read_write'] as const)(
    'preserves requested %s when an older owner omits the decision mode',
    async (requestedMode) => {
      const pending = store.submit({ ...input, access_mode: requestedMode });
      const grant = vi.fn(async () => TARGET_ID);
      const result = await store.decide({ request_id: pending.request_id, approved: true }, grant);
      expect(result.access_mode).toBe(requestedMode);
      expect(grant).toHaveBeenCalledOnce();
    },
  );

  it('denies without granting and replays only that completed decision', async () => {
    const pending = store.submit(input);
    const grant = vi.fn(async () => TARGET_ID);
    const decision = { request_id: pending.request_id, approved: false };
    const denied = await store.decide(decision, grant);
    expect(denied).toMatchObject({
      state: 'denied',
      reference_workspace_id: null,
      access_mode: 'read_only',
    });
    expect(await store.decide(decision, grant)).toEqual(denied);
    await expect(
      store.decide(
        { request_id: pending.request_id, approved: true, access_mode: 'read_write' },
        grant,
      ),
    ).rejects.toThrow('different owner decision');
    expect(grant).not.toHaveBeenCalled();
  });

  it('shares one in-flight grant, protects its source and retains it past TTL', async () => {
    vi.useFakeTimers();
    const pending = store.submit(input);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const grant = vi.fn(async () => {
      await gate;
      return TARGET_ID;
    });
    const decision = {
      request_id: pending.request_id,
      approved: true,
      access_mode: 'read_write' as const,
    };
    const first = store.decide(decision, grant);
    const second = store.decide(decision, grant);
    try {
      expect(() => store.assertNoApplyingDecision(input.workspace_id)).toThrow('being applied');
      expect(() => store.removeWorkspace(input.workspace_id)).toThrow('being applied');
      expect(() =>
        store.resolve(pending.request_id, { approved: true, referenceWorkspaceId: TARGET_ID }),
      ).toThrow('being applied');
      await expect(store.decide({ ...decision, access_mode: 'read_only' }, grant)).rejects.toThrow(
        'different owner decision',
      );
      await expect(
        store.decide({ request_id: pending.request_id, approved: false }, grant),
      ).rejects.toThrow('different owner decision');
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(store.list().count).toBe(1);
      expect(store.getStatus(pending.request_id)?.state).toBe('pending_approval');
      expect(grant).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({ state: 'approved', access_mode: 'read_write' });
    expect(grant).toHaveBeenCalledOnce();
    expect(() => store.assertNoApplyingDecision(input.workspace_id)).not.toThrow();

    firstResult.access_mode = 'read_only';
    expect((await store.awaitResult(pending.request_id, 0)).access_mode).toBe('read_write');
    expect((await store.decide(decision, grant)).access_mode).toBe('read_write');
    expect(grant).toHaveBeenCalledOnce();
    // Omission still means the original requested mode, not the selected mode.
    await expect(
      store.decide({ request_id: pending.request_id, approved: true }, grant),
    ).rejects.toThrow('different owner decision');
  });

  it('keeps the first choice after a failed grant and permits the same retry', async () => {
    const pending = store.submit(input);
    const grant = vi.fn(async () => TARGET_ID).mockRejectedValueOnce(new Error('folder busy'));
    const decision = {
      request_id: pending.request_id,
      approved: true,
      access_mode: 'read_write' as const,
    };
    await expect(store.decide(decision, grant)).rejects.toThrow('folder busy');
    expect(store.getPending(pending.request_id)?.state).toBe('pending_approval');
    expect(() => store.assertNoApplyingDecision(input.workspace_id)).not.toThrow();
    await expect(store.decide({ ...decision, access_mode: 'read_only' }, grant)).rejects.toThrow(
      'different owner decision',
    );
    expect(grant).toHaveBeenCalledOnce();
    await expect(store.decide(decision, grant)).resolves.toMatchObject({
      state: 'approved',
      access_mode: 'read_write',
    });
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it('expires a failed attempt and rejects an expired decision before granting', async () => {
    vi.useFakeTimers();
    const pending = store.submit(input);
    const grant = vi.fn(async () => TARGET_ID).mockRejectedValueOnce(new Error('folder busy'));
    const decision = { request_id: pending.request_id, approved: true };
    await expect(store.decide(decision, grant)).rejects.toThrow('folder busy');
    vi.advanceTimersByTime(15 * 60_000 + 1);
    await expect(store.decide(decision, grant)).rejects.toThrow('expired');
    expect(store.getStatus(pending.request_id)?.state).toBe('expired');
    expect(grant).toHaveBeenCalledOnce();
  });

  it('pins the source root and requires a fresh request after it changes', async () => {
    const pending = store.submit(input);
    const original = workspaces.getRecord(input.workspace_id);
    vi.spyOn(workspaces, 'getRecord').mockReturnValue({
      ...original,
      rootPath: join(directory, 'different-source'),
    });
    const grant = vi.fn(async () => TARGET_ID);
    await expect(
      store.decide(
        { request_id: pending.request_id, approved: true, access_mode: 'read_write' },
        grant,
      ),
    ).rejects.toThrow('source project folder changed');
    expect(grant).not.toHaveBeenCalled();
    expect(store.submit(input).request_id).not.toBe(pending.request_id);
  });

  it.each([
    'relative/folder',
    '~/project',
    '/folder\nanother-folder',
    '/folder\rspoof',
    '/folder\u0000name',
    '/folder\u007fname',
  ])('rejects invalid path text before retaining a request: %j', (path) => {
    expect(() => store.submit({ ...input, path })).toThrow(
      'absolute path without control characters',
    );
    expect(store.list().count).toBe(0);
  });
});
