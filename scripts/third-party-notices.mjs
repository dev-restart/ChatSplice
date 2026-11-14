import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const inventory = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }),
);
const entries = Object.values(inventory)
  .flat()
  .sort((a, b) => a.name.localeCompare(b.name));
const licenseRoot = new URL('../docs/licenses/', import.meta.url);
const supplemental = JSON.parse(await readFile(new URL('manifest.json', licenseRoot), 'utf8'));
const output = [
  '# Third-party dependency notices',
  '',
  'Generated from the installed lockfile by `pnpm notices`. Includes development dependencies; regenerate after dependency updates. Package paths and local user information are omitted.',
  '',
  'ChatSplice original code is MIT-licensed under the root LICENSE. The pinned Pi SDK is execution tooling only; provider SDK dependencies do not imply model invocation. Separately installed tunnel-client retains its upstream licenses. Packaged apps include the root MIT license, these dependency notices, and Electron LICENSE plus LICENSES.chromium.html under Resources/licenses.',
  '',
];
let missing = 0;
for (const entry of entries) {
  output.push(
    `## ${entry.name} ${entry.versions.join(', ')}`,
    '',
    `Declared license: ${entry.license}`,
    '',
  );
  if (entry.homepage) output.push(`Upstream: ${entry.homepage}`, '');
  const files = [];
  for (const root of entry.paths ?? []) {
    for (const name of (await readdir(root)).sort()) {
      if (!/^(licen[cs]e|copying|notice)([._-]|$)/i.test(name)) continue;
      try {
        const content = await readFile(join(root, name), 'utf8');
        if (content.length <= 2 * 1024 * 1024 && !files.some((item) => item.content === content))
          files.push({ name, content });
      } catch {
        /* Only text files at the package root are copied. */
      }
    }
  }
  if (files.length === 0) {
    for (const version of entry.versions) {
      const record = supplemental.find(
        (item) => item.name === entry.name && item.version === version,
      );
      if (record === undefined) continue;
      if (!/^upstream\/[a-f0-9]{64}\.txt$/.test(record.file))
        throw new Error('Invalid supplemental license path.');
      const content = await readFile(new URL(record.file, licenseRoot), 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== record.sha256)
        throw new Error(`Supplemental license hash mismatch: ${entry.name}`);
      if (!files.some((item) => item.content === content))
        files.push({ name: `Upstream license (${record.source})`, content });
    }
  }
  if (files.length === 0) {
    missing += 1;
    output.push(
      'No root license text supplied by this installed package. Review upstream before redistributing its artifacts.',
      '',
    );
  }
  for (const file of files)
    output.push(`### ${file.name}`, '', '````text', file.content.trimEnd(), '````', '');
}
const destination = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
await writeFile(destination, output.join('\n'));
console.log(`Wrote notices for ${entries.length} packages; ${missing} missing license entries.`);
if (process.argv.includes('--require-complete') && missing > 0) process.exitCode = 1;
