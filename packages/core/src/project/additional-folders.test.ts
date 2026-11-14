import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectExecInputSchema } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSettingsRepository } from '../settings/sqlite-repository.js';
import { WorkspaceReferenceService } from '../workspace/reference-service.js';
import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { resolveProjectExecutionAccess } from './execution-access.js';
import { assertExecutionWorkspaceLinks } from './execution-links.js';
import { executeProjectOperation } from './pi-execution.js';
import { shellQuote } from './pi-sandbox.js';
import { nodeRuntimeVersionSupported } from './pi-trusted.js';

describe('execution with additional folders', () => {
  let directory: string;
  let sourceRoot: string;
  let writableRoot: string;
  let readRoot: string;
  let outsideRoot: string;
  let repository: SqliteWorkspaceRepository;
  let settings: SqliteSettingsRepository;
  let workspaces: WorkspaceService;
  let references: WorkspaceReferenceService;
  let sourceId: string;
  let writableId: string;
  let readId: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'cs-added-folders-')));
    sourceRoot = join(directory, 'project');
    writableRoot = join(directory, 'shared-code');
    readRoot = join(directory, 'reference-material');
    outsideRoot = join(directory, 'unapproved');
    await Promise.all([sourceRoot, writableRoot, readRoot, outsideRoot].map((root) => mkdir(root)));
    repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    settings = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    workspaces = new WorkspaceService(repository);
    references = new WorkspaceReferenceService(workspaces, settings);
    sourceId = (await workspaces.register({ root_path: sourceRoot })).workspace_id;
    writableId = (await workspaces.register({ root_path: writableRoot }, 'reference')).workspace_id;
    readId = (await workspaces.register({ root_path: readRoot }, 'reference')).workspace_id;
    references.setAccess({
      source_workspace_id: sourceId,
      reference_workspace_id: writableId,
      access_mode: 'read_write',
    });
    references.add({ source_workspace_id: sourceId, reference_workspace_id: readId });
  });

  afterEach(async () => {
    settings.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  function input(command = 'printf ready', target?: string) {
    return ProjectExecInputSchema.parse({
      workspace_id: sourceId,
      workspace_binding: `wb_${'a'.repeat(64)}`,
      request_id: 'additional-folder-check',
      ...(target === undefined ? {} : { reference_workspace_id: target }),
      operation: { kind: 'shell', command, network: 'local' },
      timeout_ms: 30_000,
    });
  }

  async function run(command: string, target?: string) {
    let output = '';
    const result = await executeProjectOperation(workspaces, input(command, target), {
      referenceService: references,
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    return { ...result, output };
  }

  it('resolves the same exact source and reference modes for every executor', () => {
    const access = resolveProjectExecutionAccess(workspaces, input(), references);
    expect(access.source.workspace_id).toBe(sourceId);
    expect(access.target.workspace_id).toBe(sourceId);
    expect(access.folders.map((folder) => [folder.workspace.rootPath, folder.accessMode])).toEqual(
      expect.arrayContaining([
        [sourceRoot, 'read_write'],
        [writableRoot, 'read_write'],
        [readRoot, 'read_only'],
      ]),
    );
    expect(access.workspaceIds).toHaveLength(3);
    expect(() => resolveProjectExecutionAccess(workspaces, input('pwd', writableId))).toThrow(
      'not configured',
    );
  });

  it('requires explicit write permission for a command cwd in a reference folder', () => {
    expect(() =>
      resolveProjectExecutionAccess(workspaces, input('pwd', readId), references),
    ).toThrow();
    expect(
      resolveProjectExecutionAccess(workspaces, input('pwd', writableId), references).target
        .rootPath,
    ).toBe(writableRoot);
    references.setAccess({
      source_workspace_id: sourceId,
      reference_workspace_id: writableId,
      access_mode: 'read_only',
    });
    expect(() =>
      resolveProjectExecutionAccess(workspaces, input('pwd', writableId), references),
    ).toThrow();
  });

  it('counts hard-link aliases only across writable roots and avoids nested-root double counting', async () => {
    await writeFile(join(sourceRoot, 'shared.txt'), 'internal');
    await link(join(sourceRoot, 'shared.txt'), join(writableRoot, 'shared.txt'));
    await expect(
      assertExecutionWorkspaceLinks([sourceRoot, writableRoot]),
    ).resolves.toBeUndefined();
    await expect(
      assertExecutionWorkspaceLinks([directory, sourceRoot, writableRoot]),
    ).resolves.toBeUndefined();
    await link(join(sourceRoot, 'shared.txt'), join(readRoot, 'readonly-alias.txt'));
    await expect(assertExecutionWorkspaceLinks([sourceRoot, writableRoot])).rejects.toMatchObject({
      code: 'PATH_NOT_FILE',
    });
  });

  const mac = it.skipIf(process.platform !== 'darwin' || !nodeRuntimeVersionSupported());

  mac(
    'reads approved folders and modifies only writable folders through the actual Pi sandbox',
    async () => {
      await writeFile(join(readRoot, 'input.txt'), 'reference text');
      await writeFile(join(outsideRoot, 'private.txt'), 'unapproved text');
      const script = [
        "const fs = require('node:fs');",
        `if (fs.readFileSync(${JSON.stringify(join(readRoot, 'input.txt'))}, 'utf8') !== 'reference text') process.exit(2);`,
        `fs.writeFileSync(${JSON.stringify(join(writableRoot, 'changed.txt'))}, 'updated');`,
        `for (const target of ${JSON.stringify([join(readRoot, 'denied.txt'), join(outsideRoot, 'denied.txt')])}) {`,
        "  try { fs.writeFileSync(target, 'wrong'); process.exit(3); } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }",
        '}',
        `try { fs.readFileSync(${JSON.stringify(join(outsideRoot, 'private.txt'))}); process.exit(4); } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; }`,
        "console.log('FOLDER_SCOPE_OK');",
      ].join('\n');
      const result = await run(`node -e ${shellQuote(script)}`);
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toContain('FOLDER_SCOPE_OK');
      expect(await readFile(join(writableRoot, 'changed.txt'), 'utf8')).toBe('updated');
      await expect(readFile(join(readRoot, 'denied.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(outsideRoot, 'denied.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  mac(
    'runs from the selected additional folder while retaining the main project scope',
    async () => {
      const script = `const fs=require('node:fs'); if(process.cwd()!==${JSON.stringify(writableRoot)}) process.exit(2); fs.writeFileSync('built.txt','built'); fs.writeFileSync(${JSON.stringify(join(sourceRoot, 'main.txt'))},'main');`;
      const result = await run(`node -e ${shellQuote(script)}`, writableId);
      expect(result.exit_code, result.output).toBe(0);
      expect(await readFile(join(writableRoot, 'built.txt'), 'utf8')).toBe('built');
      expect(await readFile(join(sourceRoot, 'main.txt'), 'utf8')).toBe('main');
    },
  );

  mac('uses approved folder roots in structured checks and keeps their secret rules', async () => {
    await writeFile(join(sourceRoot, '.env'), 'fixture secret');
    await writeFile(
      join(writableRoot, 'package.json'),
      JSON.stringify({
        name: 'additional-folder-fixture',
        private: true,
        scripts: { check: 'node check.cjs' },
      }),
    );
    await writeFile(
      join(writableRoot, 'check.cjs'),
      [
        "const fs=require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(join(sourceRoot, 'check-result.txt'))},'checked');`,
        `try { fs.readFileSync(${JSON.stringify(join(sourceRoot, '.env'))}); process.exit(3); } catch(error) { if(!['EPERM','EACCES'].includes(error.code)) throw error; }`,
        "console.log('STRUCTURED_FOLDER_OK');",
      ].join('\n'),
    );
    let output = '';
    const result = await executeProjectOperation(
      workspaces,
      {
        ...input('unused', writableId),
        operation: { kind: 'node_script', script: 'check' },
      },
      {
        referenceService: references,
        onOutput: (chunk) => {
          output += chunk;
        },
      },
    );
    expect(result.exit_code, output).toBe(0);
    expect(output).toContain('STRUCTURED_FOLDER_OK');
    expect(await readFile(join(sourceRoot, 'check-result.txt'), 'utf8')).toBe('checked');
  });
});
