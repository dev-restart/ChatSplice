import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectGitInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatSpliceError } from '../errors.js';
import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { runWorkspaceGit } from './run-git.js';

const WORKSPACE_BINDING = `wb_${'0'.repeat(64)}`;

function initRepository(root: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@chatsplice.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'ChatSplice Fixture'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeMarkerExecutable(
  executablePath: string,
  markerPath: string,
  options: { passStdin?: boolean } = {},
): Promise<void> {
  await writeFile(
    executablePath,
    [
      '#!/bin/sh',
      `printf executed > ${shellQuote(markerPath)}`,
      ...(options.passStdin ? ['cat'] : []),
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(executablePath, 0o700);
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('runWorkspaceGit', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-core-git-'));
    workspaceRoot = join(temporaryDirectory, 'workspace');
    await mkdir(workspaceRoot);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: workspaceRoot })).workspace_id;
  });

  afterEach(async () => {
    repository.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('stages and commits a bounded change without touching the network', async () => {
    initRepository(workspaceRoot);
    await writeFile(join(workspaceRoot, 'notes.txt'), 'hello\n', 'utf8');

    const added = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'add', all: true },
      }),
    );
    expect(added).toMatchObject({ command: 'add', exit_code: 0, used_network: false });

    const committed = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'commit', message: 'Add notes' },
      }),
    );
    expect(committed).toMatchObject({ command: 'commit', exit_code: 0 });

    const status = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'status' },
      }),
    );
    expect(status.exit_code).toBe(0);
    expect(status.stdout).not.toContain('notes.txt');
    expect(status.argv).toBe('git status --porcelain=v1 --branch');
  });

  it('marks push, pull, and fetch as network commands', async () => {
    initRepository(workspaceRoot);
    const fetched = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'fetch' },
      }),
    );
    // The command ran bounded and is flagged as a network command regardless of exit code.
    expect(fetched).toMatchObject({ command: 'fetch', used_network: true, timed_out: false });
    expect(fetched.argv).toBe('git fetch');
    expect(typeof fetched.exit_code).toBe('number');
  });

  it('does not execute repository hooks during commit', async () => {
    initRepository(workspaceRoot);
    const hookMarker = join(temporaryDirectory, 'hook-executed');
    const signingMarker = join(temporaryDirectory, 'signing-executed');
    const signingExecutable = join(temporaryDirectory, 'malicious-signer');
    await writeMarkerExecutable(join(workspaceRoot, '.git', 'hooks', 'pre-commit'), hookMarker);
    await writeMarkerExecutable(signingExecutable, signingMarker);
    execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'gpg.program', signingExecutable], { cwd: workspaceRoot });
    await writeFile(join(workspaceRoot, 'notes.txt'), 'hello\n', 'utf8');

    await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'add', all: true },
      }),
    );
    const committed = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'commit', message: 'Hook-safe commit' },
      }),
    );

    expect(committed.exit_code).toBe(0);
    await expectMissing(hookMarker);
    await expectMissing(signingMarker);
  });

  it('does not execute a repository-configured fsmonitor command', async () => {
    initRepository(workspaceRoot);
    const markerPath = join(temporaryDirectory, 'fsmonitor-executed');
    const executablePath = join(temporaryDirectory, 'malicious-fsmonitor');
    await writeMarkerExecutable(executablePath, markerPath);
    execFileSync('git', ['config', 'core.fsmonitor', executablePath], { cwd: workspaceRoot });

    const status = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'status' },
      }),
    );

    expect(status.exit_code).toBe(0);
    await expectMissing(markerPath);
  });

  it('does not execute repository-configured external diff or textconv commands', async () => {
    initRepository(workspaceRoot);
    await writeFile(
      join(workspaceRoot, '.gitattributes'),
      ['*.payload diff=malicious', '*.binary diff=textconverted', ''].join('\n'),
      'utf8',
    );
    await writeFile(join(workspaceRoot, 'sample.payload'), 'before\n', 'utf8');
    await writeFile(join(workspaceRoot, 'sample.binary'), Buffer.from([0, 1, 2]));
    execFileSync('git', ['add', '--all'], { cwd: workspaceRoot });
    execFileSync('git', ['commit', '--quiet', '--message', 'Baseline'], { cwd: workspaceRoot });

    const externalMarker = join(temporaryDirectory, 'external-diff-executed');
    const textconvMarker = join(temporaryDirectory, 'textconv-executed');
    const externalExecutable = join(temporaryDirectory, 'malicious-diff');
    const textconvExecutable = join(temporaryDirectory, 'malicious-textconv');
    await writeMarkerExecutable(externalExecutable, externalMarker);
    await writeMarkerExecutable(textconvExecutable, textconvMarker);
    execFileSync('git', ['config', 'diff.malicious.command', externalExecutable], {
      cwd: workspaceRoot,
    });
    execFileSync('git', ['config', 'diff.textconverted.textconv', textconvExecutable], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, 'sample.payload'), 'after\n', 'utf8');
    await writeFile(join(workspaceRoot, 'sample.binary'), Buffer.from([0, 1, 3]));

    const diff = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'diff', paths: ['sample.payload', 'sample.binary'] },
      }),
    );

    expect(diff.exit_code).toBe(0);
    expect(diff.stdout).toContain('-before');
    expect(diff.stdout).toContain('+after');
    await expectMissing(externalMarker);
    await expectMissing(textconvMarker);
  });

  it('does not execute repository-configured clean or process filters during add', async () => {
    initRepository(workspaceRoot);
    const markerPath = join(temporaryDirectory, 'filter-executed');
    const executablePath = join(temporaryDirectory, 'malicious-filter');
    await writeMarkerExecutable(executablePath, markerPath, { passStdin: true });
    execFileSync('git', ['config', 'filter.malicious.clean', executablePath], {
      cwd: workspaceRoot,
    });
    execFileSync('git', ['config', 'filter.malicious.process', executablePath], {
      cwd: workspaceRoot,
    });
    execFileSync('git', ['config', 'filter.malicious.required', 'true'], {
      cwd: workspaceRoot,
    });
    await writeFile(join(workspaceRoot, '.gitattributes'), '*.payload filter=malicious\n', 'utf8');
    await writeFile(join(workspaceRoot, 'sample.payload'), 'payload\n', 'utf8');

    const added = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'add', all: true },
      }),
    );

    expect(added.exit_code).toBe(0);
    await expectMissing(markerPath);
  });

  it('does not execute a repository-configured external remote helper', async () => {
    initRepository(workspaceRoot);
    const markerPath = join(temporaryDirectory, 'remote-helper-executed');
    const executablePath = join(temporaryDirectory, 'malicious-remote-helper');
    await writeMarkerExecutable(executablePath, markerPath);
    execFileSync('git', ['config', 'remote.malicious.url', `ext::${executablePath}`], {
      cwd: workspaceRoot,
    });
    execFileSync('git', ['config', 'protocol.ext.allow', 'always'], { cwd: workspaceRoot });

    const fetched = await runWorkspaceGit(
      service,
      ProjectGitInputSchema.parse({
        workspace_id: workspaceId,
        workspace_binding: WORKSPACE_BINDING,
        git: { command: 'fetch', remote: 'malicious' },
      }),
    );

    expect(fetched).toMatchObject({ command: 'fetch', used_network: true, timed_out: false });
    expect(fetched.exit_code).not.toBe(0);
    await expectMissing(markerPath);
  });

  it('rejects a workspace that is not a git repository', async () => {
    await expect(
      runWorkspaceGit(
        service,
        ProjectGitInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: WORKSPACE_BINDING,
          git: { command: 'status' },
        }),
      ),
    ).rejects.toBeInstanceOf(ChatSpliceError);
  });
});
