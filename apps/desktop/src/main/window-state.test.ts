import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOW_STATE,
  normalizeWindowState,
  readWindowState,
  writeWindowState,
} from './window-state.js';

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

describe('window state', () => {
  it('restores visible bounds and drops an off-screen position', () => {
    expect(
      normalizeWindowState(
        { bounds: { x: 120, y: 80, width: 1280, height: 760 }, maximized: true },
        [DISPLAY],
      ),
    ).toEqual({
      bounds: { x: 120, y: 80, width: 1280, height: 760 },
      maximized: true,
      fullscreen: false,
    });
    expect(
      normalizeWindowState(
        { bounds: { x: 5000, y: 5000, width: 1280, height: 760 }, fullscreen: true },
        [DISPLAY],
      ).bounds,
    ).toEqual({ width: 1280, height: 760 });
  });

  it('falls back safely for malformed state and writes owner-only JSON', async () => {
    expect(normalizeWindowState('invalid', [DISPLAY])).toEqual(DEFAULT_WINDOW_STATE);
    const directory = await mkdtemp(join(tmpdir(), 'chatsplice-window-'));
    const path = join(directory, 'window-state.json');
    try {
      await writeWindowState(path, DEFAULT_WINDOW_STATE);
      expect(await readWindowState(path, [DISPLAY])).toEqual(DEFAULT_WINDOW_STATE);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(DEFAULT_WINDOW_STATE);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves optional panel sizes while accepting legacy window state', () => {
    expect(
      normalizeWindowState(
        {
          bounds: { width: 1280, height: 760 },
          panel_sizes: { files_width: 520, console_height: 400 },
        },
        [DISPLAY],
      ),
    ).toMatchObject({
      panel_sizes: { files_width: 520, console_height: 400 },
    });
    expect(normalizeWindowState(DEFAULT_WINDOW_STATE, [DISPLAY])).toEqual(DEFAULT_WINDOW_STATE);
  });
});
