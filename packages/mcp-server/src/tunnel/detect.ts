import { constants } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function executablePath(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

export async function detectInstalledTunnelClient(
  dataDirectory: string,
  configuredPath?: string,
): Promise<string | undefined> {
  if (configuredPath !== undefined && configuredPath !== '') {
    const configuredExecutable = await executablePath(configuredPath);
    if (configuredExecutable !== undefined) return configuredExecutable;
  }

  const installationRoot = join(dirname(dataDirectory), 'tunnel-client');
  const versions = await readdir(installationRoot, { withFileTypes: true }).catch(() => []);
  const candidates = versions
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of candidates) {
    const found = await executablePath(join(installationRoot, version, 'tunnel-client'));
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
