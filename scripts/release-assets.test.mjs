import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReleaseTag, writeReleaseChecksums } from './release-assets.mjs';

test('a tag cannot publish binaries with a different version or invalid ref', () => {
  validateReleaseTag('v0.0.1', '0.0.1');
  validateReleaseTag('v1.0.0-beta.1', '1.0.0-beta.1');
  for (const tag of ['v0.0.2', 'main', 'v0.0.1;echo secret', 'v0.0.1/path'])
    assert.throws(() => validateReleaseTag(tag, '0.0.1'));
});

test('only the expected unsigned DMG enters the checksum manifest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatsplice-assets-'));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, 'ChatSplice-0.0.1-arm64.dmg'), 'fixture');
  await writeFile(join(dir, 'builder-debug.yml'), 'builder output, never published');
  const files = await writeReleaseChecksums(dir, '0.0.1');
  assert.deepEqual(files, ['ChatSplice-0.0.1-arm64.dmg', 'SHA256SUMS.txt']);
  assert.match(
    await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8'),
    /^[a-f0-9]{64} {2}ChatSplice-0\.0\.1-arm64\.dmg\n$/,
  );
  await assert.rejects(writeReleaseChecksums(dir, '0.0.1', true));
});

test('stale-version assets and symlinks cannot be published', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatsplice-assets-'));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, 'ChatSplice-0.0.2-arm64.dmg'), 'stale');
  await assert.rejects(writeReleaseChecksums(dir, '0.0.1'), /Unexpected/);
  await rm(join(dir, 'ChatSplice-0.0.2-arm64.dmg'));
  await writeFile(join(dir, 'private.txt'), 'private');
  await symlink('private.txt', join(dir, 'ChatSplice-0.0.1-arm64.dmg'));
  await assert.rejects(writeReleaseChecksums(dir, '0.0.1'), /regular/);
});
