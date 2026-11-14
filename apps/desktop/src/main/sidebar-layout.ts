import { PANEL_CONSOLE_HEIGHT_DEFAULT, PANEL_FILES_WIDTH_DEFAULT } from '@chatsplice/protocol';
import type { PanelState, SidebarLayout } from '@chatsplice/protocol';

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 560;
export const DEFAULT_SIDEBAR_WIDTH = 360;
export const MIN_CHATGPT_WIDTH = 420;
export const COLLAPSED_SIDEBAR_WIDTH = 0;
export const MACOS_TITLEBAR_HEIGHT = 44;
export const FILES_PANEL_DEFAULT_WIDTH = PANEL_FILES_WIDTH_DEFAULT;
export const CONSOLE_DEFAULT_HEIGHT = PANEL_CONSOLE_HEIGHT_DEFAULT;
export const FILES_PANEL_MIN_WIDTH = 220;
export const FILES_PANEL_MAX_WIDTH = 720;
export const CONSOLE_MIN_HEIGHT = 160;
export const CONSOLE_MAX_HEIGHT = 560;
export const MIN_CHATGPT_HEIGHT = 240;

export function contentTopInset(isMacOS: boolean): number {
  return isMacOS ? MACOS_TITLEBAR_HEIGHT : 0;
}

export function clampSidebarWidth(width: number, contentWidth: number): number {
  const maxAvailable = Math.max(SIDEBAR_MIN_WIDTH, contentWidth - MIN_CHATGPT_WIDTH);
  return Math.min(SIDEBAR_MAX_WIDTH, maxAvailable, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function clampFilesPanelWidth(width: number, availableWidth: number): number {
  const maxAvailable = Math.max(0, availableWidth - MIN_CHATGPT_WIDTH);
  if (maxAvailable === 0) return 0;
  const minAvailable = Math.min(FILES_PANEL_MIN_WIDTH, maxAvailable);
  return Math.min(FILES_PANEL_MAX_WIDTH, maxAvailable, Math.max(minAvailable, Math.round(width)));
}

export function clampConsoleHeight(height: number, availableHeight: number): number {
  const maxAvailable = Math.max(0, availableHeight - MIN_CHATGPT_HEIGHT);
  if (maxAvailable === 0) return 0;
  const minAvailable = Math.min(CONSOLE_MIN_HEIGHT, maxAvailable);
  return Math.min(CONSOLE_MAX_HEIGHT, maxAvailable, Math.max(minAvailable, Math.round(height)));
}

export function layoutBounds(
  contentWidth: number,
  layout: SidebarLayout,
  preview = false,
): { localWidth: number; chatgptX: number; chatgptWidth: number; previewWidth: number } {
  const splitWidth = layout.collapsed
    ? Math.min(COLLAPSED_SIDEBAR_WIDTH, contentWidth)
    : clampSidebarWidth(layout.width, contentWidth);
  const previewWidth = clampSidebarWidth(layout.width, contentWidth);
  return {
    localWidth: preview && layout.collapsed ? previewWidth : splitWidth,
    chatgptX: splitWidth,
    chatgptWidth: Math.max(0, contentWidth - splitWidth),
    previewWidth,
  };
}

export interface WorkspacePanelBounds {
  readonly chatgptX: number;
  readonly chatgptY: number;
  readonly chatgptWidth: number;
  readonly chatgptHeight: number;
  readonly filesX: number;
  readonly filesY: number;
  readonly filesWidth: number;
  readonly filesHeight: number;
  readonly consoleX: number;
  readonly consoleY: number;
  readonly consoleWidth: number;
  readonly consoleHeight: number;
}

/**
 * Splits the ChatGPT area into app-owned file and execution surfaces while
 * preserving a usable chat rectangle at the window's minimum size.
 */
export function workspacePanelBounds(
  contentWidth: number,
  contentHeight: number,
  sidebar: SidebarLayout,
  panels: PanelState,
  preview = false,
): WorkspacePanelBounds {
  const base = layoutBounds(contentWidth, sidebar, preview);
  const availableWidth = Math.max(0, contentWidth - base.chatgptX);
  const filesWidth =
    panels.files_open && panels.workspace_id !== null
      ? clampFilesPanelWidth(panels.files_width, availableWidth)
      : 0;
  const chatgptWidth = Math.max(0, availableWidth - filesWidth);
  const consoleHeight =
    panels.console_open && panels.workspace_id !== null
      ? clampConsoleHeight(panels.console_height, contentHeight)
      : 0;
  const chatgptHeight = Math.max(0, contentHeight - consoleHeight);

  return {
    chatgptX: base.chatgptX,
    chatgptY: 0,
    chatgptWidth,
    chatgptHeight,
    filesX: base.chatgptX + chatgptWidth,
    filesY: 0,
    filesWidth,
    filesHeight: chatgptHeight,
    consoleX: base.chatgptX,
    consoleY: chatgptHeight,
    consoleWidth: availableWidth,
    consoleHeight,
  };
}
