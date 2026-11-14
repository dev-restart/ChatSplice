import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  ProjectRunResultSchema,
  WorkspaceSummarySchema,
  FsReadResultSchema,
} from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { startChatSpliceRuntime } from '../runtime.js';
import { workspaceBindingFor } from '../workspace-binding.js';

function register(socketPath: string, root: string, ownerToken: string): Promise<unknown> {
  const body = JSON.stringify({ root_path: root });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/v1/workspaces',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-chatsplice-control-mutation-token': ownerToken,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('real MCP developer workflow', () => {
  // Run explicitly after provisioning the pinned browser; normal unit CI stays offline.
  it.skipIf(process.env.CHATSPLICE_BROWSER_TESTS !== '1' || process.platform !== 'darwin')(
    'installs tooling, runs a server, edits while running and verifies desktop/mobile pages through MCP',
    async () => {
      const directory = await mkdtemp('/tmp/cs-workflow-');
      const root = join(directory, 'project');
      await mkdir(root);
      await writeFile(
        join(root, 'page.html'),
        '<!doctype html><title>Developer fixture</title><h1>Before edit</h1><input id="name" aria-label="Name"><button id="save">Save</button><p id="status">Waiting</p><script>document.querySelector("#save").onclick=()=>{document.querySelector("#status").textContent="Saved: "+document.querySelector("#name").value};console.error("fixture-console-error")</script>',
      );
      await writeFile(
        join(root, 'server.cjs'),
        "const http=require('node:http');const fs=require('node:fs');const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync('page.html'))});server.listen(0,'127.0.0.1',()=>console.log('READY_URL=http://127.0.0.1:'+server.address().port));",
      );
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'developer-workflow-fixture',
          private: true,
          scripts: {
            check:
              "node -e \"if(!require('node:fs').readFileSync('page.html','utf8').includes('After edit'))process.exit(7)\"",
          },
        }),
      );
      const socket = join(directory, 'control.sock');
      const runtime = await startChatSpliceRuntime({
        dataDirectory: join(directory, 'data'),
        controlSocketPath: socket,
      });
      const client = new Client({ name: 'developer-workflow-test', version: '1.0.0' });
      let serial = 0;
      try {
        const ownerToken = (
          await readFile(join(directory, 'data/run/control-mutation-token'), 'utf8')
        ).trim();
        const workspace = WorkspaceSummarySchema.parse(await register(socket, root, ownerToken));
        const bound = {
          workspace_id: workspace.workspace_id,
          workspace_binding: workspaceBindingFor(runtime.mcpToken, workspace.workspace_id),
        };
        await client.connect(
          new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
            requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
          }),
        );
        async function exec(operation: unknown, timeout = 30_000) {
          const result = await client.callTool({
            name: 'project.exec',
            arguments: {
              ...bound,
              request_id: `workflow-request-${++serial}`,
              operation,
              timeout_ms: timeout,
            },
          });
          expect(result.isError).not.toBe(true);
          return ProjectExecSummarySchema.parse(result.structuredContent);
        }
        async function awaitJob(jobId: string, timeout = 1000) {
          return client.callTool({
            name: 'project.await_exec',
            arguments: { ...bound, job_id: jobId, timeout_ms: timeout },
          });
        }
        async function terminal(jobId: string) {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const result = await awaitJob(jobId);
            const job = ProjectExecJobSchema.parse(result.structuredContent);
            if (!['queued', 'running', 'cancelling'].includes(job.state)) return { job, result };
          }
          throw new Error('The fixture job did not finish.');
        }
        const setup = await terminal(
          (await exec({ kind: 'browser', action: { kind: 'setup' } }, 60_000)).job_id,
        );
        expect(setup.job.state).toBe('succeeded');
        const server = await exec(
          { kind: 'shell', command: 'node server.cjs', background: true, network: 'local' },
          120_000,
        );
        let url: string | undefined;
        for (let attempt = 0; attempt < 50 && url === undefined; attempt += 1) {
          const job = ProjectExecJobSchema.parse(
            (await awaitJob(server.job_id, 0)).structuredContent,
          );
          if (job.state === 'failed') throw new Error(job.message + job.output);
          url = job.output.match(/READY_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (url === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(url).toBeDefined();
        const read = FsReadResultSchema.parse(
          (await client.callTool({ name: 'fs.read', arguments: { ...bound, path: 'page.html' } }))
            .structuredContent,
        );
        const edit = await client.callTool({
          name: 'fs.edit',
          arguments: {
            ...bound,
            path: 'page.html',
            expected_sha256: read.sha256,
            edits: [{ old_text: 'Before edit', new_text: 'After edit' }],
          },
        });
        expect(edit.isError).not.toBe(true);
        const rootCheck = await client.callTool({
          name: 'project.run',
          arguments: { ...bound, task: 'check' },
        });
        expect(rootCheck.isError).not.toBe(true);
        expect(ProjectRunResultSchema.parse(rootCheck.structuredContent)).toMatchObject({
          exit_code: 0,
          timed_out: false,
        });
        const check = await terminal(
          (
            await exec({
              kind: 'shell',
              command:
                "node -e \"if(!require('node:fs').readFileSync('page.html','utf8').includes('After edit'))process.exit(7)\"",
              network: 'local',
            })
          ).job_id,
        );
        expect(check.job.state).toBe('succeeded');
        const opened = await terminal(
          (await exec({ kind: 'browser', action: { kind: 'open', url } })).job_id,
        );
        expect(opened.job.browser_result?.text).toContain('After edit');
        async function captureArtifact(name: string, result: { content?: unknown }): Promise<void> {
          const target = process.env.CHATSPLICE_TEST_ARTIFACT_DIR;
          if (target === undefined) return;
          const image = (result.content as Array<{ type: string; data?: string }>).find(
            (item) => item.type === 'image',
          );
          if (image?.data === undefined) throw new Error('Expected an MCP screenshot artifact.');
          await mkdir(target, { recursive: true });
          await writeFile(join(target, name), Buffer.from(image.data, 'base64'));
        }
        await captureArtifact('desktop.jpg', opened.result);
        expect(opened.job.browser_result?.console).toContain('error: fixture-console-error');
        expect(opened.job.browser_result?.controls.map((control) => control.selector)).toContain(
          '#save',
        );
        expect(
          (opened.result.content as Array<{ type: string }>).some((item) => item.type === 'image'),
        ).toBe(true);
        await terminal(
          (
            await exec({
              kind: 'browser',
              action: { kind: 'fill', selector: '#name', value: 'Alice' },
            })
          ).job_id,
        );
        const clicked = await terminal(
          (await exec({ kind: 'browser', action: { kind: 'click', selector: '#save' } })).job_id,
        );
        expect(clicked.job.browser_result?.text).toContain('Saved: Alice');
        const mobile = await terminal(
          (await exec({ kind: 'browser', action: { kind: 'open', url, width: 360, height: 640 } }))
            .job_id,
        );
        expect(mobile.job.browser_result).toMatchObject({ width: 360, height: 640 });
        await captureArtifact('mobile.jpg', mobile.result);
        await terminal((await exec({ kind: 'browser', action: { kind: 'close' } })).job_id);
        await client.callTool({
          name: 'project.cancel_exec',
          arguments: { ...bound, job_id: server.job_id },
        });
        expect((await terminal(server.job_id)).job.state).toBe('cancelled');
        await expect(fetch(url ?? '')).rejects.toThrow();
      } finally {
        await client.close();
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
