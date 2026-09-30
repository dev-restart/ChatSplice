import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const PRODUCT_STATE_PATHS = [
  ['chatspliced', 'chatsplice.sqlite'],
  ['localchatd', 'localchat.sqlite'],
  ['Partitions', 'localchat-chatgpt'],
  ['sidebar-layout.json'],
] as const;

function containsProductState(directory: string): boolean {
  return PRODUCT_STATE_PATHS.some((segments) => existsSync(join(directory, ...segments)));
}

/**
 * Existing LocalChat installations keep using their original owner-only
 * userData directory. This preserves the browser profile, workspace database,
 * and encrypted credential without copying or deleting user data during the
 * public-name migration.
 */
export function resolveCompatibleUserDataPath(
  chatSpliceUserData: string,
  legacyLocalChatUserData: string,
): string {
  if (containsProductState(chatSpliceUserData)) return chatSpliceUserData;
  if (containsProductState(legacyLocalChatUserData)) return legacyLocalChatUserData;
  return chatSpliceUserData;
}

/** Keep an existing daemon database in place; new installations use chatspliced. */
export function resolveCompatibleDaemonDataDirectory(userData: string): string {
  const current = join(userData, 'chatspliced');
  const legacy = join(userData, 'localchatd');
  if (existsSync(current) || !existsSync(legacy)) return current;
  return legacy;
}

export function resolveCompatibleControlSocketPath(
  userData: string,
  daemonDataDirectory: string,
): string {
  const socketName =
    basename(daemonDataDirectory) === 'localchatd' ? 'localchatd.sock' : 'chatspliced.sock';
  return join(userData, 'run', socketName);
}
