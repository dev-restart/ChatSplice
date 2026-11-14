import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export async function ensureMcpToken(tokenPath: string): Promise<string> {
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (!TOKEN_PATTERN.test(existing)) {
      throw new Error('Stored MCP token has an invalid format.');
    }
    await chmod(tokenPath, 0o600);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const created = randomBytes(32).toString('hex');
  await writeFile(tokenPath, `${created}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return created;
}
