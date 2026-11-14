import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PYTHON_COMMANDS = ['python', 'python3', 'pip', 'pip3'] as const;
const UNAVAILABLE_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (UNAVAILABLE_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** Prefer project Python without shadowing the explicitly selected Node/Rust toolchain. */
export async function prepareProjectPythonShims(
  runtimeDirectory: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  const commands: Array<{ name: (typeof PYTHON_COMMANDS)[number]; path: string }> = [];
  for (const name of PYTHON_COMMANDS) {
    const path = join(workspaceRoot, '.venv', 'bin', name);
    if (await isExecutableFile(path)) commands.push({ name, path });
  }
  if (commands.length === 0) return undefined;

  const directory = await mkdtemp(join(runtimeDirectory, 'project-python-'));
  try {
    await chmod(directory, 0o700);
    for (const command of commands) {
      const path = join(directory, command.name);
      // Keep the .venv path rather than its realpath: Python uses that location
      // to discover pyvenv.cfg. No host environment values or credentials are copied.
      const wrapper = `#!/bin/sh\nexec ${quoteShellArgument(command.path)} "$@"\n`;
      await writeFile(path, wrapper, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
      await chmod(path, 0o700);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
