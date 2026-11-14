import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildOutputs = [
  'apps/desktop/dist',
  'packages/core/dist',
  'packages/mcp-server/dist',
  'packages/protocol/dist',
];

function isNotFound(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function assertNoSymlinkPath(absolutePath, label) {
  const normalizedPath = resolve(absolutePath);
  const parts = normalizedPath.split('/').filter(Boolean);
  let current = normalizedPath.startsWith('/') ? '/' : '';

  for (const part of parts) {
    current = resolve(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to remove path through symbolic-link ${label}: ${current}`);
    }
  }
  return true;
}

const rootExists = await assertNoSymlinkPath(root, 'workspace root');
if (!rootExists) {
  throw new Error(`Workspace root does not exist: ${root}`);
}
const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
  throw new Error(`Refusing to clean from unexpected workspace root: ${root}`);
}
const canonicalRoot = await realpath(root);

for (const relativePath of buildOutputs) {
  const configuredPath = resolve(root, relativePath);
  const exists = await assertNoSymlinkPath(configuredPath, relativePath);
  if (!exists) continue;

  const outputPath = resolve(canonicalRoot, relativePath);
  let stats;
  try {
    stats = await lstat(outputPath);
  } catch (error) {
    if (isNotFound(error)) continue;
    throw error;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to remove unexpected build output path: ${relativePath}`);
  }
  await rm(outputPath, { recursive: true, force: true });
}
