/**
 * Bundles the daemon (chatspliced) into a single CJS file for packaging.
 * better-sqlite3 stays external because it ships a native .node binding; the
 * packaging step copies its module directory next to the bundle so Node's
 * default resolution finds it from resources/chatspliced/node_modules.
 * CJS output is required: bundled dependencies issue dynamic require() calls
 * that esbuild ESM output cannot evaluate, and ELECTRON_RUN_AS_NODE executes
 * extensionless-package .js files as CommonJS by default.
 */
import console from 'node:console';
import { cp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { build } from 'esbuild';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const outputDirectory = join(desktopRoot, 'dist', 'packaged-daemon');

await build({
  entryPoints: [join(repositoryRoot, 'packages', 'mcp-server', 'src', 'bin', 'chatspliced.ts')],
  outfile: join(outputDirectory, 'chatspliced.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // CJS has no import.meta; dependencies (e.g. the execution SDK) read
  // import.meta.url for package-relative paths. Point them at the bundle file
  // so URL-to-path conversion never sees undefined.
  define: { 'import.meta.url': 'chatspliceImportMetaUrl' },
  banner: {
    js: "const chatspliceImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  external: ['better-sqlite3'],
  logLevel: 'warning',
});

// Pin CommonJS resolution for the bundle directory: the desktop package.json
// declares "type": "module", which would otherwise reclassify this .js file
// as ESM in development checkouts (packaged resources default to CJS).
await writeFile(
  join(outputDirectory, 'package.json'),
  JSON.stringify({ name: 'chatspliced-bundle', private: true, type: 'commonjs' }, null, 2) + '\n',
);

const requireFromCore = createRequire(join(repositoryRoot, 'packages', 'core', 'package.json'));
const sqlitePackageJson = requireFromCore.resolve('better-sqlite3/package.json');
const sqliteModuleRoot = dirname(sqlitePackageJson);
const sqliteTarget = join(outputDirectory, 'node_modules', 'better-sqlite3');
// better-sqlite3 has no runtime dependencies (node-addon-api is build-time)
// and self-loads prebuilds/<platform>-<arch>.node; copy only what the
// packaged darwin-arm64 daemon needs.
await cp(join(sqliteModuleRoot, 'package.json'), join(sqliteTarget, 'package.json'));
await cp(join(sqliteModuleRoot, 'lib'), join(sqliteTarget, 'lib'), { recursive: true });
await cp(join(sqliteModuleRoot, 'LICENSE'), join(sqliteTarget, 'LICENSE'));
await cp(
  join(sqliteModuleRoot, 'prebuilds', 'darwin-arm64.node'),
  join(sqliteTarget, 'prebuilds', 'darwin-arm64.node'),
);

console.log(`Packaged daemon bundle written to ${outputDirectory}`);
process.exitCode = 0;
