import { spawn } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projects = ['packages/protocol', 'packages/core', 'packages/mcp-server', 'apps/desktop'];
const rootFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc.json',
  '.prettierignore',
  'LICENSE',
];
const projectDirectories = new Set(['src', 'scripts', 'resources', 'bin', 'test']);
const maxFiles = 5000;
const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 128 * 1024 * 1024;

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkedBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxFileBytes) {
      throw new Error('Build input is not a bounded regular file: ' + relative(root, path));
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length > maxFileBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Build input changed while being copied: ' + relative(root, path));
    }
    return { bytes, mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function snapshot(destination) {
  const records = [];
  let totalBytes = 0;
  async function visit(path, depth = 0) {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || depth > 64) {
      throw new Error('Build inputs must not contain symbolic links or excessive depth: ' + path);
    }
    if (info.isDirectory()) {
      if (destination !== undefined) await mkdir(join(destination, path), { recursive: true });
      for (const name of (await readdir(absolute)).sort()) {
        if (
          name === '.env' ||
          name.startsWith('.env.') ||
          name === '.npmrc' ||
          name === '.pypirc' ||
          /\.(pem|key|p12|pfx)$/i.test(name)
        ) {
          throw new Error('Secret configuration is not a build input: ' + path + '/' + name);
        }
        await visit(join(path, name), depth + 1);
      }
      return;
    }
    const { bytes, mode } = await checkedBytes(absolute);
    totalBytes += bytes.length;
    if (records.length >= maxFiles || totalBytes > maxTotalBytes) {
      throw new Error('Build source snapshot exceeded its bounded size.');
    }
    records.push({ path, sha256: digest(bytes), bytes: bytes.length, mode });
    if (destination !== undefined) {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await writeFile(join(destination, path), bytes, { flag: 'wx', mode });
    }
  }
  for (const path of rootFiles) await visit(path);
  await visit('scripts');
  for (const project of projects) {
    for (const entry of (await readdir(join(root, project), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        (entry.isDirectory() && projectDirectories.has(entry.name)) ||
        (entry.isFile() &&
          (entry.name === 'package.json' ||
            /^tsconfig.*\.json$/.test(entry.name) ||
            /^(vite|vitest)\.config\.[cm]?[jt]s$/.test(entry.name) ||
            /^electron-builder\./.test(entry.name)))
      ) {
        await visit(join(project, entry.name));
      }
    }
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return {
    source_sha256: digest(JSON.stringify(records)),
    files: records.length,
    bytes: totalBytes,
  };
}

// Reuse installed third-party dependencies, but resolve every workspace package
// to the candidate. Linking the entire original node_modules would load old dist.
async function linkDependencies(destination, project = '') {
  const sourceModules = join(root, project, 'node_modules');
  const targetModules = join(destination, project, 'node_modules');
  await mkdir(targetModules, { recursive: true });
  for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
    if (entry.name === '.cache' || entry.name === '@chatsplice') continue;
    await symlink(join(sourceModules, entry.name), join(targetModules, entry.name));
  }
  const scope = join(targetModules, '@chatsplice');
  await mkdir(scope, { recursive: true });
  for (const workspace of projects) {
    const { bytes } = await checkedBytes(join(root, workspace, 'package.json'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (!/^@chatsplice\/[a-z-]+$/.test(manifest.name)) {
      throw new Error('Unexpected workspace package name.');
    }
    await symlink(join(destination, workspace), join(scope, manifest.name.split('/')[1]));
  }
}

async function build(destination) {
  await new Promise((resolveBuild, reject) => {
    const child = spawn('pnpm', ['build'], {
      cwd: destination,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else reject(new Error('Candidate build failed: ' + (signal ?? code)));
    });
  });
}

if (await exists(join(root, 'runtime-candidate.json'))) {
  throw new Error('Build a new candidate from the original source checkout.');
}
const cache = join(root, 'node_modules', '.cache');
await mkdir(cache, { recursive: true });
if ((await realpath(cache)) !== cache)
  throw new Error('Candidate cache must be inside this checkout.');
const candidate = await mkdtemp(join(cache, 'chatsplice-runtime-'));
console.log('Preparing runtime candidate: ' + candidate);
const source = await snapshot(candidate);
await linkDependencies(candidate);
for (const project of projects) await linkDependencies(candidate, project);
await build(candidate);
const current = await snapshot();
if (current.source_sha256 !== source.source_sha256) {
  throw new Error(
    'Sources changed during the build. This candidate is not marked ready; rebuild after edits finish.',
  );
}
const { bytes } = await checkedBytes(join(candidate, 'apps/desktop/dist/runtime-identity.json'));
const identity = JSON.parse(bytes.toString('utf8'));
if (
  identity.format !== 1 ||
  !/^[a-f0-9]{64}$/.test(identity.desktop_build_id) ||
  !/^[a-f0-9]{64}$/.test(identity.expected_daemon_build_id)
) {
  throw new Error('Candidate runtime identity is incomplete.');
}
const result = {
  format: 1,
  built_at: new Date().toISOString(),
  ...source,
  desktop_build_id: identity.desktop_build_id,
  daemon_build_id: identity.expected_daemon_build_id,
  tool_schema_digest: identity.expected_tool_schema_digest,
  mcp_descriptor_version: identity.expected_mcp_descriptor_version,
  tool_count: identity.expected_tool_count,
  dependencies:
    'Linked to the original checkout; this is a local runtime, not a distributable package.',
};
await writeFile(join(candidate, 'runtime-candidate.json'), JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    state: 'built',
    candidate,
    ...result,
    next:
      'Finish ongoing work and normally quit the current app/daemon, then run pnpm --dir ' +
      JSON.stringify(candidate) +
      ' start. This build does not restart an active application.',
  }),
);
