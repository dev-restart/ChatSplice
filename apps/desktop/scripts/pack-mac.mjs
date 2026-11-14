import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeDesktopRuntimeManifest } from './write-runtime-identity.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
const builder = join(
  dirname(requireFromDesktop.resolve('electron-builder/package.json')),
  'cli.js',
);
const args = process.argv.slice(2);
const signed = args[0] === '--signed';
if (signed) args.shift();

try {
  execFileSync(process.execPath, [join(desktopRoot, 'scripts/package-daemon.mjs')], {
    cwd: desktopRoot,
    stdio: 'inherit',
  });
  execFileSync(
    process.execPath,
    [
      builder,
      ...(signed ? ['--config', 'electron-builder.signed.cjs', '--mac'] : ['--mac', 'dmg']),
      '--arm64',
      '--publish',
      'never',
      ...args,
    ],
    { cwd: desktopRoot, stdio: 'inherit' },
  );
} finally {
  // The package has copied its bundle identity. Restore the source identity
  // for pnpm start even if packaging fails after writing the bundle manifest.
  await writeDesktopRuntimeManifest();
}
