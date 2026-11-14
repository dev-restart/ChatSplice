import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import {
  beginCargoCacheRepair,
  inspectManagedCargoCache,
  prepareManagedCargoCache,
  publishCargoCacheRepair,
} from './cargo-cache.js';

const run = promisify(execFile);

// Explicit network opt-in: ordinary unit runs never download dependencies.
// This uses real Cargo and the cache module, without nesting sandbox-exec.
it.skipIf(process.platform !== 'darwin' || process.env.CHATSPLICE_CARGO_CACHE_NATIVE !== '1')(
  'recovers a missing real crate manifest by fetching and testing in a fresh cache',
  async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'cs-real-cargo-cache-')));
    const workspace = join(temporary, 'workspace');
    const homes = new Set<string>();
    let selection: string | undefined;
    try {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(
        join(workspace, 'Cargo.toml'),
        [
          '[package]',
          'name = "chatsplice_cache_recovery_fixture"',
          'version = "0.1.0"',
          'edition = "2021"',
          '[dependencies]',
          'walkdir = "=2.5.0"',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(workspace, 'src', 'lib.rs'),
        '#[test]\nfn reads_own_directory() { assert!(walkdir::WalkDir::new(".").into_iter().next().unwrap().is_ok()); }\n',
      );
      const initial = await prepareManagedCargoCache(workspace);
      homes.add(initial.cargoHome);
      selection = join(dirname(initial.toolHome), `${basename(initial.toolHome)}.selection.json`);
      const cargo = (home: string, args: string[]) =>
        run('cargo', args, {
          cwd: workspace,
          env: {
            ...process.env,
            CARGO_HOME: home,
            CARGO_INSTALL_ROOT: initial.toolHome,
            CARGO_NET_OFFLINE: 'false',
          },
          timeout: 60_000,
          maxBuffer: 128 * 1024,
        });
      await cargo(initial.cargoHome, ['generate-lockfile']);
      await cargo(initial.cargoHome, ['fetch', '--locked']);
      const lock = await readFile(join(workspace, 'Cargo.lock'), 'utf8');
      const source = join(initial.cargoHome, 'registry', 'src');
      const registries = await readdir(source);
      let brokenManifest: string | undefined;
      for (const registry of registries) {
        const candidate = join(source, registry, 'walkdir-2.5.0', 'Cargo.toml');
        try {
          await readFile(candidate);
          brokenManifest = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      expect(brokenManifest).toBeDefined();
      if (brokenManifest === undefined) throw new Error('Cargo did not extract walkdir.');
      // Damage only this test-owned cache, leaving Cargo's real completion marker.
      await rm(brokenManifest);
      const observed = await inspectManagedCargoCache(workspace);
      expect(
        observed.missingManifests.some((path) => path.endsWith('/walkdir-2.5.0/Cargo.toml')),
      ).toBe(true);

      const repair = await beginCargoCacheRepair(workspace);
      homes.add(repair.cargoHome);
      expect((await prepareManagedCargoCache(workspace)).cargoHome).toBe(initial.cargoHome);
      await cargo(repair.cargoHome, ['fetch', '--locked']);
      await publishCargoCacheRepair(repair, { exitCode: 0, timedOut: false, aborted: false });
      const selected = await prepareManagedCargoCache(workspace);
      expect(selected).toEqual({ cargoHome: repair.cargoHome, toolHome: initial.toolHome });
      expect(await readFile(join(workspace, 'Cargo.lock'), 'utf8')).toBe(lock);
      expect((await inspectManagedCargoCache(workspace)).missingManifests).toEqual([]);
      await expect(readFile(brokenManifest)).rejects.toMatchObject({ code: 'ENOENT' });
      const test = await cargo(selected.cargoHome, ['test', '--locked', '--offline']);
      expect(test.stdout).toContain('test result: ok. 1 passed');
    } finally {
      if (selection !== undefined) await rm(selection, { force: true });
      for (const home of homes) await rm(home, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  },
  180_000,
);
