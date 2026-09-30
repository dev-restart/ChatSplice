import { describe, expect, it } from 'vitest';

import {
  clampSidebarWidth,
  clampConsoleHeight,
  clampFilesPanelWidth,
  contentTopInset,
  DEFAULT_SIDEBAR_WIDTH,
  FILES_PANEL_DEFAULT_WIDTH,
  CONSOLE_DEFAULT_HEIGHT,
  layoutBounds,
  MACOS_TITLEBAR_HEIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  workspacePanelBounds,
} from './sidebar-layout.js';

describe('sidebar layout', () => {
  it('reserves the compact native chrome row only on macOS', () => {
    expect(contentTopInset(true)).toBe(MACOS_TITLEBAR_HEIGHT);
    expect(contentTopInset(false)).toBe(0);
  });

  it('clamps the remembered width to safe bounds and available space', () => {
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1440)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 700)).toBe(280);
  });

  it('gives the ChatGPT view all available width when collapsed', () => {
    expect(layoutBounds(1440, { width: 420, collapsed: true })).toEqual({
      localWidth: 0,
      chatgptX: 0,
      chatgptWidth: 1440,
      previewWidth: 420,
    });
  });

  it('expands only ChatSplice for a collapsed preview', () => {
    const bounds = layoutBounds(1440, { width: 420, collapsed: true }, true);
    expect(bounds).toEqual({
      localWidth: 420,
      chatgptX: 0,
      chatgptWidth: 1440,
      previewWidth: 420,
    });
    expect(bounds.chatgptX).toBe(0);
    expect(bounds.chatgptWidth).toBe(1440);
  });

  it('keeps pinned layout and preview width independent of collapsed state', () => {
    expect(layoutBounds(1440, { width: 900, collapsed: false })).toEqual({
      localWidth: 560,
      chatgptX: 560,
      chatgptWidth: 880,
      previewWidth: 560,
    });
  });

  it('reduces ChatGPT bounds for the selected project panels', () => {
    const bounds = workspacePanelBounds(
      1440,
      856,
      { width: 360, collapsed: false },
      {
        workspace_id: 'ws_0123456789abcdef01234567',
        console_open: true,
        files_open: true,
        files_width: 340,
        console_height: 260,
      },
    );

    expect(bounds).toMatchObject({
      chatgptX: 360,
      chatgptWidth: 740,
      chatgptHeight: 596,
      filesX: 1100,
      filesWidth: FILES_PANEL_DEFAULT_WIDTH,
      filesHeight: 596,
      consoleX: 360,
      consoleY: 596,
      consoleWidth: 1080,
      consoleHeight: CONSOLE_DEFAULT_HEIGHT,
    });
  });

  it('keeps panel surfaces closed when no project is selected', () => {
    expect(
      workspacePanelBounds(
        980,
        596,
        { width: 360, collapsed: false },
        {
          workspace_id: null,
          console_open: true,
          files_open: true,
          files_width: 340,
          console_height: 260,
        },
      ),
    ).toMatchObject({
      chatgptX: 360,
      chatgptWidth: 620,
      chatgptHeight: 596,
      filesWidth: 0,
      consoleHeight: 0,
    });
  });

  it('clamps panel sizes while preserving the ChatGPT minimum rectangle', () => {
    expect(clampFilesPanelWidth(900, 1_080)).toBe(660);
    expect(clampFilesPanelWidth(40, 620)).toBe(200);
    expect(clampConsoleHeight(900, 596)).toBe(356);
    expect(clampConsoleHeight(40, 596)).toBe(160);

    const bounds = workspacePanelBounds(
      1_440,
      856,
      { width: 360, collapsed: false },
      {
        workspace_id: 'ws_0123456789abcdef01234567',
        console_open: true,
        files_open: true,
        files_width: 520,
        console_height: 400,
      },
    );
    expect(bounds.filesWidth).toBe(520);
    expect(bounds.chatgptWidth).toBe(560);
    expect(bounds.consoleHeight).toBe(400);
    expect(bounds.chatgptHeight).toBe(456);
  });
});
