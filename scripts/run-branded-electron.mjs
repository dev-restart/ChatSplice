import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { prepareNativeTerminal } from './prepare-native.mjs';

const PRODUCT_NAME = 'ChatSplice';
const DEV_BUNDLE_IDENTIFIER = 'com.chatsplice.desktop.dev';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  throw new Error(
    'ChatSplice requires Node.js >=22.19 for the Pi SDK. Run nvm use (Node 24), then pnpm dev.',
  );
}

const packageRequire = createRequire(join(process.cwd(), 'package.json'));
const electronPackagePath = packageRequire.resolve('electron/package.json');
const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'));
const electronExecutable = packageRequire('electron');

await prepareNativeTerminal();

function runElectron(executable) {
  const child = spawn(executable, ['.'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHATSPLICE_NODE_BINARY:
        process.env.CHATSPLICE_NODE_BINARY ?? process.env.LOCALCHAT_NODE_BINARY ?? process.execPath,
    },
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`[ChatSplice] Failed to start Electron: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
}

function replacePlistString(plistPath, key, value) {
  const replaced = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath], {
    encoding: 'utf8',
  });
  if (replaced.status === 0) return;

  const inserted = spawnSync('/usr/bin/plutil', ['-insert', key, '-string', value, plistPath], {
    encoding: 'utf8',
  });
  if (inserted.status !== 0) {
    throw new Error(
      `Unable to update ${key} in ${plistPath}: ${inserted.stderr || replaced.stderr}`,
    );
  }
}

if (process.platform !== 'darwin') {
  runElectron(electronExecutable);
} else {
  const sourceApp = resolve(dirname(electronExecutable), '..', '..');
  const cacheDirectory = join(tmpdir(), 'chatsplice-electron', String(electronPackage.version));
  const brandedApp = join(cacheDirectory, `${PRODUCT_NAME}.app`);
  const markerPath = join(cacheDirectory, '.source');
  const sourceMarker = `${sourceApp}\n${electronPackage.version}\nverbatim-symlinks-v1\n`;

  let cachedMarker = '';
  try {
    cachedMarker = await readFile(markerPath, 'utf8');
  } catch {
    // The branded development bundle has not been prepared yet.
  }

  if (cachedMarker !== sourceMarker) {
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    // Framework links must remain relative to the copied bundle for codesign.
    await cp(sourceApp, brandedApp, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });

    const infoPlist = join(brandedApp, 'Contents', 'Info.plist');
    replacePlistString(infoPlist, 'CFBundleName', PRODUCT_NAME);
    replacePlistString(infoPlist, 'CFBundleDisplayName', PRODUCT_NAME);
    replacePlistString(infoPlist, 'CFBundleIdentifier', DEV_BUNDLE_IDENTIFIER);

    const signed = spawnSync(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', brandedApp],
      { encoding: 'utf8' },
    );
    if (signed.status !== 0) {
      throw new Error(`Unable to ad-hoc sign ${brandedApp}: ${signed.stderr}`);
    }

    await writeFile(markerPath, sourceMarker, 'utf8');
  }

  if (process.env.CHATSPLICE_BRANDED_PREPARE_ONLY === '1') {
    console.log(brandedApp);
  } else {
    runElectron(join(brandedApp, 'Contents', 'MacOS', 'Electron'));
  }
}
