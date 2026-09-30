import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { executablePath } from './detect.js';

const RELEASE_API_URL = 'https://api.github.com/repos/openai/tunnel-client/releases/latest';
const METADATA_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface TunnelClientInstallResult {
  readonly status: 'installed' | 'already_installed' | 'failed';
  readonly version: string | null;
  readonly executable_path: string | null;
  readonly error_code:
    'unsupported_platform' | 'network_error' | 'checksum_mismatch' | 'extraction_failed' | null;
}

interface GithubAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

function targetAssetPlatform(): { platform: string; arch: string } | undefined {
  if (process.platform !== 'darwin') return undefined;
  if (process.arch === 'arm64') return { platform: 'darwin', arch: 'arm64' };
  if (process.arch === 'x64') return { platform: 'darwin', arch: 'amd64' };
  return undefined;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'chatsplice' },
    });
    if (!response.ok) {
      throw new Error(`Request to ${url} failed with status ${response.status}.`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatestRelease(): Promise<{
  version: string;
  assets: readonly GithubAsset[];
}> {
  const response = await fetchWithTimeout(RELEASE_API_URL, METADATA_TIMEOUT_MS);
  const payload = (await response.json()) as {
    tag_name?: unknown;
    assets?: unknown;
  };
  if (typeof payload.tag_name !== 'string' || !Array.isArray(payload.assets)) {
    throw new Error('Unexpected GitHub release response shape.');
  }
  const assets = payload.assets.filter(
    (asset): asset is GithubAsset =>
      typeof asset === 'object' &&
      asset !== null &&
      typeof (asset as GithubAsset).name === 'string' &&
      typeof (asset as GithubAsset).browser_download_url === 'string',
  );
  return { version: payload.tag_name, assets };
}

function matchingChecksum(checksumText: string, assetName: string): string | undefined {
  for (const line of checksumText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [digest, ...rest] = trimmed.split(/\s+/);
    if (rest.join(' ') === assetName) return digest;
  }
  return undefined;
}

function runProcess(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? -1}.`));
    });
  });
}

function failure(
  errorCode: NonNullable<TunnelClientInstallResult['error_code']>,
): TunnelClientInstallResult {
  return { status: 'failed', version: null, executable_path: null, error_code: errorCode };
}

/**
 * Downloads and installs OpenAI's official `tunnel-client` release into the
 * exact location {@link detectInstalledTunnelClient} already scans, so
 * ChatSplice never forks or bundles a third-party binary of its own — it only
 * fetches the bytes OpenAI published for this release and verifies them
 * against OpenAI's own published SHA256SUMS before extracting anything.
 * The Tunnel ID, Organization ID, and runtime API key still have to come
 * from the user's own OpenAI Platform account; that step can't be automated.
 */
export async function installTunnelClient(
  dataDirectory: string,
): Promise<TunnelClientInstallResult> {
  const target = targetAssetPlatform();
  if (target === undefined) return failure('unsupported_platform');

  let release: { version: string; assets: readonly GithubAsset[] };
  try {
    release = await fetchLatestRelease();
  } catch {
    return failure('network_error');
  }

  const assetName = `tunnel-client-${release.version}-${target.platform}-${target.arch}.zip`;
  const installationRoot = join(dirname(dataDirectory), 'tunnel-client');
  const destinationDirectory = join(installationRoot, release.version);
  const destinationExecutable = join(destinationDirectory, 'tunnel-client');

  const alreadyInstalled = await executablePath(destinationExecutable);
  if (alreadyInstalled !== undefined) {
    return {
      status: 'already_installed',
      version: release.version,
      executable_path: alreadyInstalled,
      error_code: null,
    };
  }

  const zipAsset = release.assets.find((asset) => asset.name === assetName);
  const checksumAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt');
  if (zipAsset === undefined || checksumAsset === undefined) return failure('network_error');

  let zipBytes: Buffer;
  let checksumText: string;
  try {
    const [zipResponse, checksumResponse] = await Promise.all([
      fetchWithTimeout(zipAsset.browser_download_url, DOWNLOAD_TIMEOUT_MS),
      fetchWithTimeout(checksumAsset.browser_download_url, METADATA_TIMEOUT_MS),
    ]);
    [zipBytes, checksumText] = await Promise.all([
      zipResponse.arrayBuffer().then((buffer) => Buffer.from(buffer)),
      checksumResponse.text(),
    ]);
  } catch {
    return failure('network_error');
  }

  const expectedDigest = matchingChecksum(checksumText, assetName);
  const actualDigest = createHash('sha256').update(zipBytes).digest('hex');
  if (expectedDigest === undefined || expectedDigest !== actualDigest) {
    return failure('checksum_mismatch');
  }

  const stagingDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tunnel-client-'));
  try {
    const stagedZipPath = join(stagingDirectory, assetName);
    await writeFile(stagedZipPath, zipBytes);
    await mkdir(destinationDirectory, { recursive: true });
    await runProcess('unzip', ['-o', stagedZipPath, '-d', destinationDirectory]);
    await chmod(destinationExecutable, 0o755);
    await chmod(join(destinationDirectory, 'cloudflared'), 0o755).catch(() => undefined);
  } catch {
    await rm(destinationDirectory, { recursive: true, force: true });
    return failure('extraction_failed');
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  const installedPath = await executablePath(destinationExecutable);
  if (installedPath === undefined) return failure('extraction_failed');
  return {
    status: 'installed',
    version: release.version,
    executable_path: installedPath,
    error_code: null,
  };
}
