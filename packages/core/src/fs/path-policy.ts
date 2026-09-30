import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ChatSpliceError } from '../errors.js';
import type { WorkspaceService } from '../workspace/service.js';

const SECRET_EXACT_NAMES = new Set([
  '.env',
  '.envrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  'id_ed25519',
  'id_rsa',
]);
const SECRET_EXTENSIONS = ['.key', '.p12', '.pem', '.pfx'];

export function isWorkspacePathDenied(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/u).map((segment) => segment.toLowerCase());
  return segments.some(
    (segment) =>
      segment === '.git' ||
      segment === '.ssh' ||
      segment === '.codex' ||
      segment === '.chatsplice' ||
      segment === '.localchat' ||
      segment === '.pi' ||
      SECRET_EXACT_NAMES.has(segment) ||
      segment.startsWith('.env.') ||
      SECRET_EXTENSIONS.some((extension) => segment.endsWith(extension)),
  );
}

export function isWithinOrEqualRoot(rootPath: string, targetPath: string): boolean {
  const offset = relative(rootPath, targetPath);
  return (
    offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
  );
}

export function validateWorkspaceRelativePath(inputPath: string, operation: string): void {
  if (isAbsolute(inputPath) || inputPath.includes('\0')) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      `${operation} accepts only a relative path inside the selected workspace.`,
    );
  }
  const segments = inputPath.split(/[\\/]/u);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'Path traversal and empty path segments are not allowed. Use a normalized relative path.',
    );
  }
  if (isWorkspacePathDenied(inputPath)) {
    throw new ChatSpliceError(
      'SECRET_PATH_DENIED',
      'This path matches the default secret-file policy and cannot be accessed by ChatSplice MCP.',
    );
  }
}

export async function resolveExistingWorkspacePath(
  workspaceService: WorkspaceService,
  workspaceId: string,
  inputPath: string,
  operation: string,
): Promise<{ canonicalRoot: string; canonicalTarget: string }> {
  validateWorkspaceRelativePath(inputPath, operation);
  const workspace = workspaceService.getRecord(workspaceId);
  const canonicalRoot = await realpath(workspace.rootPath);
  if (canonicalRoot !== workspace.rootPath)
    throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'The registered workspace root changed.');
  const requestedPath = resolve(canonicalRoot, inputPath);
  const canonicalTarget = await realpath(requestedPath);
  if (!isWithinOrEqualRoot(canonicalRoot, canonicalTarget)) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'The resolved path escapes the registered workspace, including through a symbolic link.',
    );
  }
  if (isWorkspacePathDenied(relative(canonicalRoot, canonicalTarget))) {
    throw new ChatSpliceError(
      'SECRET_PATH_DENIED',
      'The resolved path is a secret or control path.',
    );
  }
  if (canonicalTarget !== requestedPath) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'Workspace file operations do not follow symbolic links.',
    );
  }
  return { canonicalRoot, canonicalTarget };
}

export const resolveExistingWorkspaceFile = resolveExistingWorkspacePath;

export async function resolveNewWorkspacePath(
  workspaceService: WorkspaceService,
  workspaceId: string,
  inputPath: string,
  operation: string,
): Promise<{ canonicalRoot: string; targetPath: string }> {
  validateWorkspaceRelativePath(inputPath, operation);
  const workspace = workspaceService.getRecord(workspaceId);
  const canonicalRoot = await realpath(workspace.rootPath);
  if (canonicalRoot !== workspace.rootPath)
    throw new ChatSpliceError('PATH_OUTSIDE_WORKSPACE', 'The registered workspace root changed.');
  const requestedPath = resolve(canonicalRoot, inputPath);
  const requestedParent = dirname(requestedPath);
  const canonicalParent = await realpath(requestedParent);
  if (!isWithinOrEqualRoot(canonicalRoot, canonicalParent) || canonicalParent !== requestedParent) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'The destination parent must be an existing real directory inside the registered workspace and may not traverse a symbolic link.',
    );
  }
  const targetPath = join(canonicalParent, basename(requestedPath));
  if (!isWithinOrEqualRoot(canonicalRoot, targetPath)) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'The destination path escapes the registered workspace.',
    );
  }
  return { canonicalRoot, targetPath };
}
