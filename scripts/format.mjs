import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['--write', '--check'].includes(mode) || process.argv.length !== 3)
  throw new Error('Use format.mjs --write or --check.');

const require = createRequire(join(root, 'package.json'));
const prettierPackagePath = require.resolve('prettier/package.json');
const prettierPackage = JSON.parse(await readFile(prettierPackagePath, 'utf8'));
const prettierBin = join(dirname(prettierPackagePath), prettierPackage.bin);

function gitPaths(args, input) {
  const result = spawnSync('git', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(args[0] === 'check-ignore' && result.status === 1))
    throw new Error(`Unable to read formatting candidates: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

let gitRulesAvailable = false;
try {
  await lstat(join(root, '.git'));
  gitRulesAvailable = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let files = ['.'];
if (gitRulesAvailable) {
  const candidates = gitPaths(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const ignored = new Set(
    candidates.length === 0
      ? []
      : gitPaths(['check-ignore', '--no-index', '-z', '--stdin'], `${candidates.join('\0')}\0`),
  );
  files = [];
  for (const path of new Set(candidates)) {
    if (ignored.has(path)) continue;
    try {
      if ((await lstat(join(root, path))).isFile()) files.push(resolve(root, path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

if (files.length === 0) {
  console.log('No public files to format.');
} else {
  const args = [prettierBin, mode, '--ignore-unknown'];
  for (const ignoreFile of ['.gitignore', '.prettierignore'])
    args.push('--ignore-path', join(root, ignoreFile));
  // Keep argv bounded for large repositories while preserving exact paths.
  for (let offset = 0; offset < files.length; offset += 200) {
    const result = spawnSync(
      process.execPath,
      [...args, '--', ...files.slice(offset, offset + 200)],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
