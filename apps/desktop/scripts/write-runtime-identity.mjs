import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  desktopArtifactRoots,
  hashDesktopRuntimeArtifacts,
} from '../dist/main/runtime-identity.js';
import { hashRuntimeCodePaths } from '../../../packages/mcp-server/dist/runtime-identity.js';
import { getMcpToolCatalogIdentity } from '../../../packages/mcp-server/dist/mcp/tool-catalog.js';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');

export async function writeDesktopRuntimeManifest(daemonBundlePath) {
  const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const requireFromMcp = createRequire(join(repositoryRoot, 'packages/mcp-server/package.json'));
  const daemonRoots =
    daemonBundlePath === undefined
      ? [
          { label: 'mcp-server', path: join(repositoryRoot, 'packages/mcp-server/dist') },
          { label: 'core', path: dirname(requireFromMcp.resolve('@chatsplice/core')) },
          { label: 'protocol', path: dirname(requireFromMcp.resolve('@chatsplice/protocol')) },
        ]
      : [{ label: 'daemon-bundle', path: daemonBundlePath }];
  const catalog = await getMcpToolCatalogIdentity();
  const manifest = {
    format: 1,
    desktop_build_id: hashDesktopRuntimeArtifacts(desktopArtifactRoots(desktopRoot)),
    expected_daemon_build_id: hashRuntimeCodePaths(daemonRoots),
    expected_tool_schema_digest: catalog.tool_schema_digest,
    expected_mcp_descriptor_version: catalog.mcp_descriptor_version,
    expected_tool_count: catalog.tool_count,
    app_version: packageJson.version,
  };
  await writeFile(
    join(desktopRoot, 'dist/runtime-identity.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log('Desktop runtime identity manifest written.');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeDesktopRuntimeManifest();
}
