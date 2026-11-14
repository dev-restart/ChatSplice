import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';

import { MCP_SERVER_VERSION } from '@chatsplice/protocol';

export interface DesktopRuntimeIdentity {
  readonly status: 'verified' | 'missing' | 'changed' | 'invalid';
  readonly desktop_build_id: string | null;
  readonly expected_daemon_build_id: string | null;
  readonly expected_tool_schema_digest: string | null;
  readonly expected_mcp_descriptor_version: string;
  readonly expected_tool_count: number;
  readonly app_version: string;
}

export interface DesktopArtifactRoot {
  readonly label: string;
  readonly path: string;
}

export interface DesktopRuntimeManifest {
  readonly format: 1;
  readonly desktop_build_id: string;
  readonly expected_daemon_build_id: string;
  readonly expected_tool_schema_digest: string;
  readonly expected_mcp_descriptor_version: string;
  readonly expected_tool_count: number;
  readonly app_version: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
let cachedIdentity: DesktopRuntimeIdentity | undefined;

function readArtifact(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error('Desktop runtime identity encountered an invalid artifact.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Desktop runtime artifact changed while being opened.');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Desktop runtime artifact changed while being read.');
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error('Desktop runtime artifact changed while being read.');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Include compiled main, preload, renderer and protocol bytes, never host paths. */
export function hashDesktopRuntimeArtifacts(roots: readonly DesktopArtifactRoot[]): string {
  if (roots.length === 0 || roots.length > 8) throw new Error('Invalid desktop artifact roots.');
  const labels = roots.map((root) => root.label);
  if (
    new Set(labels).size !== labels.length ||
    labels.some((label) => !/^[a-z0-9_-]{1,64}$/u.test(label))
  ) {
    throw new Error('Desktop artifact labels must be unique and bounded.');
  }
  const hash = createHash('sha256').update('chatsplice-desktop-artifacts-v1\n');
  let entries = 0;
  let files = 0;
  let bytes = 0;
  function visit(root: DesktopArtifactRoot, path: string, depth: number): void {
    if (depth > 12 || ++entries > 8_192)
      throw new Error('Desktop artifact discovery exceeded its limit.');
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Desktop artifacts cannot contain symbolic links.');
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(root, join(path, name), depth + 1);
      return;
    }
    if (!entry.isFile()) throw new Error('Desktop artifacts must be regular files.');
    if (/(?:\.map|\.d\.ts|\.test\.[cm]?js)$/u.test(path)) return;
    if (
      ++files > 2_048 ||
      entry.size > MAX_ARTIFACT_BYTES ||
      bytes + entry.size > MAX_TOTAL_BYTES
    ) {
      throw new Error('Desktop artifact bytes exceeded their limit.');
    }
    const content = readArtifact(path, MAX_ARTIFACT_BYTES);
    const name = relative(root.path, path).split('\\').join('/') || basename(path);
    hash.update(JSON.stringify([root.label, name, content.length])).update('\n');
    hash.update(content).update('\n');
    bytes += content.length;
  }
  for (const root of [...roots].sort((left, right) => left.label.localeCompare(right.label))) {
    const before = files;
    visit(root, root.path, 0);
    if (before === files) throw new Error('Desktop artifact root is empty.');
  }
  return hash.digest('hex');
}

export function desktopArtifactRoots(applicationPath: string): readonly DesktopArtifactRoot[] {
  const requireFromDesktop = createRequire(join(applicationPath, 'package.json'));
  return [
    { label: 'main', path: join(applicationPath, 'dist', 'main') },
    { label: 'preload', path: join(applicationPath, 'dist', 'preload') },
    { label: 'renderer', path: join(applicationPath, 'dist', 'renderer') },
    { label: 'protocol', path: dirname(requireFromDesktop.resolve('@chatsplice/protocol')) },
  ];
}

export function readDesktopRuntimeIdentity(
  applicationPath: string,
  appVersion: string,
  roots: readonly DesktopArtifactRoot[] = desktopArtifactRoots(applicationPath),
): DesktopRuntimeIdentity {
  let desktopBuildId: string | null = null;
  const base = {
    expected_daemon_build_id: null,
    expected_tool_schema_digest: null,
    expected_mcp_descriptor_version: MCP_SERVER_VERSION,
    expected_tool_count: 0,
    app_version: appVersion,
  };
  try {
    desktopBuildId = hashDesktopRuntimeArtifacts(roots);
    const manifestPath = join(applicationPath, 'dist', 'runtime-identity.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readArtifact(manifestPath, 8_192).toString('utf8'));
    } catch (error) {
      const missing =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      return { ...base, desktop_build_id: desktopBuildId, status: missing ? 'missing' : 'invalid' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('Invalid manifest.');
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !==
        'app_version,desktop_build_id,expected_daemon_build_id,expected_mcp_descriptor_version,expected_tool_count,expected_tool_schema_digest,format' ||
      value.format !== 1 ||
      typeof value.desktop_build_id !== 'string' ||
      !HASH_PATTERN.test(value.desktop_build_id) ||
      typeof value.expected_daemon_build_id !== 'string' ||
      !HASH_PATTERN.test(value.expected_daemon_build_id) ||
      typeof value.expected_tool_schema_digest !== 'string' ||
      !HASH_PATTERN.test(value.expected_tool_schema_digest) ||
      value.expected_mcp_descriptor_version !== MCP_SERVER_VERSION ||
      typeof value.expected_tool_count !== 'number' ||
      !Number.isInteger(value.expected_tool_count) ||
      value.expected_tool_count < 1 ||
      value.expected_tool_count > 128 ||
      typeof value.app_version !== 'string' ||
      value.app_version.length < 1 ||
      value.app_version.length > 64
    )
      throw new Error('Invalid manifest.');
    if (value.desktop_build_id !== desktopBuildId || value.app_version !== appVersion) {
      return { ...base, desktop_build_id: desktopBuildId, status: 'changed' };
    }
    return {
      status: 'verified',
      desktop_build_id: desktopBuildId,
      expected_daemon_build_id: value.expected_daemon_build_id,
      expected_tool_schema_digest: value.expected_tool_schema_digest,
      expected_mcp_descriptor_version: value.expected_mcp_descriptor_version,
      expected_tool_count: value.expected_tool_count,
      app_version: value.app_version,
    };
  } catch {
    return { ...base, desktop_build_id: desktopBuildId, status: 'invalid' };
  }
}

/** Freeze startup identity; rebuilding files cannot relabel the process already running. */
export function initializeDesktopRuntimeIdentity(
  applicationPath: string,
  appVersion: string,
): void {
  cachedIdentity ??= Object.freeze(readDesktopRuntimeIdentity(applicationPath, appVersion));
}

export function getDesktopRuntimeIdentity(): DesktopRuntimeIdentity | undefined {
  return cachedIdentity;
}
