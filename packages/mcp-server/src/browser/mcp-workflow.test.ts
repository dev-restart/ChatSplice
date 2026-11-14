import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  WorkspaceReferenceService,
  WorkspaceService,
} from '@chatsplice/core';
import {
  EXECUTION_CONTRACT_VERSION,
  FsReadResultSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
} from '@chatsplice/protocol';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { startMcpHttpServer } from '../http/server.js';
import { DirectEditActivityStore } from '../mutation/direct-edit-activity-store.js';
import { LocalApplyProposalStore } from '../mutation/local-apply-proposal-store.js';
import { ReferenceRequestStore } from '../mutation/reference-request-store.js';
import { workspaceBindingFor } from '../workspace-binding.js';

// A real local MCP client/server and Chromium; never the running owner daemon.
// The fixtures, authentication token and workspace exist only for this test.
describe.skipIf(process.env.CHATSPLICE_BROWSER_TESTS !== '1')('MCP browser verification', () => {
  it('reads and edits a fixture, verifies it in Chromium and returns failed assertion images over MCP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cs-browser-http-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const pagePath = join(root, 'page.html');
    await writeFile(
      pagePath,
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="heading">Before edit</h1><label for="name">Name</label><input id="name"><button id="save">Save</button><p id="result">Waiting</p><script>document.querySelector("#save").onclick=()=>{setTimeout(()=>{document.querySelector("#result").textContent="Saved: "+document.querySelector("#name").value},100)}</script>',
    );
    const database = join(directory, 'fixture.sqlite');
    const repository = new SqliteWorkspaceRepository(database);
    const settings = new SqliteSettingsRepository(database);
    const workspaces = new WorkspaceService(repository);
    const references = new WorkspaceReferenceService(workspaces, settings);
    const activity = new DirectEditActivityStore();
    const token = randomBytes(32).toString('hex');
    const proposals = new LocalApplyProposalStore(workspaces, token, activity);
    const requests = new ReferenceRequestStore(workspaces, token, activity);
    const client = new Client({ name: 'browser-verification-fixture', version: '1.0.0' });
    let mcp: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
    const app = createServer((_request, response) => {
      void readFile(pagePath)
        .then((body) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(body);
        })
        .catch(() => {
          response.writeHead(500);
          response.end('Fixture unavailable');
        });
    });
    try {
      const workspace = await workspaces.register({ root_path: root });
      const bound = {
        workspace_id: workspace.workspace_id,
        workspace_binding: workspaceBindingFor(token, workspace.workspace_id),
      };
      mcp = await startMcpHttpServer(
        workspaces,
        references,
        token,
        proposals,
        requests,
        activity,
        () => false,
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp.url), {
          requestInit: { headers: { 'x-chatsplice-token': token } },
        }),
      );
      const tools = await client.listTools();
      const execTool = tools.tools.find((tool) => tool.name === 'project.exec');
      expect(JSON.stringify(execTool?.inputSchema)).toContain('"assert"');
      expect(execTool?.description).toContain(EXECUTION_CONTRACT_VERSION);
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: { ...bound, ...args } });
      const original = FsReadResultSchema.parse(
        (await call('fs.read', { path: 'page.html' })).structuredContent,
      );
      expect(original.truncated).toBe(false);
      const edited = await call('fs.edit', {
        path: 'page.html',
        expected_sha256: original.sha256,
        edits: [{ old_text: 'Before edit', new_text: 'After edit' }],
      });
      expect(edited.isError).not.toBe(true);
      const current = FsReadResultSchema.parse(
        (await call('fs.read', { path: 'page.html' })).structuredContent,
      );
      expect(current.content).toContain('After edit');
      expect(current.sha256).not.toBe(original.sha256);
      await new Promise<void>((resolve, reject) => {
        app.once('error', reject);
        app.listen(0, '127.0.0.1', resolve);
      });
      const address = app.address();
      if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
      const url = `http://127.0.0.1:${address.port}/`;
      let sequence = 0;
      async function run(action: Record<string, unknown>) {
        const start = await call('project.exec', {
          request_id: `browser-wire-${++sequence}`,
          operation: { kind: 'browser', action },
          timeout_ms: 10000,
        });
        expect(start.isError).not.toBe(true);
        const submitted = ProjectExecSummarySchema.parse(start.structuredContent);
        for (let i = 0; i < 15; i += 1) {
          const response = await call('project.await_exec', {
            job_id: submitted.job_id,
            timeout_ms: 1000,
          });
          expect(response.isError).not.toBe(true);
          const job = ProjectExecJobSchema.parse(response.structuredContent);
          if (!['queued', 'running', 'cancelling'].includes(job.state)) return { job, response };
        }
        throw new Error('Browser fixture job did not finish');
      }
      expect((await run({ kind: 'open', url })).job.state).toBe('succeeded');
      const heading = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#heading', text: 'After edit', exact: true },
      });
      expect(heading.job.state).toBe('succeeded');
      expect((await run({ kind: 'fill', selector: '#name', value: 'Demo' })).job.state).toBe(
        'succeeded',
      );
      expect((await run({ kind: 'click', selector: '#save' })).job.state).toBe('succeeded');
      const saved = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Saved: Demo', exact: true },
      });
      expect(saved.job.state).toBe('succeeded');
      const failed = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Not the expected result' },
        timeout_ms: 100,
      });
      expect(failed.job.state).toBe('failed');
      expect(failed.job.exit_code).toBe(1);
      expect(failed.job.browser_result?.screenshot_available).toBe(true);
      expect(failed.job.browser_result?.text).toContain('Saved: Demo');
      expect(
        (failed.response.content as Array<{ type: string }>).some((item) => item.type === 'image'),
      ).toBe(true);
      expect(
        (await run({ kind: 'assert', expectation: { kind: 'visible', selector: '#result' } })).job
          .state,
      ).toBe('succeeded');
      const narrow = await run({ kind: 'open', url, width: 390, height: 844 });
      expect(narrow.job.browser_result).toMatchObject({ width: 390, height: 844 });
      expect(narrow.job.state).toBe('succeeded');
      expect((await run({ kind: 'close' })).job.state).toBe('succeeded');
    } finally {
      await client.close();
      await mcp?.close();
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
      settings.close();
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
