/**
 * electron-builder afterPack hook: copies the pre-bundled daemon into the app
 * resources as <resources>/chatspliced/, where DaemonSupervisor resolves it
 * when app.isPackaged. A hook is used instead of extraResources because
 * electron-builder's default ignore rules silently drop node_modules inside
 * extraResources sources, and the daemon needs its external native binding
 * (better-sqlite3) shipped under node_modules.
 */
import console from 'node:console';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
const electronRoot = dirname(requireFromDesktop.resolve('electron/package.json'));

export default async function afterPack(context) {
  const resourcesDirectory =
    context.packager.platform.name === 'mac'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : join(context.appOutDir, 'resources');
  const target = join(resourcesDirectory, 'chatspliced');
  await cp(join(desktopRoot, 'dist', 'packaged-daemon'), target, { recursive: true });
  const licenses = join(resourcesDirectory, 'licenses');
  await mkdir(licenses, { recursive: true });
  for (const [source, name] of [
    [join(repositoryRoot, 'LICENSE'), 'ChatSplice.LICENSE'],
    [join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
    [join(electronRoot, 'dist', 'LICENSE'), 'Electron.LICENSE'],
    [join(electronRoot, 'dist', 'LICENSES.chromium.html'), 'LICENSES.chromium.html'],
  ]) {
    await cp(source, join(licenses, name));
  }
  console.log(`afterPack: daemon bundle copied to ${target}`);
}
