import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveCompatibleControlSocketPath,
  resolveCompatibleDaemonDataDirectory,
  resolveCompatibleUserDataPath,
} from './brand-compatibility.js';

describe('ChatSplice brand compatibility', () => {
  it('keeps a legacy installation on its existing profile and daemon database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatsplice-brand-'));
    const current = join(root, 'ChatSplice');
    const legacy = join(root, 'LocalChat ADE');
    try {
      await mkdir(join(legacy, 'localchatd'), { recursive: true });
      await writeFile(join(legacy, 'localchatd', 'localchat.sqlite'), 'existing');

      expect(resolveCompatibleUserDataPath(current, legacy)).toBe(legacy);
      expect(resolveCompatibleDaemonDataDirectory(legacy)).toBe(join(legacy, 'localchatd'));
      expect(resolveCompatibleControlSocketPath(legacy, join(legacy, 'localchatd'))).toBe(
        join(legacy, 'run', 'localchatd.sock'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers current ChatSplice state and current paths for new installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatsplice-brand-'));
    const current = join(root, 'ChatSplice');
    const legacy = join(root, 'LocalChat ADE');
    try {
      await mkdir(join(current, 'chatspliced'), { recursive: true });
      await writeFile(join(current, 'chatspliced', 'chatsplice.sqlite'), 'current');
      await mkdir(join(legacy, 'localchatd'), { recursive: true });

      expect(resolveCompatibleUserDataPath(current, legacy)).toBe(current);
      expect(resolveCompatibleDaemonDataDirectory(current)).toBe(join(current, 'chatspliced'));
      expect(resolveCompatibleControlSocketPath(current, join(current, 'chatspliced'))).toBe(
        join(current, 'run', 'chatspliced.sock'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
