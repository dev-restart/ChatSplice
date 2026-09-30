import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.indexOf('--output');
if (outputArg < 0 || !process.argv[outputArg + 1])
  throw new Error('Use --output /absolute/path/source.tar.gz');
const output = resolve(process.argv[outputArg + 1]);
try {
  await lstat(output);
  throw new Error('Output already exists; choose a new archive path.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const directories = new Set(['apps', 'packages', 'docs', 'scripts', '.github']);
const excluded = new Set(['node_modules', 'dist', 'coverage', '.git', '.localchat', '.chatsplice']);
let gitRulesAvailable = false;
try {
  await lstat(join(root, '.git'));
  gitRulesAvailable = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// Apply Git's shared and local rules without embedding the owner's excluded
// document names in the public packaging script.
function ignoredPaths(paths) {
  if (!gitRulesAvailable || paths.length === 0) return new Set();
  const checked = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: root,
    input: `${paths.join('\0')}\0`,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (checked.error) throw checked.error;
  if (checked.status !== 0 && checked.status !== 1)
    throw new Error(`Unable to read source exclusion rules: ${checked.stderr}`);
  return new Set(checked.stdout.split('\0').filter(Boolean));
}

const files = [];
async function collect(relative = '') {
  const entries = (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const ignored = ignoredPaths(
    entries.map((entry) => (relative ? `${relative}/${entry.name}` : entry.name)),
  );
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (ignored.has(name) || name === 'apps/desktop/release') continue;
    if (
      relative === '' &&
      !directories.has(entry.name) &&
      !/^(LICENSE|THIRD_PARTY_NOTICES\.md|[A-Z_]+\.md|package\.json|pnpm-(lock|workspace)\.yaml|tsconfig\.base\.json|eslint\.config\.js|[.]gitignore|[.]npmrc|[.]nvmrc|[.]prettierignore|[.]prettierrc\.json)$/.test(
        entry.name,
      )
    )
      continue;
    if (entry.isSymbolicLink()) throw new Error(`Source package rejects symbolic links: ${name}`);
    if (entry.isDirectory()) {
      await collect(name);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Source package rejects special files: ${name}`);
    if (
      /^(\.env($|\.)|mcp-token$|control-mutation-token$|tunnel-runtime-key\.enc$)|\.(sqlite(-.*)?|db(-.*)?|pem|key|p12|pfx|log)$/i.test(
        entry.name,
      )
    )
      throw new Error(`Private runtime file in source tree: ${name}`);
    if ((await lstat(join(root, name))).size > 10 * 1024 * 1024)
      throw new Error(`Review oversized source file: ${name}`);
    files.push(name);
  }
}
await collect();
const staging = await mkdtemp(join(tmpdir(), 'chatsplice-source-manifest-'));
const list = join(staging, 'files.txt');
// Paths containing line breaks cannot be represented safely in tar's list input.
if (files.some((name) => /[\r\n]/.test(name)))
  throw new Error('Source path contains a line break.');
await writeFile(list, files.join('\n') + '\n', { mode: 0o600 });
execFileSync('/usr/bin/tar', ['-czf', output, '-C', root, '--no-recursion', '-T', list], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const hashes = [];
for (const name of files)
  hashes.push({
    path: name,
    sha256: createHash('sha256')
      .update(await readFile(join(root, name)))
      .digest('hex'),
  });
await writeFile(
  `${output}.manifest.json`,
  JSON.stringify(
    { format: 'chatsplice.source.v1', license_selected: files.includes('LICENSE'), files: hashes },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
console.log(
  `Packed ${files.length} source files. License selected: ${files.includes('LICENSE')}. No publication was performed.`,
);
