import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type {
  FsListInput,
  FsListResult,
  FsSearchInput,
  FsSearchMatch,
  FsSearchResult,
} from '@chatsplice/protocol';

import { ChatSpliceError } from '../errors.js';
import { readCheckedFile } from './checked-file.js';
import type { WorkspaceService } from '../workspace/service.js';
import {
  isWorkspacePathDenied,
  resolveExistingWorkspaceFile,
  resolveExistingWorkspacePath,
} from './path-policy.js';

const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_MATCH_LINE_CHARACTERS = 500;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

interface DiscoveredEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
}

function toWorkspacePath(canonicalRoot: string, absolutePath: string): string {
  return relative(canonicalRoot, absolutePath).split(sep).join('/');
}

function normalizeBasePath(inputPath: string): string {
  if (inputPath === '.') return '';
  return inputPath.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function compileGlob(glob: string): RegExp {
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    const next = glob[index + 1];
    if (character === '*' && next === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&') ?? '';
    }
  }
  expression += '$';
  return new RegExp(expression, 'u');
}

async function discoverEntries(
  workspaceService: WorkspaceService,
  workspaceId: string,
  inputPath: string,
  recursive: boolean,
  maxDepth: number,
): Promise<{ entries: DiscoveredEntry[]; truncated: boolean }> {
  const { canonicalRoot, canonicalTarget } = await resolveExistingWorkspacePath(
    workspaceService,
    workspaceId,
    inputPath,
    'filesystem discovery',
  );
  if (canonicalTarget !== resolve(canonicalRoot, inputPath)) {
    throw new ChatSpliceError(
      'PATH_OUTSIDE_WORKSPACE',
      'Filesystem discovery does not follow a symbolic-link start path.',
    );
  }
  const rootStat = await stat(canonicalTarget);
  if (!rootStat.isDirectory()) {
    throw new ChatSpliceError('BAD_REQUEST', 'Filesystem discovery requires a directory path.');
  }

  const entries: DiscoveredEntry[] = [];
  let truncated = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_DISCOVERY_ENTRIES) {
      truncated = true;
      return;
    }
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= MAX_DISCOVERY_ENTRIES) {
        truncated = true;
        return;
      }
      const absolutePath = join(directory, child.name);
      const workspacePath = toWorkspacePath(canonicalRoot, absolutePath);
      if (isWorkspacePathDenied(workspacePath)) continue;

      const type = child.isSymbolicLink()
        ? 'symlink'
        : child.isDirectory()
          ? 'directory'
          : child.isFile()
            ? 'file'
            : undefined;
      if (type === undefined) continue;
      entries.push({ path: workspacePath, type });

      if (
        recursive &&
        type === 'directory' &&
        depth < maxDepth &&
        !DEFAULT_IGNORED_DIRECTORIES.has(child.name)
      ) {
        await visit(absolutePath, depth + 1);
      }
    }
  };

  await visit(canonicalTarget, 1);
  return { entries, truncated };
}

export async function listWorkspacePaths(
  workspaceService: WorkspaceService,
  input: FsListInput,
): Promise<FsListResult> {
  const workspace = workspaceService.getRecord(input.workspace_id);
  const discovered = await discoverEntries(
    workspaceService,
    input.workspace_id,
    input.path,
    input.recursive,
    input.max_depth,
  );
  const basePath = normalizeBasePath(input.path);
  const matcher = compileGlob(input.glob);
  const filtered = discovered.entries.filter((entry) => {
    const relativeToBase = basePath === '' ? entry.path : entry.path.slice(basePath.length + 1);
    return matcher.test(relativeToBase);
  });
  const page = filtered.slice(input.offset, input.offset + input.limit);
  const hasMore = input.offset + page.length < filtered.length;

  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.display_name,
    path: input.path,
    entries: page,
    count: page.length,
    offset: input.offset,
    has_more: hasMore,
    next_offset: hasMore ? input.offset + page.length : null,
    scanned_entries: discovered.entries.length,
    truncated: discovered.truncated,
  };
}

