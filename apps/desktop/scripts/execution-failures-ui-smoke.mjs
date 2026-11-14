/* global localStorage, window, structuredClone, URLSearchParams */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Isolated renderer fixture only. It never connects to the daemon, executes
// a project command, starts a PTY, or changes the user's current app/session.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rendererRoot = resolve(
  process.env.CHATSPLICE_RENDERER_DIR ?? join(root, 'apps/desktop/dist/renderer'),
);

function installFixture() {
  const locale = new URLSearchParams(window.location.search).get('fixtureLocale') ?? 'ko';
  localStorage.setItem('chatsplice.ui-locale.v1', locale);
  const sourceId = 'ws_' + 'a'.repeat(24);
  const otherId = 'ws_' + 'b'.repeat(24);
  const legacyLimit =
    'The execution link inspection exceeded its bounded limit. Use a smaller workspace.';
  const source = {
    workspace_id: sourceId,
    display_name: 'Demo project',
    root_path: '/fixture/demo-project',
    kind: 'user',
    created_at: '2026-10-19T12:00:00.000Z',
  };
  const other = {
    ...source,
    workspace_id: otherId,
    display_name: 'Other fixture',
    root_path: '/fixture/other',
  };
  const samples = [
    {
      operation: { kind: 'node_script', script: 'check' },
      cwd: 'web',
      command: 'pnpm run check',
      message: legacyLimit,
    },
    {
      operation: { kind: 'cargo', task: 'check' },
      cwd: 'backend',
      command: 'cargo check --offline',
      message:
        '[EXECUTION_PREFLIGHT_ENTRY_LIMIT] The execution link inspection entry limit was exceeded; the command was not started. Observed: roots=1, entries=200001, directories=812, depth=9, elapsed_ms=5700. Limits: entries=200000, depth=64, duration_ms=10000.',
    },
    {
      operation: { kind: 'browser', action: { kind: 'open', url: 'http://127.0.0.1:5173' } },
      command: 'browser open',
      message: '[browser_missing] Managed Chromium is missing from this runtime cache.',
    },
    {
      operation: { kind: 'shell', command: 'fixture-check' },
      command: 'fixture-check',
      error_code: null,
      exit_code: 1,
      message: 'Project execution failed.',
      output: 'Fixture check reported one failing assertion.\n',
    },
    {
      operation: { kind: 'shell', command: 'fixture-long-check', network: 'local' },
      command: 'fixture-long-check',
      state: 'timed_out',
      error_code: null,
      exit_code: null,
      message: 'Project execution timed out.',
    },
    { command: 'unknown fixture result', error_code: null, message: 'Project execution failed.' },
    {
      command: 'successful fixture',
      state: 'succeeded',
      error_code: null,
      exit_code: 0,
      message: 'Project execution succeeded.',
    },
    {
      command: 'cancelled fixture',
      state: 'cancelled',
      error_code: 'CANCELLED',
      message: 'Project execution was cancelled.',
    },
    {
      operation: {
        kind: 'browser',
        action: { kind: 'assert', expectation: { kind: 'visible', selector: '#ready' } },
      },
      command: 'browser assert',
      error_code: null,
      exit_code: 1,
      message: 'Project execution failed.',
      output: '[assertion_failed] Fixture #ready was not visible.',
    },
  ];
  const jobs = samples.map((sample, index) => ({
    job_id: 'exec_00000000-0000-0000-0000-' + String(index + 1).padStart(12, '0'),
    workspace_id: sourceId,
    workspace_name: source.display_name,
    operation: { kind: 'node_script', script: 'check' },
    cwd: '.',
    state: 'failed',
    command: 'fixture',
    created_at: new Date(Date.UTC(2026, 9, 19, 12, 49, 59 - index)).toISOString(),
    started_at: new Date(Date.UTC(2026, 9, 19, 12, 50, index)).toISOString(),
    finished_at: new Date(Date.UTC(2026, 9, 19, 12, 51, index)).toISOString(),
    exit_code: null,
    error_code: 'BAD_REQUEST',
    message: legacyLimit,
    used_network: false,
    truncated: false,
    duration_ms: 5700,
    output: '',
    ...sample,
  }));
  jobs.push({
    ...jobs[0],
    job_id: 'exec_00000000-0000-0000-0000-000000000099',
    workspace_id: otherId,
    workspace_name: other.display_name,
    command: 'Other fixture only',
    message: 'Other project request problem.',
  });
  const panel = {
    workspace_id: sourceId,
    console_open: false,
    files_open: false,
    files_width: 340,
    console_height: 400,
  };
  const state = { panel, jobs, reads: [], sourceId, otherId };
  window.executionFailuresFixture = state;
  window.chatsplice = {
    getPanelState: async () => structuredClone(panel),
    setPanelState: async (value) => {
      Object.assign(panel, value);
      return structuredClone(panel);
    },
    listWorkspaces: async () => ({ workspaces: structuredClone([source, other]), count: 2 }),
    listTerminalSessions: async () => [],
    getStatus: async () => ({
      daemon: { execution_jobs: structuredClone(jobs), latest_mcp_activities: [] },
    }),
    getExecutionJob: async ({ workspace_id, job_id }) => {
      state.reads.push({ workspace_id, job_id });
      const result = jobs.find(
        (entry) => entry.job_id === job_id && entry.workspace_id === workspace_id,
      );
      if (result === undefined)
        throw new Error('Fixture job does not belong to the selected project.');
      return structuredClone(result);
    },
    cancelExecutionJob: async () => {
      throw new Error('This read-only fixture never cancels real jobs.');
    },
  };
}

