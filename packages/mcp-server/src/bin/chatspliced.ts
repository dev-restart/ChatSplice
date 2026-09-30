#!/usr/bin/env node
import { resolve } from 'node:path';

import { log } from '../logging.js';
import { startChatSpliceRuntime } from '../runtime.js';

interface Arguments {
  readonly dataDirectory: string;
  readonly controlSocketPath: string;
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Required argument ${name} is missing.`);
  }
  return value;
}

function parseArguments(): Arguments {
  return {
    dataDirectory: resolve(argumentValue('--data-dir')),
    controlSocketPath: resolve(argumentValue('--control-socket')),
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  const runtime = await startChatSpliceRuntime(arguments_);

  const stop = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  log('error', 'daemon_start_failed', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
});