function matchLine(
  line: string,
  query: string,
  caseSensitive: boolean,
): { column: number; excerpt: string } | undefined {
  const searchableLine = caseSensitive ? line : line.toLocaleLowerCase();
  const searchableQuery = caseSensitive ? query : query.toLocaleLowerCase();
  const matchIndex = searchableLine.indexOf(searchableQuery);
  if (matchIndex === -1) return undefined;
  const excerptStart = Math.max(0, matchIndex - 120);
  const excerptEnd = Math.min(line.length, excerptStart + MAX_MATCH_LINE_CHARACTERS);
  return {
    column: matchIndex + 1,
    excerpt: `${excerptStart > 0 ? '…' : ''}${line.slice(excerptStart, excerptEnd)}${excerptEnd < line.length ? '…' : ''}`,
  };
}

async function readSearchableFile(
  workspaceService: WorkspaceService,
  workspaceId: string,
  path: string,
): Promise<{ text: string; bytes: number } | undefined> {
  try {
    const { canonicalRoot, canonicalTarget } = await resolveExistingWorkspaceFile(
      workspaceService,
      workspaceId,
      path,
      'fs.search',
    );
    if (canonicalTarget !== resolve(canonicalRoot, path)) return undefined;
    const { bytes } = await readCheckedFile(canonicalTarget, MAX_SEARCH_FILE_BYTES);
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    return undefined;
  }
}

export async function searchWorkspaceText(
  workspaceService: WorkspaceService,
  input: FsSearchInput,
): Promise<FsSearchResult> {
  const workspace = workspaceService.getRecord(input.workspace_id);
  const discovered = await discoverEntries(
    workspaceService,
    input.workspace_id,
    input.path,
    true,
    input.max_depth,
  );
  const basePath = normalizeBasePath(input.path);
  const matcher = compileGlob(input.glob);
  const matchingCandidates = discovered.entries
    .filter((entry) => entry.type === 'file')
    .filter((entry) => {
      const relativeToBase = basePath === '' ? entry.path : entry.path.slice(basePath.length + 1);
      return matcher.test(relativeToBase);
    });
  const candidates = matchingCandidates.slice(0, MAX_SEARCH_FILES);

  const matches: FsSearchMatch[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let skippedFiles = 0;
  let resourceTruncated = discovered.truncated || matchingCandidates.length > MAX_SEARCH_FILES;
  const requiredMatches = input.offset + input.limit + 1;

  for (const candidate of candidates) {
    if (bytesScanned >= MAX_SEARCH_BYTES || matches.length >= requiredMatches) {
      resourceTruncated ||= bytesScanned >= MAX_SEARCH_BYTES;
      break;
    }
    const source = await readSearchableFile(workspaceService, input.workspace_id, candidate.path);
    if (source === undefined) {
      skippedFiles += 1;
      continue;
    }
    if (bytesScanned + source.bytes > MAX_SEARCH_BYTES) {
      resourceTruncated = true;
      break;
    }
    filesScanned += 1;
    bytesScanned += source.bytes;
    const lines = source.text.replace(/\r\n/gu, '\n').split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const match = matchLine(line, input.query, input.case_sensitive);
      if (match === undefined) continue;
      matches.push({
        path: candidate.path,
        line_number: lineIndex + 1,
        column: match.column,
        line: match.excerpt,
      });
      if (matches.length >= requiredMatches) break;
    }
  }

  const page = matches.slice(input.offset, input.offset + input.limit);
  const hasMore = matches.length > input.offset + page.length;
  return {
    workspace_id: input.workspace_id,
    workspace_name: workspace.display_name,
    path: input.path,
    query: input.query,
    matches: page,
    count: page.length,
    offset: input.offset,
    has_more: hasMore,
    next_offset: hasMore ? input.offset + page.length : null,
    files_scanned: filesScanned,
    bytes_scanned: bytesScanned,
    skipped_files: skippedFiles,
    truncated: resourceTruncated,
  };
}