const fixtureScript = '(' + installFixture.toString() + ')();';
const bootstrap = '<script src="/execution-failures-fixture.js"></script>';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/execution-failures-fixture.js') {
      response
        .writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
        .end(fixtureScript);
      return;
    }
    const path = resolve(rendererRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(rendererRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    let content = await readFile(path);
    if (extname(path) === '.html')
      content = Buffer.from(content.toString('utf8').replace('</head>', bootstrap + '</head>'));
    response
      .writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const fixtureUrl = 'http://127.0.0.1:' + server.address().port + '/?surface=console';

if (process.argv.includes('--serve')) {
  console.log(
    JSON.stringify({ fixtureUrl, rendererRoot, bridgeFixture: true, nativeDaemon: false }),
  );
  await new Promise((done) => {
    const close = () => server.close(done);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
} else {
  const require = createRequire(join(root, 'packages/mcp-server/package.json'));
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(
    root,
    'packages/mcp-server/node_modules/.cache/chatsplice-playwright',
  );
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  const { chromium } = require('playwright');
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-failures-ui-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 440 }, locale: 'ko-KR' });
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(fixtureUrl);
    await page.getByRole('button', { name: '작업기록', exact: true }).click();
    const section = page.locator('.execution-jobs');
    const filter = section.getByRole('combobox', { name: '실패 원인별 보기', exact: true });
    const diagnosis = section.getByTestId('execution-failure-diagnosis');
    await section.getByText('현재 보관된 프로젝트 실행 9건 · 실패 7건', { exact: true }).waitFor();
    await diagnosis.getByText('실행 전 검사 한도', { exact: true }).waitFor();
    assert.equal(await section.locator('.execution-row').count(), 9);
    await section.locator('.execution-compact-meta > summary').click();
    await section.getByText('로컬 연결만', { exact: true }).waitFor();
    assert.equal(await section.getByText('정책으로 차단', { exact: true }).count(), 0);
    await filter.selectOption('preflight_limit');
    assert.equal(await section.locator('.execution-row').count(), 2);
    await section.locator('.execution-row').nth(1).click();
    const cargoNetworkKo = section.getByText('로컬 통신 · Cargo 의존성 오프라인', { exact: true });
    if (!(await cargoNetworkKo.isVisible()))
      await section.locator('.execution-compact-meta > summary').click();
    await cargoNetworkKo.waitFor();
    await section.screenshot({ path: join(evidenceDirectory, 'failures-preflight.png') });
    await filter.selectOption('browser_missing');
    await diagnosis.getByText('브라우저 설치 필요', { exact: true }).waitFor();
    assert.equal(await section.locator('.execution-row').count(), 1);
    await filter.selectOption('browser_action');
    await diagnosis.getByText('브라우저 조작·검증', { exact: true }).waitFor();
    await filter.selectOption('command');
    await diagnosis.getByText('명령 실행', { exact: true }).waitFor();
    await section
      .getByText('Fixture check reported one failing assertion.', { exact: true })
      .waitFor();
    await section.locator('.execution-compact-meta > summary').click();
    await section.getByText('외부 연결 허용', { exact: true }).waitFor();
    await filter.selectOption('unknown');
    await diagnosis.getByText('원인 확인 필요', { exact: true }).waitFor();
    await filter.selectOption('failed');
    assert.equal(await section.locator('.execution-row').count(), 7);
    await page.evaluate(() => {
      window.executionFailuresFixture.panel.workspace_id = window.executionFailuresFixture.otherId;
    });
    await section.getByText('현재 보관된 프로젝트 실행 1건 · 실패 1건', { exact: true }).waitFor();
    await section.getByText('Other fixture only', { exact: true }).waitFor();
    assert.equal(await filter.inputValue(), 'all');
    await page.evaluate(() => {
      window.executionFailuresFixture.panel.workspace_id = window.executionFailuresFixture.sourceId;
    });
    await section.getByText('현재 보관된 프로젝트 실행 9건 · 실패 7건', { exact: true }).waitFor();
    await filter.selectOption('preflight_limit');
    await page.setViewportSize({ width: 480, height: 440 });
    await section.locator('.execution-row').nth(1).click();
    if (!(await cargoNetworkKo.isVisible()))
      await section.locator('.execution-compact-meta > summary').click();
    await cargoNetworkKo.waitFor();
    const cargoLabelBounds = await cargoNetworkKo.boundingBox();
    assert.ok(
      cargoLabelBounds !== null &&
        cargoLabelBounds.x >= 0 &&
        cargoLabelBounds.x + cargoLabelBounds.width <= 480,
    );
    const bounds = await section.boundingBox();
    assert.ok(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 480);
    await page.screenshot({ path: join(evidenceDirectory, 'failures-narrow.png'), fullPage: true });
    await page.evaluate(() => {
      window.executionFailuresFixture.jobs.splice(0, 2);
    });
    await section.getByText('현재 보관된 프로젝트 실행 7건 · 실패 5건', { exact: true }).waitFor();
    assert.equal(await filter.inputValue(), 'all');
    await diagnosis.getByText('브라우저 설치 필요', { exact: true }).waitFor();
    assert.equal(await section.getByText('pnpm run check', { exact: true }).count(), 0);
    await page.setViewportSize({ width: 1180, height: 440 });
    await page.goto(fixtureUrl + '&fixtureLocale=en');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await section
      .getByText('Retained project executions: 9 · failures: 7', { exact: true })
      .waitFor();
    await diagnosis.getByText('Preflight inspection limit', { exact: true }).waitFor();
    await section.locator('.execution-row').nth(1).click();
    const cargoNetworkEn = section.getByText('Local network · Cargo dependencies offline', {
      exact: true,
    });
    if (!(await cargoNetworkEn.isVisible()))
      await section.locator('.execution-compact-meta > summary').click();
    await cargoNetworkEn.waitFor();
    await section.screenshot({ path: join(evidenceDirectory, 'failures-english.png') });
    const progress = section.getByTestId('execution-progress');
    await section.locator('.execution-row').nth(1).click();
    await page.evaluate(() => {
      const entry = window.executionFailuresFixture.jobs[0];
      Object.assign(entry, {
        state: 'queued',
        started_at: null,
        finished_at: null,
        error_code: null,
        message: '[EXECUTION_WAITING_ROOT] Waiting. phase_elapsed_ms=1200; queue_ms=1200;',
      });
    });
    await section.locator('.execution-row').first().click();
    await progress.getByText('Waiting for work in the same folder', { exact: true }).waitFor();
    for (const [message, title] of [
      [
        '[EXECUTION_WAITING_SLOT] Waiting. phase_elapsed_ms=500; queue_ms=1700;',
        'Waiting for an execution slot',
      ],
      [
        '[EXECUTION_PREPARING] Preparing. phase_elapsed_ms=200; queue_ms=1700;',
        'Preparing the task',
      ],
      [
        '[EXECUTION_PREFLIGHT] phase=scanning; roots=2; entries=250008; directories=800; elapsed_ms=5600; phase_elapsed_ms=1400; queue_ms=1700;',
        'Inspecting files before execution',
      ],
      [
        '[EXECUTION_PREFLIGHT] phase=checking_links; roots=2; entries=250008; elapsed_ms=5700; phase_elapsed_ms=1500; queue_ms=1700;',
        'Verifying file links',
      ],
      [
        '[EXECUTION_RUNNING] Running. phase_elapsed_ms=1000; queue_ms=1700;',
        'Local task in progress',
      ],
    ]) {
      await page.evaluate(
        ({ message }) => {
          Object.assign(window.executionFailuresFixture.jobs[0], { state: 'running', message });
        },
        { message },
      );
      await progress.getByText(title, { exact: true }).waitFor();
    }
    await page.evaluate(() => {
      Object.assign(window.executionFailuresFixture.jobs[0], {
        state: 'failed',
        error_code: 'BAD_REQUEST',
        message:
          '[WORKSPACE_OPERATION_WAIT_TIMEOUT] This change did not start. wait_limit_ms=15000;',
      });
    });
    await diagnosis.getByText('File operation wait timed out', { exact: true }).waitFor();
    assert.equal(await progress.count(), 0);
    await page.goto(fixtureUrl);
    await page.getByRole('button', { name: '작업기록', exact: true }).click();
    await section.locator('.execution-row').nth(1).click();
    await page.evaluate(() => {
      Object.assign(window.executionFailuresFixture.jobs[0], {
        state: 'running',
        finished_at: null,
        error_code: null,
        message:
          '[EXECUTION_PREFLIGHT] phase=scanning; roots=2; entries=250008; directories=800; elapsed_ms=5600; phase_elapsed_ms=1400; queue_ms=4000;',
      });
    });
    await section.locator('.execution-row').first().click();
    await progress.getByText('실행 전 파일 검사 중', { exact: true }).waitFor();
    await progress.getByText('250,008', { exact: true }).waitFor();
    await progress.getByText('5.6초', { exact: true }).waitFor();
    await page.setViewportSize({ width: 480, height: 440 });
    const progressBounds = await progress.boundingBox();
    assert.ok(
      progressBounds !== null &&
        progressBounds.x >= 0 &&
        progressBounds.x + progressBounds.width <= 480,
    );
    await progress.screenshot({ path: join(evidenceDirectory, 'progress-narrow.png') });
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        bridgeFixture: true,
        nativeDaemon: false,
        legacyAndStablePreflightGrouped: true,
        originalErrorsRetained: true,
        networkFlagNotTreatedAsFailure: true,
        workspaceSwitchIsolated: true,
        cancelledNotCountedAsFailure: true,
        evictedSelectionCleared: true,
        localized: true,
        narrowLayout: true,
        observedProgressStages: true,
        localizedProgressCounts: true,
        busyWaitClassified: true,
        evidenceDirectory,
        pageErrors,
      }),
    );
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
