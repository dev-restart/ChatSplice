#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { URL } from 'node:url';
import process from 'node:process';

const entry = new URL('../dist/bin/chatspliced.js', import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write('ChatSplice is not built. Run pnpm build from the workspace root first.\n');
  process.exitCode = 1;
} else {
  await import(entry.href);
}
