import { readFile, rename, writeFile } from 'node:fs/promises';

import type { BaseWindow, Rectangle } from 'electron';

export const DEFAULT_WINDOW_STATE: WindowState = {
  bounds: { width: 1440, height: 900 },
  maximized: false,
  fullscreen: false,
};

const MIN_WIDTH = 980;
const MIN_HEIGHT = 640;
const MAX_DIMENSION = 16_384;
const MIN_VISIBLE_EDGE = 64;

export interface WindowState {
  readonly bounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  };
  readonly maximized: boolean;
  readonly fullscreen: boolean;
  readonly panel_sizes?: {
    readonly files_width?: number;
    readonly console_height?: number;
  };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function intersectsDisplay(bounds: Rectangle, workArea: Rectangle): boolean {
  const horizontal =
    Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const vertical =
    Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
    Math.max(bounds.y, workArea.y);
  return horizontal >= MIN_VISIBLE_EDGE && vertical >= MIN_VISIBLE_EDGE;
}

export function normalizeWindowState(
  value: unknown,
  displayWorkAreas: readonly Rectangle[],
): WindowState {
  if (value === null || typeof value !== 'object') return DEFAULT_WINDOW_STATE;
  const record = value as Record<string, unknown>;
  const rawBounds =
    record.bounds !== null && typeof record.bounds === 'object'
      ? (record.bounds as Record<string, unknown>)
      : {};
  const width = Math.min(
    MAX_DIMENSION,
    Math.max(MIN_WIDTH, finiteInteger(rawBounds.width) ?? DEFAULT_WINDOW_STATE.bounds.width),
  );
  const height = Math.min(
    MAX_DIMENSION,
    Math.max(MIN_HEIGHT, finiteInteger(rawBounds.height) ?? DEFAULT_WINDOW_STATE.bounds.height),
  );
  const x = finiteInteger(rawBounds.x);
  const y = finiteInteger(rawBounds.y);
  const candidate = x === undefined || y === undefined ? undefined : { x, y, width, height };
  const keepPosition =
    candidate !== undefined &&
    displayWorkAreas.some((workArea) => intersectsDisplay(candidate, workArea));

  const rawPanelSizes =
    record.panel_sizes !== null && typeof record.panel_sizes === 'object'
      ? (record.panel_sizes as Record<string, unknown>)
      : undefined;
  const filesWidth = finiteInteger(rawPanelSizes?.files_width);
  const consoleHeight = finiteInteger(rawPanelSizes?.console_height);

  return {
    bounds: {
      ...(keepPosition && x !== undefined && y !== undefined ? { x, y } : {}),
      width,
      height,
    },
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
    ...(rawPanelSizes !== undefined && (filesWidth !== undefined || consoleHeight !== undefined)
      ? {
          panel_sizes: {
            ...(filesWidth !== undefined ? { files_width: filesWidth } : {}),
            ...(consoleHeight !== undefined ? { console_height: consoleHeight } : {}),
          },
        }
      : {}),
  };
}

export async function readWindowState(
  path: string,
  displayWorkAreas: readonly Rectangle[],
): Promise<WindowState> {
  try {
    return normalizeWindowState(JSON.parse(await readFile(path, 'utf8')), displayWorkAreas);
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

export async function writeWindowState(path: string, state: WindowState): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export function captureWindowState(window: BaseWindow): WindowState {
  const bounds = window.getNormalBounds();
  return {
    bounds,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}
