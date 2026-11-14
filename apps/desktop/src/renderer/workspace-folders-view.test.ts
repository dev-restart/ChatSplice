import type { WorkspaceDetail, WorkspaceReference } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';
import {
  workspaceFolderAccess,
  workspaceFolderErrorKey,
  workspaceFolderPath,
  workspaceFolderNeedsReapproval,
} from './workspace-folders-view.js';

const reference: WorkspaceReference = {
  source_workspace_id: `ws_${'a'.repeat(24)}`,
  reference_workspace_id: `ws_${'b'.repeat(24)}`,
  created_at: '2026-10-19T00:00:00.000Z',
};

describe('workspace folder access presentation', () => {
  it('keeps existing references read-only until explicitly changed', () => {
    expect(workspaceFolderAccess(reference)).toBe('read_only');
    expect(workspaceFolderAccess({ ...reference, access_mode: 'read_write' })).toBe('read_write');
  });

  it('resolves the actual reference path by immutable ID, including reference-only folders', () => {
    const folder: WorkspaceDetail = {
      workspace_id: reference.reference_workspace_id,
      display_name: 'Shared folder',
      root_path: '/fixture/shared',
      kind: 'reference',
      created_at: reference.created_at,
    };
    expect(workspaceFolderPath(reference, [folder])).toBe('/fixture/shared');
    expect(workspaceFolderPath(reference, [])).toBe('');
  });

  it('requires reapproval when either pinned root changes or becomes unavailable', () => {
    const workspaces: WorkspaceDetail[] = [
      {
        workspace_id: reference.source_workspace_id,
        display_name: 'Project',
        root_path: '/fixture/project',
        kind: 'user',
        created_at: reference.created_at,
      },
      {
        workspace_id: reference.reference_workspace_id,
        display_name: 'Shared folder',
        root_path: '/fixture/shared',
        kind: 'reference',
        created_at: reference.created_at,
      },
    ];
    const writable: WorkspaceReference = {
      ...reference,
      access_mode: 'read_write',
      source_root_path: '/fixture/project',
      reference_root_path: '/fixture/shared',
    };
    expect(workspaceFolderNeedsReapproval(writable, workspaces)).toBe(false);
    for (const workspace of workspaces) {
      const moved = workspaces.map((entry) =>
        entry.workspace_id === workspace.workspace_id
          ? { ...entry, root_path: '/fixture/moved' }
          : entry,
      );
      expect(workspaceFolderNeedsReapproval(writable, moved)).toBe(true);
    }
    expect(workspaceFolderNeedsReapproval(writable, workspaces.slice(0, 1))).toBe(true);
    expect(
      workspaceFolderNeedsReapproval({ ...reference, access_mode: 'read_write' }, workspaces),
    ).toBe(true);
  });

  it('does not require write reapproval for legacy or explicit read-only references', () => {
    expect(workspaceFolderNeedsReapproval(reference, [])).toBe(false);
    expect(workspaceFolderNeedsReapproval({ ...reference, access_mode: 'read_only' }, [])).toBe(
      false,
    );
  });

  it('turns busy and refresh failures into actionable messages without echoing raw errors', () => {
    expect(workspaceFolderErrorKey(new Error('workspace_reference_busy'))).toBe(
      'workspaceFolderBusy',
    );
    expect(workspaceFolderErrorKey(new Error('workspace_reference_refresh_failed'))).toBe(
      'workspaceFolderRefreshFailed',
    );
    expect(workspaceFolderErrorKey(new Error('secret /arbitrary/path'))).toBe(
      'workspaceFolderFailed',
    );
  });
});
