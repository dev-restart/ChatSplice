import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  FsReadResultSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  WorkspaceSummarySchema,
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

describe('real multi-project MCP workflow', () => {
  it.skipIf(process.env.CHATSPLICE_BROWSER_TESTS !== '1' || process.platform !== 'darwin')(
    'runs twelve servers and isolated browsers alongside eight foreground jobs, edits and cancellation',
    async () => {
      const directory = await mkdtemp('/tmp/cs-multi-flow-');
      const socket = join(directory, 'control.sock');
      const runtime = await startChatSpliceRuntime({
        dataDirectory: join(directory, 'data'),
        controlSocketPath: socket,
      });
      const client = new Client({ name: 'multi-project-workflow', version: '1.0.0' });
      const evidence: Record<string, unknown> = {};
      try {
        const ownerToken = (
          await readFile(join(directory, 'data/run/control-mutation-token'), 'utf8')
        ).trim();
        await client.connect(
          new StreamableHTTPClientTransport(new URL(runtime.mcpUrl), {
            requestInit: { headers: { 'x-chatsplice-token': runtime.mcpToken } },
          }),
        );
        const projects = [];
        for (let index = 0; index < 12; index += 1) {
          const root = join(directory, `project-${index}`);
          await mkdir(root);
          await writeFile(
            join(root, 'page.html'),
            `<!doctype html><meta name="viewport" content="width=device-width"><title>Project ${index}</title><style>body{font:18px system-ui;margin:32px;max-width:640px}input,button{font:inherit;padding:8px}h1{color:#226753}</style><h1>Before edit ${index}</h1><label>Name <input id="name"></label><button id="save">Save</button><p id="status"></p><script>const state=document.querySelector('#status');state.textContent=localStorage.getItem('name')||'Empty';document.querySelector('#save').onclick=()=>{const name=document.querySelector('#name').value;localStorage.setItem('name',name);state.textContent=name};</script>`,
          );
          await writeFile(
            join(root, 'server.cjs'),
            "const http=require('node:http'),fs=require('node:fs');const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync('page.html'))});server.listen(0,'127.0.0.1',()=>console.log('READY_URL=http://127.0.0.1:'+server.address().port));",
          );
          await writeFile(
            join(root, 'hook.cjs'),
            "require('node:fs').writeFileSync('installed.txt','hook-ran')",
          );
          await writeFile(
            join(root, 'check.cjs'),
            "const fs=require('node:fs');if(fs.readFileSync('installed.txt','utf8')!=='hook-ran'||!fs.readFileSync('page.html','utf8').includes('After edit'))process.exit(7);console.log('CHECK_OK')",
          );
          await writeFile(
            join(root, 'gate.cjs'),
            "const fs=require('node:fs');console.log('GATE_READY');const poll=setInterval(()=>{if(fs.existsSync('.release')){clearInterval(poll);console.log('GATE_DONE')}},50)",
          );
          await writeFile(
            join(root, 'package.json'),
            JSON.stringify({
              name: `project-${index}`,
              version: '1.0.0',
              private: true,
              scripts: { postinstall: 'node hook.cjs', check: 'node check.cjs' },
            }),
          );
          const registered = WorkspaceSummarySchema.parse(await register(socket, root, ownerToken));
          projects.push({
            root,
            bound: {
              workspace_id: registered.workspace_id,
              workspace_binding: workspaceBindingFor(runtime.mcpToken, registered.workspace_id),
            },
          });
        }
        type Project = (typeof projects)[number];
        async function exec(project: Project, id: string, operation: unknown) {
          const result = await client.callTool({
            name: 'project.exec',
            arguments: {
              ...project.bound,
              request_id: id,
              operation,
              timeout_ms: 120_000,
            },
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          return ProjectExecSummarySchema.parse(result.structuredContent);
        }
        async function get(project: Project, jobId: string, wait = 0) {
          const result = await client.callTool({
            name: 'project.await_exec',
            arguments: {
              ...project.bound,
              job_id: jobId,
              timeout_ms: wait,
            },
          });
          expect(result.isError).not.toBe(true);
          return { job: ProjectExecJobSchema.parse(result.structuredContent), result };
        }
        async function terminal(project: Project, jobId: string) {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const result = await get(project, jobId, 1000);
            if (!['queued', 'running', 'cancelling'].includes(result.job.state)) return result;
          }
          throw new Error('Multi-project job did not finish.');
        }
        async function successful(project: Project, id: string, operation: unknown) {
          const result = await terminal(project, (await exec(project, id, operation)).job_id);
          expect(result.job.state, result.job.message + result.job.output).toBe('succeeded');
          return result;
        }
        const installs = await Promise.all(
          projects.map((project) =>
            successful(project, 'install-shared-id', {
              kind: 'shell',
              command: 'npm install --offline --no-audit --no-fund',
              network: 'local',
            }),
          ),
        );
        expect(installs).toHaveLength(12);
        for (const project of projects)
          expect(await readFile(join(project.root, 'installed.txt'), 'utf8')).toBe('hook-ran');
        evidence.installs = 12;
        const servers = await Promise.all(
          projects.map((project) =>
            exec(project, 'server-shared-id', {
              kind: 'shell',
              command: 'node server.cjs',
              background: true,
              network: 'local',
            }),
          ),
        );
        const urls: string[] = [];
        for (const [index, project] of projects.entries()) {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const { job } = await get(project, servers[index]!.job_id);
            expect(['queued', 'running']).toContain(job.state);
            const url = job.output.match(/READY_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
            if (url !== undefined) {
              urls[index] = url;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(urls[index]).toBeDefined();
        }
        expect(
          servers.every(
            (server) =>
              runtime.status().execution_jobs.find((job) => job.job_id === server.job_id)?.state ===
              'running',
          ),
        ).toBe(true);
        evidence.concurrent_servers = 12;
        const gates = await Promise.all(
          projects.map((project) =>
            exec(project, 'gate-shared-id', {
              kind: 'shell',
              command: 'node gate.cjs',
              network: 'local',
            }),
          ),
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            runtime
              .status()
              .execution_jobs.filter(
                (job) =>
                  gates.some((gate) => gate.job_id === job.job_id) && job.state === 'running',
              ).length === 8
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const gateStates = await Promise.all(
          projects.map((project, index) => get(project, gates[index]!.job_id)),
        );
        expect(gateStates.filter(({ job }) => job.state === 'running')).toHaveLength(8);
        expect(gateStates.filter(({ job }) => job.state === 'queued')).toHaveLength(4);
        evidence.concurrent_foreground = 8;
        evidence.queued_foreground = 4;
        const runningIndex = gateStates.findIndex(({ job }) => job.state === 'running');
        const queuedIds = gateStates
          .filter(({ job }) => job.state === 'queued')
          .map(({ job }) => job.job_id);
        await writeFile(join(projects[runningIndex]!.root, '.release'), 'go');
        expect(
          (await terminal(projects[runningIndex]!, gates[runningIndex]!.job_id)).job.state,
        ).toBe('succeeded');
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            runtime
              .status()
              .execution_jobs.some(
                (job) => queuedIds.includes(job.job_id) && job.state === 'running',
              )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(
          runtime
            .status()
            .execution_jobs.some(
              (job) => queuedIds.includes(job.job_id) && job.state === 'running',
            ),
        ).toBe(true);
        evidence.queue_resumed = true;
        await Promise.all(
          projects.map((project) => writeFile(join(project.root, '.release'), 'go')),
        );
        for (const [index, project] of projects.entries())
          expect((await terminal(project, gates[index]!.job_id)).job.state).toBe('succeeded');
        await Promise.all(
          projects.map(async (project, index) => {
            const before = FsReadResultSchema.parse(
              (
                await client.callTool({
                  name: 'fs.read',
                  arguments: { ...project.bound, path: 'page.html' },
                })
              ).structuredContent,
            );
            const edited = await client.callTool({
              name: 'fs.edit',
              arguments: {
                ...project.bound,
                path: 'page.html',
                expected_sha256: before.sha256,
                edits: [{ old_text: `Before edit ${index}`, new_text: `After edit ${index}` }],
              },
            });
            expect(edited.isError).not.toBe(true);
            const after = FsReadResultSchema.parse(
              (
                await client.callTool({
                  name: 'fs.read',
                  arguments: { ...project.bound, path: 'page.html' },
                })
              ).structuredContent,
            );
            expect(after.sha256).not.toBe(before.sha256);
            await successful(project, 'check-shared-id', {
              kind: 'shell',
              command: 'npm run check',
              network: 'local',
            });
          }),
        );
        evidence.edits_and_checks = 12;
        const pages = await Promise.all(
          projects.map((project, index) =>
            successful(project, 'open-shared-id', {
              kind: 'browser',
              action: { kind: 'open', url: urls[index] },
            }),
          ),
        );
        for (const [index, page] of pages.entries()) {
          expect(page.job.browser_result?.title).toBe(`Project ${index}`);
          expect(page.job.browser_result?.text).toContain(`After edit ${index}`);
          expect(page.job.browser_result?.controls.map((item) => item.selector)).toContain('#save');
          expect(
            page.job.browser_result?.console.filter((message) =>
              /^(error:|pageerror:|requestfailed:)/.test(message),
            ),
          ).toEqual([]);
        }
        evidence.isolated_browser_sessions = 12;
        // All contexts visit the SAME origin: shared cookies/storage would leak the saved names.
        await Promise.all(
          projects.map(async (project, index) => {
            const initial = await successful(project, 'same-origin-shared-id', {
              kind: 'browser',
              action: { kind: 'open', url: urls[0] },
            });
            expect(initial.job.browser_result?.text).toContain('Empty');
            await successful(project, 'fill-shared-id', {
              kind: 'browser',
              action: { kind: 'fill', selector: '#name', value: `Workspace ${index}` },
            });
            const clicked = await successful(project, 'click-shared-id', {
              kind: 'browser',
              action: { kind: 'click', selector: '#save' },
            });
            expect(clicked.job.browser_result?.text).toContain(`Workspace ${index}`);
          }),
        );
        const reloaded = await Promise.all(
          projects.map((project) =>
            successful(project, 'reload-shared-id', {
              kind: 'browser',
              action: { kind: 'open', url: urls[0], width: 360, height: 640 },
            }),
          ),
        );
        for (const [index, page] of reloaded.entries())
          expect(page.job.browser_result?.text).toContain(`Workspace ${index}`);
        evidence.shared_origin_storage_isolated = true;
        await client.callTool({
          name: 'project.cancel_exec',
          arguments: { ...projects[0]!.bound, job_id: servers[0]!.job_id },
        });
        expect((await terminal(projects[0]!, servers[0]!.job_id)).job.state).toBe('cancelled');
        await expect(fetch(urls[0]!)).rejects.toThrow();
        for (let index = 1; index < projects.length; index += 1) {
          expect((await fetch(urls[index]!)).status).toBe(200);
          expect((await get(projects[index]!, servers[index]!.job_id)).job.state).toBe('running');
        }
        evidence.cancel_did_not_stop_other_projects = true;
        const artifacts = process.env.CHATSPLICE_TEST_ARTIFACT_DIR;
        if (artifacts !== undefined) {
          await mkdir(artifacts, { recursive: true });
          for (const [index, page] of reloaded.entries()) {
            const image = (page.result.content as Array<{ type: string; data?: string }>).find(
              (item) => item.type === 'image',
            );
            expect(image?.data).toBeDefined();
            await writeFile(
              join(artifacts, `project-${index}-mobile.jpg`),
              Buffer.from(image!.data!, 'base64'),
            );
          }
        }
        await Promise.all(
          projects.map((project) =>
            successful(project, 'close-shared-id', { kind: 'browser', action: { kind: 'close' } }),
          ),
        );
        await Promise.all(
          projects.map(async (project, index) => {
            await client.callTool({
              name: 'project.cancel_exec',
              arguments: { ...project.bound, job_id: servers[index]!.job_id },
            });
            expect((await terminal(project, servers[index]!.job_id)).job.state).toBe('cancelled');
            await expect(fetch(urls[index]!)).rejects.toThrow();
          }),
        );
        evidence.all_owned_processes_stopped = true;
        if (artifacts !== undefined)
          await writeFile(
            join(artifacts, 'multi-project-evidence.json'),
            JSON.stringify(evidence, null, 2),
          );
      } finally {
        await client.close();
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
