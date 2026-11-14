import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import process from 'node:process';
import console from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireMcp = createRequire(join(root, 'packages/mcp-server/package.json'));
const { Client, StreamableHTTPClientTransport } = await import(
  requireMcp.resolve('@modelcontextprotocol/client')
);
const {
  CONTROL_PROTOCOL_VERSION,
  ProjectExecSummarySchema,
  ProjectExecJobSchema,
  WorkspaceSummarySchema,
  FsReadResultSchema,
  GoalUpdateResultSchema,
  GoalReadResultSchema,
  MCP_SERVER_VERSION,
  EXECUTION_CONTRACT_VERSION,
} = await import(requireMcp.resolve('@chatsplice/protocol'));
const argv = process.argv.slice(2).filter((argument) => argument !== '--');
function argument(name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
if (process.platform !== 'darwin' || argument('--app') === undefined)
  throw new Error(
    'Use on macOS: pnpm test:packaged -- --app /path/to/ChatSplice.app [--browser] [--artifacts /path]',
  );
const app = resolve(argument('--app'));
const executable = join(app, 'Contents/MacOS/ChatSplice');
const daemon = join(app, 'Contents/Resources/chatspliced/chatspliced.js');
const directory = await mkdtemp('/tmp/cs-package-');
const artifacts =
  argument('--artifacts') === undefined ? undefined : resolve(argument('--artifacts'));
const evidence = {
  app_version: JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version,
};
assert.equal(
  execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim(),
  evidence.app_version,
);
const children = new Set();
const clients = new Set();
const ownerTokenPaths = new Map();
let previewServer;

async function control(socketPath, path, body) {
  const token = (await readFile(ownerTokenPaths.get(socketPath), 'utf8')).trim();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveResponse, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          'x-chatsplice-control-mutation-token': token,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        timeout: 5000,
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            assert.ok(
              response.statusCode >= 200 && response.statusCode < 300,
              `Control HTTP ${response.statusCode}`,
            );
            resolveResponse(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Control request timed out.')));
    req.end(payload);
  });
}

