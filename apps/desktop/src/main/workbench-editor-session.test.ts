import { describe, expect, it } from 'vitest';

import {
  MAX_EDITOR_DOCUMENT_BYTES,
  MAX_EDITOR_TABS_PER_WORKSPACE,
  MAX_EDITOR_TABS_TOTAL,
  WorkbenchEditorSessionManager,
  type EditorSessionPersistedState,
} from './workbench-editor-session.js';

const FIRST_WORKSPACE = 'ws_0123456789abcdef01234567';
const SECOND_WORKSPACE = 'ws_abcdef0123456789abcdef01';

function openFile(
  manager: WorkbenchEditorSessionManager,
  workspaceId: string,
  path: string,
  content = `content:${path}`,
) {
  return manager.openFile({
    workspace_id: workspaceId,
    path,
    content,
    sha256: 'a'.repeat(64),
  });
}

describe('WorkbenchEditorSessionManager', () => {
  it('keeps project tabs and active files separate while persisting metadata only', async () => {
    const persisted: EditorSessionPersistedState[] = [];
    const manager = new WorkbenchEditorSessionManager({
      persist: (state) => {
        persisted.push(state);
      },
    });

    const first = openFile(manager, FIRST_WORKSPACE, 'src/first.ts');
    openFile(manager, FIRST_WORKSPACE, 'src/second.ts');
    openFile(manager, SECOND_WORKSPACE, 'README.md');
    manager.selectWorkspace(FIRST_WORKSPACE);

    expect(first.document.content).toBe('content:src/first.ts');
    expect(manager.getState(FIRST_WORKSPACE)).toMatchObject({
      workspace_id: FIRST_WORKSPACE,
      tabs: [
        { path: 'src/first.ts', loaded: true },
        { path: 'src/second.ts', loaded: true },
      ],
    });
    expect(manager.getState(SECOND_WORKSPACE).tabs).toHaveLength(1);

    await manager.flushPersistence();
    const snapshot = persisted.at(-1);
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain('content:src/first.ts');
    expect(snapshot?.workspaces).toContainEqual({
      workspace_id: FIRST_WORKSPACE,
      active_editor_tab_id: manager.getState(FIRST_WORKSPACE).active_editor_tab_id,
      tabs: [
        { editor_tab_id: first.document.editor_tab_id, path: 'src/first.ts', label: 'first.ts' },
        {
          editor_tab_id: manager.getState(FIRST_WORKSPACE).tabs[1]?.editor_tab_id,
          path: 'src/second.ts',
          label: 'second.ts',
        },
      ],
    });

    const restored = new WorkbenchEditorSessionManager({ initialState: snapshot! });
    const restoredState = restored.getState(FIRST_WORKSPACE);
    expect(restoredState.tabs).toMatchObject([
      { path: 'src/first.ts', loaded: false, dirty: false },
      { path: 'src/second.ts', loaded: false, dirty: false },
    ]);
    expect(restoredState.active_editor_tab_id).toBe(
      manager.getState(FIRST_WORKSPACE).active_editor_tab_id,
    );
    expect(() =>
      restored.getDocument({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: first.document.editor_tab_id,
      }),
    ).toThrow('Editor document is not loaded.');
  });

  it('hydrates an unloaded tab without changing the active project or file', async () => {
    const persisted: EditorSessionPersistedState[] = [];
    const source = new WorkbenchEditorSessionManager({
      persist: (state) => {
        persisted.push(state);
      },
    });
    const first = openFile(source, FIRST_WORKSPACE, 'src/first.ts', 'first');
    const second = openFile(source, SECOND_WORKSPACE, 'src/second.ts', 'second');
    source.selectWorkspace(FIRST_WORKSPACE);
    await source.flushPersistence();

    const restored = new WorkbenchEditorSessionManager({ initialState: persisted.at(-1)! });
    restored.selectWorkspace(SECOND_WORKSPACE);
    const before = restored.getState();
    const hydrated = restored.hydrateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: first.document.editor_tab_id,
      path: 'src/first.ts',
      content: 'loaded from disk',
      sha256: 'b'.repeat(64),
    });

    expect(hydrated).toMatchObject({
      editor_tab_id: first.document.editor_tab_id,
      path: 'src/first.ts',
      content: 'loaded from disk',
      sha256: 'b'.repeat(64),
      draft_revision: 0,
      dirty: false,
    });
    expect(restored.getState()).toMatchObject({
      workspace_id: SECOND_WORKSPACE,
      active_editor_tab_id: second.document.editor_tab_id,
    });
    expect(restored.getState(FIRST_WORKSPACE).tabs).toMatchObject([
      { editor_tab_id: first.document.editor_tab_id, loaded: true, dirty: false },
    ]);
    expect(restored.getState().revision).toBeGreaterThan(before.revision);
  });

  it('ignores a late hydrate for a loaded draft and validates the tab path', () => {
    const manager = new WorkbenchEditorSessionManager();
    const first = openFile(manager, FIRST_WORKSPACE, 'src/first.ts', 'first');
    const second = openFile(manager, SECOND_WORKSPACE, 'src/second.ts', 'second');
    manager.selectWorkspace(SECOND_WORKSPACE);
    manager.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: first.document.editor_tab_id,
      content: 'draft',
      expected_revision: 0,
    });
    const before = manager.getState();

    const hydrated = manager.hydrateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: first.document.editor_tab_id,
      path: 'src/first.ts',
      content: 'late disk content',
      sha256: 'c'.repeat(64),
    });

    expect(hydrated).toMatchObject({
      content: 'draft',
      sha256: 'a'.repeat(64),
      draft_revision: 1,
      dirty: true,
    });
    expect(manager.getState()).toMatchObject({
      workspace_id: SECOND_WORKSPACE,
      active_editor_tab_id: second.document.editor_tab_id,
      revision: before.revision,
    });
    expect(() =>
      manager.hydrateDocument({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: first.document.editor_tab_id,
        path: 'src/other.ts',
        content: 'late disk content',
        sha256: 'c'.repeat(64),
      }),
    ).toThrow('path');
  });

  it('derives dirty state and preserves typing that races with a save', () => {
    const manager = new WorkbenchEditorSessionManager();
    const opened = openFile(manager, FIRST_WORKSPACE, 'src/app.ts', 'original');

    const updated = manager.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: opened.document.editor_tab_id,
      content: 'draft-v1',
      expected_revision: 0,
    });
    expect(updated.document).toMatchObject({ dirty: true, draft_revision: 1 });
    expect(() =>
      manager.updateDocument({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: opened.document.editor_tab_id,
        content: 'stale-update',
        expected_revision: 0,
      }),
    ).toThrow('EDITOR_DOCUMENT_REVISION_CONFLICT');

    const racedSave = manager.markSaved({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: opened.document.editor_tab_id,
      expected_revision: 1,
      content: 'draft-v1',
      sha256: 'b'.repeat(64),
    });
    expect(racedSave.document).toMatchObject({
      content: 'draft-v1',
      sha256: 'b'.repeat(64),
      dirty: false,
    });

    const secondUpdate = manager.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: opened.document.editor_tab_id,
      content: 'draft-v2',
      expected_revision: 1,
    });
    const saveCompletedAfterTyping = manager.markSaved({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: opened.document.editor_tab_id,
      expected_revision: secondUpdate.document.draft_revision,
      content: 'draft-v1',
      sha256: 'b'.repeat(64),
    });
    expect(saveCompletedAfterTyping.document).toMatchObject({
      content: 'draft-v2',
      sha256: 'b'.repeat(64),
      dirty: true,
    });
  });

  it('keeps the selected project stable when a background document save finishes', () => {
    const manager = new WorkbenchEditorSessionManager();
    const first = openFile(manager, FIRST_WORKSPACE, 'first.ts', 'first');
    const second = openFile(manager, SECOND_WORKSPACE, 'second.ts', 'second');
    manager.selectWorkspace(SECOND_WORKSPACE);

    manager.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: first.document.editor_tab_id,
      content: 'first draft',
      expected_revision: 0,
    });
    manager.markSaved({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: first.document.editor_tab_id,
      expected_revision: 1,
      content: 'first draft',
      sha256: 'c'.repeat(64),
    });

    expect(manager.getState()).toMatchObject({
      workspace_id: SECOND_WORKSPACE,
      active_editor_tab_id: second.document.editor_tab_id,
    });
  });

  it('activates ChatGPT without closing or reactivating the workspace file tabs', () => {
    const manager = new WorkbenchEditorSessionManager();
    const opened = openFile(manager, FIRST_WORKSPACE, 'first.ts', 'first');

    const state = manager.activateChat(FIRST_WORKSPACE);

    expect(state).toMatchObject({
      workspace_id: FIRST_WORKSPACE,
      active_editor_tab_id: null,
      tabs: [{ editor_tab_id: opened.document.editor_tab_id, path: 'first.ts' }],
    });
    expect(
      manager.getDocument({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: opened.document.editor_tab_id,
      }),
    ).toMatchObject({ content: 'first', dirty: false });
  });

  it('requires an explicit discard for dirty tab close and enforces bounded caps', () => {
    const manager = new WorkbenchEditorSessionManager();
    const opened = openFile(manager, FIRST_WORKSPACE, 'dirty.txt', 'clean');
    manager.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: opened.document.editor_tab_id,
      content: 'dirty',
      expected_revision: 0,
    });

    expect(
      manager.closeTab({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: opened.document.editor_tab_id,
      }),
    ).toMatchObject({ closed: false, reason: 'dirty' });
    expect(
      manager.closeTab({
        workspace_id: FIRST_WORKSPACE,
        editor_tab_id: opened.document.editor_tab_id,
        discard: true,
      }),
    ).toMatchObject({ closed: true });

    const capped = new WorkbenchEditorSessionManager();
    for (let index = 0; index < MAX_EDITOR_TABS_PER_WORKSPACE; index += 1) {
      openFile(capped, FIRST_WORKSPACE, `file-${index}.txt`);
    }
    expect(() => openFile(capped, FIRST_WORKSPACE, 'file-over-cap.txt')).toThrow(
      'EDITOR_WORKSPACE_TAB_LIMIT_REACHED',
    );

    const globalCapped = new WorkbenchEditorSessionManager();
    for (let index = 0; index < MAX_EDITOR_TABS_TOTAL; index += 1) {
      const workspaceId = `ws_${Math.floor(index / MAX_EDITOR_TABS_PER_WORKSPACE)
        .toString(16)
        .padStart(24, '0')}`;
      openFile(globalCapped, workspaceId, `file-${index}.txt`);
    }
    expect(() => openFile(globalCapped, 'ws_ffffffffffffffffffffffff', 'file.txt')).toThrow(
      'EDITOR_GLOBAL_TAB_LIMIT_REACHED',
    );

    expect(() =>
      openFile(
        globalCapped,
        'ws_ffffffffffffffffffffffff',
        'huge.txt',
        'x'.repeat(MAX_EDITOR_DOCUMENT_BYTES + 1),
      ),
    ).toThrow('EDITOR_DOCUMENT_SIZE_LIMIT_REACHED');

    const dirtyWorkspace = new WorkbenchEditorSessionManager();
    const dirty = openFile(dirtyWorkspace, FIRST_WORKSPACE, 'remove-me.ts', 'clean');
    dirtyWorkspace.updateDocument({
      workspace_id: FIRST_WORKSPACE,
      editor_tab_id: dirty.document.editor_tab_id,
      content: 'unsaved',
      expected_revision: 0,
    });
    expect(dirtyWorkspace.closeWorkspace(FIRST_WORKSPACE)).toMatchObject({
      closed: false,
      reason: 'dirty',
      dirty_document_ids: [dirty.document.editor_tab_id],
    });
    expect(dirtyWorkspace.closeWorkspace(FIRST_WORKSPACE, { discard: true })).toMatchObject({
      closed: true,
    });
    expect(dirtyWorkspace.getState(FIRST_WORKSPACE).tabs).toHaveLength(0);
  });

  it('rejects an unpaired trailing UTF-16 high surrogate', () => {
    const manager = new WorkbenchEditorSessionManager();

    expect(() => openFile(manager, FIRST_WORKSPACE, 'invalid.txt', '\ud800')).toThrow(
      'Editor content contains invalid UTF-16.',
    );
  });
});
