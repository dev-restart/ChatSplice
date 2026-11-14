import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

export function validateReleaseTag(tag, version) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || tag !== `v${version}`)
    throw new Error('Release tag must exactly match the desktop package version.');
}

export async function writeReleaseChecksums(directory, version, signed = false, source = false) {
  const expected = [`ChatSplice-${version}-arm64.dmg`];
  if (signed) expected.push(`ChatSplice-${version}-arm64.zip`, 'latest-mac.yml');
  if (source)
    expected.push(
      `ChatSplice-${version}-source.tar.gz`,
      `ChatSplice-${version}-source.tar.gz.manifest.json`,
      'RELEASE_NOTES.md',
    );
  const entries = await readdir(directory);
  const unexpected = entries.filter(
    (name) =>
      /\.(dmg|zip|yml|tar\.gz|tar\.gz\.manifest\.json)$/.test(name) &&
      !expected.includes(name) &&
      name !== 'builder-debug.yml',
  );
  if (unexpected.length)
    throw new Error('Unexpected release assets; use a clean output directory.');
  const lines = [];
  for (const name of expected) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
      throw new Error('Release assets must be regular files.');
    const bytes = await readFile(path);
    if (bytes.length === 0) throw new Error('Release assets must not be empty.');
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  return [...expected, 'SHA256SUMS.txt'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const desktop = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
  const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (root.version !== desktop.version) throw new Error('Root and desktop versions must match.');
  const tag = process.argv[2];
  validateReleaseTag(tag, desktop.version);
  if (process.argv.includes('--checksums')) {
    const directoryIndex = process.argv.indexOf('--directory');
    const directory =
      directoryIndex < 0 ? 'apps/desktop/release' : process.argv[directoryIndex + 1];
    if (directory === undefined || directory.startsWith('--'))
      throw new Error('--directory requires a path.');
    const paths = await writeReleaseChecksums(
      resolve(directory),
      desktop.version,
      process.argv.includes('--signed'),
      process.argv.includes('--source'),
    );
    console.log(paths.join('\n'));
  } else console.log(`Validated ${tag}`);
}
