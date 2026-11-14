import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectInstalledTunnelClient } from './detect.js';

describe('detectInstalledTunnelClient', () => {
  it('falls back to the managed installation when a saved manual path is stale', async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-detect-'));
    const dataDirectory = join(userDataDirectory, 'chatspliced');
    const managedExecutable = join(userDataDirectory, 'tunnel-client', '0.0.11', 'tunnel-client');
    try {
      await mkdir(dirname(managedExecutable), { recursive: true });
      await writeFile(managedExecutable, '#!/bin/sh\nexit 0\n');
      await chmod(managedExecutable, 0o755);
      const canonicalManagedExecutable = await realpath(managedExecutable);

      await expect(
        detectInstalledTunnelClient(dataDirectory, join(userDataDirectory, 'missing-client')),
      ).resolves.toBe(canonicalManagedExecutable);
    } finally {
      await rm(userDataDirectory, { recursive: true, force: true });
    }
  });
});