async function startProfile(name, path) {
  const data = join(directory, name);
  const socket = join(directory, `${name}.sock`);
  ownerTokenPaths.set(socket, join(data, 'run/control-mutation-token'));
  let output = '';
  let spawnError;
  const child = spawn(executable, [daemon, '--data-dir', data, '--control-socket', socket], {
    env: {
      HOME: process.env.HOME,
      PATH: path,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('error', (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16000);
    });
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Packaged daemon exited: ${output}`);
    try {
      status = await control(socket, '/v1/status');
      if (status.ready) break;
    } catch {
      /* Starting. */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(status?.ready, true, output);
  assert.equal(status.protocol_version, CONTROL_PROTOCOL_VERSION);
  assert.equal(status.execution_contract, EXECUTION_CONTRACT_VERSION);
  assert.match(status.build_id, /^[a-f0-9]{64}$/);
  assert.match(status.run_id, /^[a-f0-9-]{36}$/);
  const token = (await readFile(join(data, 'run/mcp-token'), 'utf8')).trim();
  const client = new Client({ name: 'packaged-release-smoke', version: '1.0.0' });
  clients.add(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.mcp_url), {
      requestInit: { headers: { 'x-chatsplice-token': token } },
    }),
  );
  const inventory = await client.listTools();
  assert.equal(inventory.tools.length, 24);
  for (const name of ['project.goal', 'project.goal_update'])
    assert.ok(inventory.tools.some((tool) => tool.name === name));
  assert.equal(client.getServerVersion().version, MCP_SERVER_VERSION);
  const workspaceRoot = join(directory, `${name}-project`);
  await mkdir(workspaceRoot);
  const workspace = WorkspaceSummarySchema.parse(
    await control(socket, '/v1/workspaces', { root_path: workspaceRoot }),
  );
  // Obtain the binding through the owner control API, without reproducing its algorithm.
  const settings = await control(socket, '/v1/project-binding', {
    workspace_id: workspace.workspace_id,
  });
  const binding = settings.binding_text.match(/workspace_binding: (wb_[a-f0-9]{64})/)?.[1];
  assert.ok(binding, 'Generated Project instructions must include the workspace binding.');
  const bound = { workspace_id: workspace.workspace_id, workspace_binding: binding };
  let serial = 0;
  async function submit(operation, timeout = 30000) {
    const result = await client.callTool({
      name: 'project.exec',
      arguments: {
        ...bound,
        request_id: `package-smoke-${++serial}`,
        operation,
        timeout_ms: timeout,
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return ProjectExecSummarySchema.parse(result.structuredContent);
  }
  async function get(jobId, timeout = 0) {
    const result = await client.callTool({
      name: 'project.await_exec',
      arguments: { ...bound, job_id: jobId, timeout_ms: timeout },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return { job: ProjectExecJobSchema.parse(result.structuredContent), result };
  }
  async function terminal(jobId) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const result = await get(jobId, 1000);
      if (!['queued', 'running', 'cancelling'].includes(result.job.state)) return result;
    }
    throw new Error('Packaged execution did not finish.');
  }
  async function succeed(operation, timeout) {
    const result = await terminal((await submit(operation, timeout)).job_id);
    assert.equal(result.job.state, 'succeeded', result.job.message + result.job.output);
    return result;
  }
  return { client, bound, workspaceRoot, submit, get, terminal, succeed, status };
}

try {
  const minimal = await startProfile('finder', '/usr/bin:/bin:/usr/sbin:/sbin');
  const shell = await minimal.succeed({
    kind: 'shell',
    command: 'printf SHELL_READY',
    network: 'local',
  });
  assert.equal(shell.job.output, 'SHELL_READY');
  evidence.finder_path_shell = 'passed';
  const normal = await startProfile('developer', process.env.PATH);
  await writeFile(
    join(normal.workspaceRoot, 'package.json'),
    JSON.stringify({
      name: 'packaged-smoke',
      version: '1.0.0',
      private: true,
      scripts: { postinstall: 'node hook.cjs' },
    }),
  );
  await writeFile(
    join(normal.workspaceRoot, 'hook.cjs'),
    "require('node:fs').writeFileSync('hook.txt','ran')",
  );
  await normal.succeed({
    kind: 'shell',
    command: 'npm install --offline --no-audit --no-fund',
    network: 'enabled',
  });
  assert.equal(await readFile(join(normal.workspaceRoot, 'hook.txt'), 'utf8'), 'ran');
  evidence.install_hook = 'passed';
  const environment = await normal.succeed({ kind: 'environment' });
  assert.equal(environment.job.used_network, false);
  assert.equal(environment.job.environment_result.node.package_manager, 'npm');
  assert.equal(environment.job.environment_result.node.lockfile_path, 'package-lock.json');
  assert.equal(environment.job.environment_result.browser.launch_verified, false);
  evidence.environment_inspection = 'passed';
  const goalCreated = await normal.client.callTool({
    name: 'project.goal_update',
    arguments: {
      ...normal.bound,
      action: 'create',
      objective: 'Verify the packaged runtime output',
      tracked_paths: ['hook.txt'],
      criteria: [
        {
          kind: 'file',
          criterion_id: 'hook',
          path: 'hook.txt',
          description: 'Current hook output exists',
        },
      ],
    },
  });
  assert.notEqual(goalCreated.isError, true);
  let goal = GoalUpdateResultSchema.parse(goalCreated.structuredContent).goal;
  const missingEvidence = await normal.client.callTool({
    name: 'project.goal_update',
    arguments: {
      ...normal.bound,
      action: 'complete',
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    },
  });
  assert.equal(missingEvidence.isError, true);
  const verified = await normal.client.callTool({
    name: 'project.goal_update',
    arguments: {
      ...normal.bound,
      action: 'verify_file',
      criterion_id: 'hook',
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    },
  });
  assert.notEqual(verified.isError, true);
  goal = GoalUpdateResultSchema.parse(verified.structuredContent).goal;
  assert.equal(goal.criteria[0].evidence.build_id, normal.status.build_id);
  const completed = await normal.client.callTool({
    name: 'project.goal_update',
    arguments: {
      ...normal.bound,
      action: 'complete',
      goal_id: goal.goal_id,
      expected_revision: goal.revision,
    },
  });
  assert.notEqual(completed.isError, true);
  assert.equal(GoalUpdateResultSchema.parse(completed.structuredContent).goal.state, 'completed');
  const readGoal = await normal.client.callTool({
    name: 'project.goal',
    arguments: { ...normal.bound, goal_id: goal.goal_id },
  });
  assert.equal(
    GoalReadResultSchema.parse(readGoal.structuredContent).goals[0].evidence_valid,
    true,
  );
  evidence.goal_completion_gate = 'passed';
  const html =
    '<!doctype html><title>Packaged smoke</title><h1>Before</h1><input id="name"><button id="save">Save</button><p id="status">Waiting</p><script>document.querySelector("#save").onclick=()=>document.querySelector("#status").textContent="Saved: "+document.querySelector("#name").value</script>';
  await writeFile(join(normal.workspaceRoot, 'page.html'), html);
  await writeFile(
    join(normal.workspaceRoot, 'server.cjs'),
    "const http=require('node:http'),fs=require('node:fs');const server=http.createServer((req,res)=>res.end(fs.readFileSync('page.html')));server.listen(0,'127.0.0.1',()=>console.log('URL=http://127.0.0.1:'+server.address().port));",
  );
  const server = await normal.submit(
    { kind: 'shell', command: 'node server.cjs', background: true, network: 'local' },
    120000,
  );
  let url;
  for (let attempt = 0; attempt < 100 && url === undefined; attempt += 1) {
    const { job } = await normal.get(server.job_id);
    assert.ok(['queued', 'running'].includes(job.state), job.message + job.output);
    url = job.output.match(/URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(url);
  const readiness = await normal.succeed({ kind: 'readiness', url, attempts: 3 });
  assert.equal(readiness.job.readiness_result.ready, true);
  assert.equal(readiness.job.readiness_result.status_code, 200);
  evidence.structured_readiness = 'passed';
  const before = FsReadResultSchema.parse(
    (
      await normal.client.callTool({
        name: 'fs.read',
        arguments: { ...normal.bound, path: 'page.html' },
      })
    ).structuredContent,
  );
  const edit = await normal.client.callTool({
    name: 'fs.edit',
    arguments: {
      ...normal.bound,
      path: 'page.html',
      expected_sha256: before.sha256,
      edits: [{ old_text: '<h1>Before</h1>', new_text: '<h1>After</h1>' }],
    },
  });
  assert.notEqual(edit.isError, true);
  const after = FsReadResultSchema.parse(
    (
      await normal.client.callTool({
        name: 'fs.read',
        arguments: { ...normal.bound, path: 'page.html' },
      })
    ).structuredContent,
  );
  assert.notEqual(after.sha256, before.sha256);
  assert.match(await (await globalThis.fetch(url)).text(), /<h1>After<\/h1>/);
  evidence.background_server_and_edit = 'passed';
  if (argv.includes('--browser')) {
    await minimal.succeed({ kind: 'browser', action: { kind: 'setup' } }, 180000);
    previewServer = createServer((_req, response) => response.end(html));
    previewServer.listen(0, '127.0.0.1');
    await once(previewServer, 'listening');
    const minimalPage = await minimal.succeed({
      kind: 'browser',
      action: { kind: 'open', url: `http://127.0.0.1:${previewServer.address().port}` },
    });
    assert.equal(minimalPage.job.browser_result.title, 'Packaged smoke');
    evidence.finder_path_browser = 'passed';
    const opened = await normal.succeed({ kind: 'browser', action: { kind: 'open', url } });
    assert.match(opened.job.browser_result.text, /After/);
    assert.ok(opened.job.browser_result.controls.some((control) => control.selector === '#save'));
    await normal.succeed({
      kind: 'browser',
      action: { kind: 'fill', selector: '#name', value: 'Package' },
    });
    const clicked = await normal.succeed({
      kind: 'browser',
      action: { kind: 'click', selector: '#save' },
    });
    assert.match(clicked.job.browser_result.text, /Saved: Package/);
    assert.deepEqual(
      clicked.job.browser_result.console.filter((message) =>
        /^(error:|pageerror:|requestfailed:)/.test(message),
      ),
      [],
    );
    const mobile = await normal.succeed({
      kind: 'browser',
      action: { kind: 'open', url, width: 360, height: 640 },
    });
    assert.equal(mobile.job.browser_result.width, 360);
    assert.ok(mobile.result.content.some((item) => item.type === 'image'));
    evidence.browser_interaction_and_mobile = 'passed';
    if (artifacts !== undefined) {
      await mkdir(artifacts, { recursive: true });
      for (const [name, result] of [
        ['desktop', clicked.result],
        ['mobile', mobile.result],
      ]) {
        const image = result.content.find((item) => item.type === 'image');
        await writeFile(join(artifacts, `${name}.jpg`), Buffer.from(image.data, 'base64'));
      }
    }
    await normal.succeed({ kind: 'browser', action: { kind: 'close' } });
    await minimal.succeed({ kind: 'browser', action: { kind: 'close' } });
  }
  await normal.client.callTool({
    name: 'project.cancel_exec',
    arguments: { ...normal.bound, job_id: server.job_id },
  });
  assert.equal((await normal.terminal(server.job_id)).job.state, 'cancelled');
  await assert.rejects(globalThis.fetch(url));
  evidence.cancellation = 'passed';
} finally {
  await Promise.allSettled([...clients].map((client) => client.close()));
  if (previewServer !== undefined)
    await new Promise((resolveClose) => previewServer.close(resolveClose));
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close').catch(() => undefined);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
evidence.daemon_shutdown = 'passed';
if (artifacts !== undefined) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
