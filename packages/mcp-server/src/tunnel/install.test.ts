import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTunnelClient } from './install.js';

const VERSION = 'v9.9.9';
const ASSET_NAME = `tunnel-client-${VERSION}-darwin-arm64.zip`;

function releasePayload(assets: readonly { name: string; browser_download_url: string }[]) {
  return { tag_name: VERSION, assets };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function buildFixtureZip(): Promise<Buffer> {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'tunnel-client-fixture-'));
  try {
    await writeFile(join(stagingRoot, 'tunnel-client'), '#!/bin/sh\necho fake-tunnel-client\n');
    await writeFile(join(stagingRoot, 'cloudflared'), '#!/bin/sh\necho fake-cloudflared\n');
    const zipPath = join(stagingRoot, ASSET_NAME);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'zip',
        ['-j', zipPath, join(stagingRoot, 'tunnel-client'), join(stagingRoot, 'cloudflared')],
        {
          stdio: 'ignore',
        },
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`zip exited ${code}`)),
      );
    });
    return await readFile(zipPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

describe('installTunnelClient', () => {
  const cleanupDirectories: string[] = [];
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    await Promise.all(
      cleanupDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function tempDataDirectory(): Promise<string> {
    // `installTunnelClient` installs into a directory *sibling to*
    // `dataDirectory`, so each test needs its own isolated parent — a bare
    // `mkdtemp()` result lives directly under the shared system tmpdir and
    // would make every test's install land in the same place.
    const root = await mkdtemp(join(tmpdir(), 'chatsplice-install-test-'));
    cleanupDirectories.push(root);
    return join(root, 'data');
  }

  it('refuses to install on an unsupported platform without making any request', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const dataDirectory = await tempDataDirectory();

    const result = await installTunnelClient(dataDirectory);

    expect(result).toEqual({
      status: 'failed',
      version: null,
      executable_path: null,
      error_code: 'unsupported_platform',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports network_error when the release metadata request fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const dataDirectory = await tempDataDirectory();

    const result = await installTunnelClient(dataDirectory);

    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('network_error');
  });

  it('skips downloading when the exact version is already installed', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const dataDirectory = await tempDataDirectory();
    const installedDirectory = join(dataDirectory, '..', 'tunnel-client', VERSION);
    await mkdir(installedDirectory, { recursive: true });
    const executablePath = join(installedDirectory, 'tunnel-client');
    await writeFile(executablePath, '#!/bin/sh\necho already-here\n', { mode: 0o755 });

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        releasePayload([
          { name: ASSET_NAME, browser_download_url: 'https://example.invalid/asset.zip' },
        ]),
      ),
    );

    const result = await installTunnelClient(dataDirectory);

    expect(result.status).toBe('already_installed');
    expect(result.version).toBe(VERSION);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a download whose bytes do not match the published checksum', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const dataDirectory = await tempDataDirectory();
    const zipBytes = Buffer.from('not the real archive');

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          releasePayload([
            { name: ASSET_NAME, browser_download_url: 'https://example.invalid/asset.zip' },
            { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums.txt' },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(zipBytes), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          `0000000000000000000000000000000000000000000000000000000000000000  ${ASSET_NAME}\n`,
          {
            status: 200,
          },
        ),
      );

    const result = await installTunnelClient(dataDirectory);

    expect(result).toEqual({
      status: 'failed',
      version: null,
      executable_path: null,
      error_code: 'checksum_mismatch',
    });
  });

  it('downloads, verifies, and extracts a checksum-matching release', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const dataDirectory = await tempDataDirectory();
    const zipBytes = await buildFixtureZip();
    const digest = createHash('sha256').update(zipBytes).digest('hex');

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          releasePayload([
            { name: ASSET_NAME, browser_download_url: 'https://example.invalid/asset.zip' },
            { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums.txt' },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(zipBytes), { status: 200 }))
      .mockResolvedValueOnce(new Response(`${digest}  ${ASSET_NAME}\n`, { status: 200 }));

    const result = await installTunnelClient(dataDirectory);

    expect(result.status).toBe('installed');
    expect(result.version).toBe(VERSION);
    expect(result.executable_path).not.toBeNull();
    const installedStat = await stat(result.executable_path!);
    expect(installedStat.mode & 0o111).not.toBe(0);
  });
});
