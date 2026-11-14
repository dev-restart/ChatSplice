import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_SERVER_VERSION } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashDesktopRuntimeArtifacts, readDesktopRuntimeIdentity } from './runtime-identity.js';

describe('desktop runtime identity', () => {
  let directory: string;
  let main: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chatsplice-desktop-identity-'));
    main = join(directory, 'dist/main');
    await mkdir(main, { recursive: true });
    await writeFile(join(main, 'index.js'), 'export const version = 1;');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const roots = (path: string) => [{ label: 'main', path }];
  async function saveManifest(patch: Record<string, unknown> = {}) {
    await writeFile(
      join(directory, 'dist/runtime-identity.json'),
      JSON.stringify({
        format: 1,
        desktop_build_id: hashDesktopRuntimeArtifacts(roots(main)),
        expected_daemon_build_id: 'a'.repeat(64),
        expected_tool_schema_digest: 'b'.repeat(64),
        expected_mcp_descriptor_version: MCP_SERVER_VERSION,
        expected_tool_count: 24,
        app_version: '0.0.2',
        ...patch,
      }),
    );
  }
  it('verifies the metadata against actual compiled bytes and rejects a stale desktop build', async () => {
    await saveManifest();
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main))).toMatchObject({
      status: 'verified',
      expected_daemon_build_id: 'a'.repeat(64),
    });
    await writeFile(join(main, 'index.js'), 'export const version = 2;');
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main))).toMatchObject({
      status: 'changed',
      expected_daemon_build_id: null,
      expected_tool_schema_digest: null,
    });
  });
  it('distinguishes missing, malformed and wrong-version manifests without trusting their expectations', async () => {
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main)).status).toBe('missing');
    await saveManifest({ expected_daemon_build_id: 'not-a-digest' });
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main)).status).toBe('invalid');
    await saveManifest();
    expect(readDesktopRuntimeIdentity(directory, '0.0.3', roots(main)).status).toBe('changed');
    await saveManifest({ credential: 'must-not-be-returned' });
    expect(
      JSON.stringify(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main))),
    ).not.toContain('must-not-be-returned');
  });
  it('uses deployment-independent names while including renderer content and excluding debug artifacts', async () => {
    const other = join(directory, 'other');
    await mkdir(other);
    await writeFile(join(other, 'index.js'), 'export const version = 1;');
    expect(hashDesktopRuntimeArtifacts(roots(main))).toBe(
      hashDesktopRuntimeArtifacts(roots(other)),
    );
    const original = hashDesktopRuntimeArtifacts(roots(main));
    await writeFile(join(main, 'index.js.map'), 'debug');
    await writeFile(join(main, 'index.d.ts'), 'types');
    expect(hashDesktopRuntimeArtifacts(roots(main))).toBe(original);
    await writeFile(join(main, 'index.css'), 'body { color: red }');
    expect(hashDesktopRuntimeArtifacts(roots(main))).not.toBe(original);
  });
  it('rejects linked artifacts and oversized identity metadata', async () => {
    await writeFile(join(directory, 'dist/runtime-identity.json'), 'x'.repeat(8_193));
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main)).status).toBe('invalid');
    await symlink(join(main, 'index.js'), join(main, 'alias.js'));
    expect(() => hashDesktopRuntimeArtifacts(roots(main))).toThrow('symbolic links');
    expect(readDesktopRuntimeIdentity(directory, '0.0.2', roots(main)).status).toBe('invalid');
  });
});
