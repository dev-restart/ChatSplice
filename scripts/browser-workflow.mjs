import { spawn } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Installation and tests must share a cache even when project.exec changes HOME.
// No system install, user browser profile, model invocation or sandbox override.
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--install')) {
  console.error('Usage: node scripts/browser-workflow.mjs [--install]');
  process.exitCode = 2;
} else {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/mcp-server');
  const require = createRequire(join(serverRoot, 'package.json'));
  const install = args[0] === '--install';
  const cli = install
    ? join(dirname(require.resolve('playwright/package.json')), 'cli.js')
    : join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const child = spawn(
    process.execPath,
    install
      ? [cli, 'install', 'chromium', '--only-shell']
      : [
          cli,
          'run',
          'src/browser/workflow.test.ts',
          'src/browser/mcp-workflow.test.ts',
          'src/goal/runtime.test.ts',
        ],
    {
      cwd: serverRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: join(
          serverRoot,
          'node_modules',
          '.cache',
          'chatsplice-playwright',
        ),
        PLAYWRIGHT_SKIP_BROWSER_GC: '1',
        CHATSPLICE_BROWSER_TESTS: '1',
      },
    },
  );
  child.once('error', () => {
    console.error('Could not start the browser workflow command. Check local dependencies.');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
