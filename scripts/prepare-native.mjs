import { chmod, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export async function prepareNativeTerminal() {
  if (process.platform !== 'darwin') return;
  const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const packageRoot = await realpath(dirname(requireDesktop.resolve('node-pty/package.json')));
  // node-pty 1.1.0's macOS prebuild can arrive without its executable bit.
  // Repair only the two known helper locations in the installed package.
  for (const subpath of [
    `prebuilds/darwin-${process.arch}/spawn-helper`,
    'build/Release/spawn-helper',
  ]) {
    const helper = join(packageRoot, subpath);
    let info;
    try {
      info = await lstat(helper);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const offset = relative(packageRoot, await realpath(helper));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      offset.startsWith(`..${sep}`) ||
      offset === '..'
    ) {
      throw new Error('The installed node-pty helper is not a regular package file.');
    }
    if ((info.mode & 0o777) !== 0o755) await chmod(helper, 0o755);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareNativeTerminal();
