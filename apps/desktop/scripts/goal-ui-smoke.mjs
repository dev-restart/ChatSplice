/* global localStorage, window, structuredClone, document, navigator, URLSearchParams */
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

// Isolated owner bridge fixture only: no live daemon, user Goals, ChatGPT
// messages, OS clipboard or project commands are changed by this UI smoke.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rendererRoot = resolve(
  process.env.CHATSPLICE_RENDERER_DIR ?? join(projectRoot, 'apps/desktop/dist/renderer'),
);

function installFixture() {
  const locale = new URLSearchParams(window.location.search).get('fixtureLocale') ?? 'ko';
  localStorage.setItem('chatsplice.ui-locale.v1', locale);
  const workspaceId = `ws_${'a'.repeat(24)}`;
  const now = new Date().toISOString();
  const calls = [];
  let goals = [];
  let goalTemplate;
  let pageSize = 32;
  let completionBlocked = true;
  const copiedRequests = [];
  const sourceId = workspaceId;
  const otherId = `ws_${'b'.repeat(24)}`;
  window.goalFixture = {
    calls,
    jobs: [],
    getGoals: () => structuredClone(goals),
    seedHistory: () => {
      pageSize = 7; // Simulate a byte-bounded page smaller than the requested limit.
      goals = Array.from({ length: 37 }, (_, index) => ({
        ...structuredClone(goalTemplate),
        goal_id: `goal_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        objective: `History Goal ${index}`,
        state: ['active', 'paused', 'interrupted', 'completed', 'cancelled'][index % 5],
        updated_at: new Date(Date.now() - index * 1_000).toISOString(),
        max_executions: 0,
        executions_used: index + 140,
      }));
    },
    seedResetEvidence: () => {
      const goal = goals[0];
      goal.state = 'paused';
      goal.root_matches = true;
      goal.evidence_valid = true;
      goal.revision += 1;
      goal.updated_at = new Date().toISOString();
      goal.checkpoint = {
        summary: '이전 검증의 진행 요약',
        next_step: '이전 검증의 다음 단계',
        files: goal.tracked_paths.map((path) => ({ path, sha256: 'c'.repeat(64) })),
        saved_at: goal.updated_at,
      };
      goal.criteria = goal.criteria.map((criterion, index) => ({
        ...criterion,
        status: 'passed',
        evidence: {
          kind: criterion.kind,
          job_id:
            criterion.kind === 'file'
              ? null
              : 'exec_00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
          sha256: criterion.kind === 'file' ? 'c'.repeat(64) : null,
          scope_digest: 'd'.repeat(64),
          build_id: 'e'.repeat(64),
          run_id: '00000000-0000-4000-8000-000000000000',
          verified_at: goal.updated_at,
        },
      }));
      goal.receipts = goal.criteria
        .filter((criterion) => criterion.kind !== 'file')
        .map((criterion, index) => ({
          job_id: criterion.evidence.job_id,
          request_hash: String(index + 1).repeat(64),
          criterion_id: criterion.criterion_id,
          state: 'succeeded',
          build_id: 'e'.repeat(64),
          run_id: '00000000-0000-4000-8000-000000000000',
          created_at: goal.updated_at,
          started_at: goal.updated_at,
          finished_at: goal.updated_at,
          exit_code: 0,
        }));
    },
    setResetOwnedWork: (running) => {
      const goal = goals[0];
      const receipt = goal.receipts[0];
      receipt.state = running ? 'running' : 'succeeded';
      receipt.finished_at = running ? null : new Date().toISOString();
      receipt.exit_code = running ? null : 0;
      goal.revision += 1;
      goal.updated_at = new Date().toISOString();
    },
    copiedRequests,
    clipboardDenied: false,
    clipboardDeferred: false,
    finishCopy: undefined,
    panel: undefined,
    externalCheckpoint: (summary, nextStep) => {
      const goal = goals[0];
      goal.revision += 1;
      goal.updated_at = new Date().toISOString();
      goal.checkpoint = { summary, next_step: nextStep, files: [], saved_at: goal.updated_at };
    },
    externalBudget: (maxExecutions) => {
      const goal = goals[0];
      goal.max_executions = maxExecutions;
      goal.revision += 2; // Model an external resume followed by pause.
      goal.updated_at = new Date().toISOString();
    },
    setGoalState: (state, rootMatches = true) => {
      goals[0].state = state;
      goals[0].root_matches = rootMatches;
      goals[0].revision += 1;
    },
    switchWorkspace: (other) => {
      panel.workspace_id = other ? otherId : sourceId;
    },
    unblockCompletion: () => {
      completionBlocked = false;
      goals.forEach((goal) =>
        goal.criteria.forEach((criterion) => {
          criterion.status = 'passed';
        }),
      );
    },
  };
  const panel = {
    workspace_id: workspaceId,
    console_open: true,
    files_open: false,
    files_width: 340,
    console_height: 560,
  };
  window.goalFixture.panel = panel;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value) => {
        if (window.goalFixture.clipboardDenied) throw new Error('Clipboard denied by fixture.');
        if (window.goalFixture.clipboardDeferred)
          await new Promise((resolveCopy) => {
            window.goalFixture.finishCopy = resolveCopy;
          });
        copiedRequests.push(value);
      },
    },
  });
  const session = {
    workspace_id: workspaceId,
    terminal_id: 'term_fixture',
    created_at: now,
    state: 'running',
    cols: 120,
    rows: 30,
  };
  window.chatsplice = {
    getPanelState: async () => panel,
    setPanelState: async (patch) => Object.assign(panel, patch),
    listWorkspaces: async () => ({
      workspaces: [
        {
          workspace_id: workspaceId,
          display_name: 'Goal fixture',
          root_path: '/fixture/project',
          kind: 'user',
          created_at: now,
        },
        {
          workspace_id: otherId,
          display_name: 'Other Goal fixture',
          root_path: '/fixture/other',
          kind: 'user',
          created_at: now,
        },
      ],
      count: 2,
    }),
    listTerminalSessions: async (selectedId) => [{ ...session, workspace_id: selectedId }],
    readTerminalSession: async () => ({
      ...session,
      output: '',
      next_offset: 0,
      truncated: false,
      exited: false,
      exit_code: null,
    }),
    resizeTerminalSession: async () => session,
    getStatus: async () => ({
      daemon: {
        execution_jobs: structuredClone(window.goalFixture.jobs),
        latest_mcp_activities: [],
      },
    }),
    getExecutionJob: async () => structuredClone(window.goalFixture.jobs[0]),
    readWorkspaceFile: async () => ({
      content: JSON.stringify({ scripts: { test: 'node test.js', build: 'node build.js' } }),
      truncated: false,
    }),
    listGoals: async (input) => {
      calls.push({ type: 'read', input });
      const matching = goals
        .filter((goal) => goal.workspace_id === input.workspace_id)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      if (input.goal_id !== undefined) {
        const goal = matching.find((candidate) => candidate.goal_id === input.goal_id);
        if (goal === undefined) throw new Error('Goal does not exist in the selected workspace.');
        return { goals: [structuredClone(goal)], total: 1, has_more: false, next_offset: null };
      }
      const offset = input.offset ?? 0;
      const page = matching.slice(offset, offset + Math.min(input.limit ?? 32, pageSize));
      const more = offset + page.length < matching.length;
      return {
        goals: structuredClone(page),
        total: matching.length,
        has_more: more,
        next_offset: more ? offset + page.length : null,
      };
    },
    submitProjectExec: async (input) => {
      calls.push({ type: 'exec', input });
      return { job_id: 'exec_00000000-0000-4000-8000-000000000000' };
    },
    updateGoal: async (input) => {
      calls.push({ type: 'update', input });
      if (input.action === 'create') {
        const goal = {
          ...input,
          goal_id: 'goal_00000000-0000-4000-8000-000000000000',
          criteria: input.criteria.map((criterion) => ({
            ...criterion,
            status: 'pending',
            evidence: null,
          })),
          state: 'active',
          revision: 1,
          created_at: now,
          updated_at: now,
          deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
          executions_used: 0,
          receipts: [],
          root_matches: true,
          evidence_valid: false,
          message: '',
          checkpoint: { summary: '', next_step: input.next_step, files: [], saved_at: now },
        };
        goalTemplate = structuredClone(goal);
        goals = [goal];
        return { goal: structuredClone(goal) };
      }
      const goal = goals.find((candidate) => candidate.goal_id === input.goal_id);
      if (goal === undefined) throw new Error('Fixture Goal was not found in this project.');
      if (input.expected_revision !== goal.revision)
        throw new Error('Goal revision changed. Read the latest Goal before updating.');
      if (input.action === 'delete') {
        if (goal.state !== 'completed' && goal.state !== 'cancelled')
          throw new Error('Only finished Goals can be deleted.');
        goals = goals.filter((candidate) => candidate.goal_id !== goal.goal_id);
        return { goal: structuredClone(goal), deleted: true };
      }
      if (input.action === 'complete' && completionBlocked)
        throw new Error('Required evidence is stale. Re-run its checks.');
      if (
        input.action === 'reset' &&
        (!goal.root_matches ||
          goal.state === 'cancelling' ||
          goal.receipts.some((receipt) => ['queued', 'running'].includes(receipt.state)))
      )
        throw new Error('Wait for owned Goal operations and cleanup before resetting.');
      goal.revision += 1;
      if (input.action === 'reset') {
        goal.state = 'paused';
        goal.criteria = goal.criteria.map((criterion) => ({
          ...criterion,
          status: 'pending',
          evidence: null,
        }));
        goal.checkpoint =
          goal.checkpoint === null ? null : { ...goal.checkpoint, summary: '', next_step: '' };
        goal.receipts = [];
        goal.evidence_valid = false;
        goal.updated_at = new Date().toISOString();
        goal.message = '';
        completionBlocked = true;
      }
      if (input.action === 'pause') goal.state = 'paused';
      if (input.action === 'resume') {
        goal.state = 'active';
        goal.max_executions = input.max_executions ?? goal.max_executions;
      }
      if (input.action === 'cancel') goal.state = 'cancelled';
      if (input.action === 'complete') goal.state = 'completed';
      if (input.action === 'checkpoint')
        goal.checkpoint = {
          summary: input.summary,
          next_step: input.next_step,
          files: [],
          saved_at: now,
        };
      if (input.action === 'verify_file')
        goal.criteria.find((criterion) => criterion.criterion_id === input.criterion_id).status =
          'passed';
      return { goal: structuredClone(goal) };
    },
  };
}

const fixtureScript = '(' + installFixture.toString() + ')();';
const bootstrap = '<script src="/goal-fixture.js"></script>';
const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/goal-fixture.js') {
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
    response.writeHead(200, {
      'content-type': contentTypes[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(content);
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
  const require = createRequire(join(projectRoot, 'packages/mcp-server/package.json'));
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(
    projectRoot,
    'packages/mcp-server/node_modules/.cache/chatsplice-playwright',
  );
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  const { chromium } = require('playwright');
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-goal-ui-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, locale: 'ko-KR' });
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    async function openGoalDetails(testId) {
      const details = page.getByTestId(testId);
      await details.waitFor();
      if (!(await details.evaluate((element) => element.open)))
        await details.locator('summary').click();
    }

    await page.goto(fixtureUrl);
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    await page.getByText('이 프로젝트에 저장된 Goal이 없습니다.').waitFor();
    const requestInput = page.getByTestId('goal-chat-request');
    await requestInput.waitFor();
    assert.equal(await page.getByLabel('목표', { exact: true }).isVisible(), false);
    assert.equal(
      await page.getByRole('button', { name: '요청 복사', exact: true }).isDisabled(),
      true,
    );
    await requestInput.fill('   ');
    assert.equal(
      await page.getByRole('button', { name: '요청 복사', exact: true }).isDisabled(),
      true,
    );
    const intent = '설정 화면을 개선하고 저장 후 다시 열어도 유지되는지 검증해 줘.';
    await requestInput.fill(intent);
    const createPreview = page.getByTestId('goal-chat-create-preview');
    const createText = await createPreview.inputValue();
    assert.ok(createText.includes('project.goal_update(create)'));
    assert.ok(createText.includes(intent));
    assert.ok(createText.includes('ws_' + 'a'.repeat(24)));
    assert.equal(createText.includes('workspace_binding'), false);
    await page.getByRole('button', { name: '요청 복사', exact: true }).click();
    await page
      .getByText('요청을 복사했습니다. 이 프로젝트의 ChatGPT 대화에 붙여넣고 보내세요.', {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.evaluate(() => window.goalFixture.copiedRequests.at(-1)), createText);
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.type !== 'read').length,
      ),
      0,
    );
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-natural-language.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      window.goalFixture.clipboardDenied = true;
    });
    await page.getByRole('button', { name: '요청 복사', exact: true }).click();
    await page
      .getByText('복사하지 못했습니다. 아래 요청문을 선택해 직접 복사하세요.', { exact: true })
      .waitFor();
    assert.equal(await createPreview.inputValue(), createText);
    await page.getByRole('button', { name: '요청문 선택', exact: true }).click();
    assert.equal(
      await createPreview.evaluate((field) => field.selectionEnd - field.selectionStart),
      createText.length,
    );
    await page.evaluate(() => {
      window.goalFixture.clipboardDenied = false;
      window.goalFixture.clipboardDeferred = true;
    });
    await page.getByRole('button', { name: '요청 복사', exact: true }).click();
    await page.evaluate(() => window.goalFixture.switchWorkspace(true));
    await page
      .getByRole('heading', { name: 'Other Goal fixture', exact: true })
      .waitFor({ state: 'attached' });
    assert.equal(await requestInput.inputValue(), '');
    assert.equal(await createPreview.count(), 0);
    await page.evaluate(() => {
      window.goalFixture.finishCopy?.();
      window.goalFixture.clipboardDeferred = false;
    });
    await page.waitForFunction(() => window.goalFixture.copiedRequests.length === 2);
    assert.equal(await page.locator('.copy-message').count(), 0);
    await page.evaluate(() => window.goalFixture.switchWorkspace(false));
    await page
      .getByRole('heading', { name: 'Goal fixture', exact: true })
      .waitFor({ state: 'attached' });
    await requestInput.waitFor();

    await page.getByRole('button', { name: '새 Goal', exact: true }).click();
    await page.getByText('직접 입력 (고급)', { exact: true }).click();
    await page.getByLabel('목표', { exact: true }).fill('페이지 검증을 마치기');
    await page.getByLabel('작업 범위', { exact: true }).fill('프로젝트 fixture');
    await page
      .getByLabel('추적할 파일 경로, 한 줄에 하나', { exact: true })
      .fill('src/app.ts\npackage.json');
    await page.getByLabel('상대 파일 경로', { exact: true }).fill('src/app.ts');
    await page.getByRole('button', { name: '필수 기준 추가', exact: true }).click();
    await page.getByLabel('추적할 파일 경로, 한 줄에 하나', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Goal 저장', exact: true }).click();
    await page.getByRole('heading', { name: '페이지 검증을 마치기' }).waitFor();
    assert.equal(await page.getByTestId('goal-criteria-details').getAttribute('open'), null);
    assert.equal(await page.getByTestId('goal-advanced-details').getAttribute('open'), null);
    assert.equal(await page.locator('.criteria').isVisible(), false);
    assert.equal(await page.getByLabel('진행 요약', { exact: true }).isVisible(), false);
    const continueButton = page.getByTestId('goal-chat-continue');
    await continueButton.click();
    const continuePreview = page.getByTestId('goal-chat-continue-preview');
    const continuationText = await continuePreview.inputValue();
    assert.ok(continuationText.includes('goal_00000000-0000-4000-8000-000000000000'));
    assert.ok(continuationText.includes('최신 expected_revision'));
    const mutationsBeforeCopy = await page.evaluate(
      () => window.goalFixture.calls.filter((call) => call.type !== 'read').length,
    );
    await page.getByRole('button', { name: '이어하기 요청 복사', exact: true }).click();
    await page
      .getByText('요청을 복사했습니다. 이 프로젝트의 ChatGPT 대화에 붙여넣고 보내세요.', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.type !== 'read').length,
      ),
      mutationsBeforeCopy,
    );
    await openGoalDetails('goal-advanced-details');
    await page.evaluate(() =>
      window.goalFixture.externalCheckpoint('MCP 최신 진행 요약', '화면 저장 동작 확인'),
    );
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.checkpoint textarea')?.value === 'MCP 최신 진행 요약',
    );
    assert.equal(
      await page.getByLabel('직접 이어갈 다음 단계', { exact: true }).inputValue(),
      '화면 저장 동작 확인',
    );
    await page.getByLabel('진행 요약', { exact: true }).fill('사용자가 편집 중인 요약');
    await page.evaluate(() =>
      window.goalFixture.externalCheckpoint('외부에서 바뀐 최신 요약', '검사 결과 다시 확인'),
    );
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    const reloadCheckpoint = page.getByRole('button', {
      name: '최신 체크포인트 불러오기',
      exact: true,
    });
    await reloadCheckpoint.waitFor();
    assert.equal(
      await page.getByLabel('진행 요약', { exact: true }).inputValue(),
      '사용자가 편집 중인 요약',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Checkpoint 저장', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-checkpoint-conflict.png'),
      fullPage: true,
    });
    await reloadCheckpoint.click();
    assert.equal(
      await page.getByLabel('진행 요약', { exact: true }).inputValue(),
      '외부에서 바뀐 최신 요약',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Checkpoint 저장', exact: true }).isDisabled(),
      false,
    );
    await page.getByRole('button', { name: 'Checkpoint 저장', exact: true }).click();
    await page.getByText('Goal을 갱신했습니다.', { exact: true }).waitFor();
    const checkpointCall = await page.evaluate(() =>
      window.goalFixture.calls.find(
        (call) => call.type === 'update' && call.input.action === 'checkpoint',
      ),
    );
    assert.equal(checkpointCall.input.expected_revision, 3);
    assert.equal(checkpointCall.input.summary, '외부에서 바뀐 최신 요약');
    await page.evaluate(() => window.goalFixture.setGoalState('active', false));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page
      .getByText('프로젝트 root가 달라져 이 Goal을 재개할 수 없습니다.', { exact: true })
      .waitFor();
    assert.equal(await continueButton.count(), 0);
    await page.evaluate(() => window.goalFixture.setGoalState('interrupted'));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await continueButton.waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Checkpoint 저장', exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => window.goalFixture.setGoalState('active'));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('button', { name: '완료 판정', exact: true }).waitFor();

    const fileOnlyCreate = await page.evaluate(
      () =>
        window.goalFixture.calls.find(
          (call) => call.type === 'update' && call.input.action === 'create',
        ).input,
    );
    assert.deepEqual(fileOnlyCreate.tracked_paths, ['src/app.ts']);
    assert.equal(fileOnlyCreate.max_executions, 0);
    await page.getByRole('button', { name: '새 Goal', exact: true }).click();
    await page.getByText('직접 입력 (고급)', { exact: true }).click();
    assert.equal(await page.getByLabel('목표', { exact: true }).inputValue(), '');
    assert.equal(
      await page.getByLabel('추적할 파일 경로, 한 줄에 하나', { exact: true }).inputValue(),
      '',
    );
    await page.getByLabel('목표', { exact: true }).fill('페이지 검증을 마치기');
    await page.getByLabel('작업 범위', { exact: true }).fill('프로젝트 fixture');
    await page
      .getByLabel('추적할 파일 경로, 한 줄에 하나', { exact: true })
      .fill('src/app.ts\npackage.json');
    await page.getByLabel('상대 파일 경로', { exact: true }).fill('src/app.ts');
    await page.getByRole('button', { name: '필수 기준 추가', exact: true }).click();

    await page.getByLabel('합격 기준', { exact: true }).selectOption('check');
    assert.deepEqual(
      await page.getByLabel('Root에 등록된 script').locator('option').allTextContents(),
      ['test', 'build'],
    );
    await page.getByRole('button', { name: '필수 기준 추가', exact: true }).click();
    await page.getByLabel('합격 기준', { exact: true }).selectOption('browser');
    await page.getByLabel('Selector', { exact: true }).fill('[data-testid=result]');
    await page.getByLabel('기대 문구', { exact: true }).fill('저장 완료');
    await page.getByRole('button', { name: '필수 기준 추가', exact: true }).click();
    await page.getByLabel('다음 단계', { exact: true }).fill('ChatGPT에서 수정 결과 검토');
    await page.getByRole('button', { name: 'Goal 저장', exact: true }).click();
    await page.getByRole('heading', { name: '페이지 검증을 마치기' }).waitFor();
    await page.getByRole('button', { name: '완료 판정', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Required evidence is stale' }).waitFor();
    await openGoalDetails('goal-criteria-details');
    await page
      .locator('.criteria li')
      .first()
      .getByRole('button', { name: '검증', exact: true })
      .click();
    await page.locator('.criteria li').first().getByText('통과', { exact: true }).waitFor();
    await page
      .locator('.criteria li')
      .nth(1)
      .getByRole('button', { name: '검증', exact: true })
      .click();
    await page.getByText('검사를 대기열에 넣었습니다. 실행 종료 후 결과를 확인합니다.').waitFor();
    await page
      .locator('.criteria li')
      .nth(2)
      .getByRole('button', { name: '검증', exact: true })
      .click();
    await page.getByText('검사를 대기열에 넣었습니다. 실행 종료 후 결과를 확인합니다.').waitFor();
    await openGoalDetails('goal-advanced-details');
    await page.getByLabel('진행 요약', { exact: true }).fill('파일 확인 완료, 검사 대기');
    await page.getByLabel('직접 이어갈 다음 단계', { exact: true }).fill('검사 완료 후 결과 확인');
    await page.getByRole('button', { name: 'Checkpoint 저장', exact: true }).click();
    await page.getByRole('button', { name: '일시 정지', exact: true }).click();
    await page.getByRole('button', { name: '1시간 재개', exact: true }).waitFor();
    assert.equal(
      await page
        .locator('.criteria li')
        .first()
        .getByRole('button', { name: '검증', exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(() => window.goalFixture.externalBudget(200));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="실행 한도"]')?.value === '200',
    );
    await page.getByLabel('실행 한도', { exact: true }).fill('80');
    await page.evaluate(() => window.goalFixture.externalBudget(250));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.locator('.meta').filter({ hasText: '0/250회 실행' }).waitFor();
    assert.equal(await page.getByLabel('실행 한도', { exact: true }).inputValue(), '80');
    await page.getByRole('button', { name: '1시간 재개', exact: true }).click();
    await page.getByRole('button', { name: '완료 판정', exact: true }).waitFor();
    await page.screenshot({ path: join(evidenceDirectory, 'goal-active.png'), fullPage: true });
    await page.getByRole('button', { name: '일시 정지', exact: true }).click();
    await page.getByRole('button', { name: '1시간 재개', exact: true }).waitFor();
    await page.getByLabel('실행 한도', { exact: true }).fill('0');
    await page.getByRole('button', { name: '1시간 재개', exact: true }).click();
    await page.locator('.meta').filter({ hasText: '실행 제한 없음' }).waitFor();
    const calls = await page.evaluate(() => window.goalFixture.calls);
    const create = calls.find(
      (call) =>
        call.type === 'update' &&
        call.input.action === 'create' &&
        call.input.criteria.length === 3,
    ).input;
    assert.equal(create.criteria.length, 3);
    assert.deepEqual(create.tracked_paths, ['src/app.ts', 'package.json']);
    const execution = calls.find((call) => call.type === 'exec').input;
    assert.equal(execution.goal_id, 'goal_00000000-0000-4000-8000-000000000000');
    assert.equal(execution.criterion_id, create.criteria[1].criterion_id);
    assert.deepEqual(execution.operation, { kind: 'node_script', script: 'test' });
    assert.deepEqual(calls.filter((call) => call.type === 'exec')[1].input.operation, {
      kind: 'browser',
      action: {
        kind: 'assert',
        expectation: { kind: 'text', selector: '[data-testid=result]', text: '저장 완료' },
      },
    });
    assert.equal(
      calls.find((call) => call.type === 'update' && call.input.action === 'resume').input
        .max_executions,
      80,
    );
    assert.equal(
      calls.filter((call) => call.type === 'update' && call.input.action === 'resume').at(-1).input
        .max_executions,
      0,
    );
    assert.equal(
      calls.every((call) => !('workspace_binding' in call.input)),
      true,
    );
    await page.evaluate(() => window.goalFixture.unblockCompletion());
    await page.getByRole('button', { name: '완료 판정', exact: true }).click();
    await page.locator('.goal-heading').getByText('완료', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('goal-chat-continue').count(), 0);
    assert.equal(await page.getByRole('button', { name: '완료 판정', exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
    await page.setViewportSize({ width: 560, height: 720 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-completed-compact.png'),
      fullPage: true,
    });
    const deletionCount = await page.evaluate(
      () => window.goalFixture.calls.filter((call) => call.input.action === 'delete').length,
    );
    await page.getByRole('button', { name: '이 기록 삭제', exact: true }).click();
    await page.getByRole('button', { name: '기록 유지', exact: true }).click();
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.input.action === 'delete').length,
      ),
      deletionCount,
    );
    await page.getByRole('button', { name: '이 기록 삭제', exact: true }).click();
    await page.getByRole('button', { name: 'Goal 기록 삭제', exact: true }).click();
    await page.getByText('종료된 Goal 기록을 삭제했습니다.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.goalFixture.getGoals().length), 0);

    await page.evaluate(() => window.goalFixture.seedHistory());
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('heading', { name: 'History Goal 0', exact: true }).waitFor();
    await page.getByText('저장된 Goal 37개', { exact: true }).waitFor();
    await openGoalDetails('goal-advanced-details');
    await page.locator('.meta').filter({ hasText: '누적 140회 · 실행 제한 없음' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '이 기록 삭제', exact: true }).count(), 0);
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
    await page.getByRole('heading', { name: 'History Goal 7', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.goalFixture.calls.some((call) => call.type === 'read' && call.input.offset === 7),
      ),
      true,
    );
    await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
    await page.getByRole('heading', { name: 'History Goal 0', exact: true }).waitFor();
    await page.getByRole('button', { name: '완료 기록 정리', exact: true }).click();
    await page.getByRole('button', { name: '기록 유지', exact: true }).click();
    assert.equal(await page.evaluate(() => window.goalFixture.getGoals().length), 37);
    await page.getByRole('button', { name: '완료 기록 정리', exact: true }).click();
    await page.getByRole('button', { name: '완료·취소 기록 정리', exact: true }).click();
    await page.getByText('완료·취소 기록 14개를 정리했습니다.', { exact: true }).waitFor();
    await page.getByText('저장된 Goal 23개', { exact: true }).waitFor();
    const remainingGoals = await page.evaluate(() => window.goalFixture.getGoals());
    assert.equal(remainingGoals.length, 23);
    assert.equal(
      remainingGoals.every((goal) => ['active', 'paused', 'interrupted'].includes(goal.state)),
      true,
    );
    assert.equal(remainingGoals.filter((goal) => goal.state === 'active').length, 8);
    assert.equal(remainingGoals.filter((goal) => goal.state === 'paused').length, 8);
    assert.equal(remainingGoals.filter((goal) => goal.state === 'interrupted').length, 7);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-history-cleanup-compact.png'),
      fullPage: true,
    });
    // Reset is a separate explicit action after history pagination/cleanup.
    // Everything below uses this fixture's records, never a live daemon.
    await page.evaluate(() => window.goalFixture.seedResetEvidence());
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('heading', { name: 'History Goal 0', exact: true }).waitFor();
    await page.locator('.goal-heading').getByText('일시 정지', { exact: true }).waitFor();
    const resetStart = page.getByTestId('goal-reset-start');
    const resetConfirmation = page.getByTestId('goal-reset-confirmation');
    const resetConfirm = page.getByTestId('goal-reset-confirm');
    const resetCallsBefore = await page.evaluate(
      () => window.goalFixture.calls.filter((call) => call.input.action === 'reset').length,
    );
    const beforeCancelledReset = await page.evaluate(() => window.goalFixture.getGoals()[0]);
    await resetStart.click();
    await resetConfirmation.waitFor();
    assert.equal(await resetConfirm.isDisabled(), false);
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.input.action === 'reset').length,
      ),
      resetCallsBefore,
    );
    await resetConfirmation.getByRole('button', { name: '기록 유지', exact: true }).click();
    assert.equal(await resetConfirmation.count(), 0);
    assert.deepEqual(
      await page.evaluate(() => window.goalFixture.getGoals()[0]),
      beforeCancelledReset,
    );

    await resetStart.click();
    await resetConfirmation.waitFor();
    await page.evaluate(() =>
      window.goalFixture.externalCheckpoint('확인 중 외부에서 갱신한 요약', '새로 확인할 단계'),
    );
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await resetConfirmation
      .getByText('기록이 갱신되었습니다. 닫은 뒤 최신 기록을 확인해 주세요.', { exact: true })
      .waitFor();
    assert.equal(await resetConfirm.isDisabled(), true);
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.input.action === 'reset').length,
      ),
      resetCallsBefore,
    );
    await resetConfirmation.getByRole('button', { name: '기록 유지', exact: true }).click();

    await resetStart.click();
    await resetConfirmation.waitFor();
    await page.evaluate(() => window.goalFixture.switchWorkspace(true));
    await page
      .getByRole('heading', { name: 'Other Goal fixture', exact: true })
      .waitFor({ state: 'attached' });
    assert.equal(await resetConfirmation.count(), 0);
    assert.equal(
      await page.evaluate(
        () => window.goalFixture.calls.filter((call) => call.input.action === 'reset').length,
      ),
      resetCallsBefore,
    );
    await page.evaluate(() => window.goalFixture.switchWorkspace(false));
    await page.getByRole('heading', { name: 'History Goal 0', exact: true }).waitFor();
    assert.equal(await resetConfirmation.count(), 0);

    await page.evaluate(() => {
      window.goalFixture.seedResetEvidence();
      window.goalFixture.setResetOwnedWork(true);
    });
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="goal-reset-start"]')?.disabled === true,
    );
    assert.equal(await resetStart.isDisabled(), true);
    assert.equal(await resetConfirmation.count(), 0);
    await page.evaluate(() => window.goalFixture.setResetOwnedWork(false));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="goal-reset-start"]')?.disabled === false,
    );

    await openGoalDetails('goal-advanced-details');
    await page.getByLabel('진행 요약', { exact: true }).fill('초기화할 미저장 입력');
    const beforeReset = await page.evaluate(() => ({
      goal: window.goalFixture.getGoals()[0],
      count: window.goalFixture.getGoals().length,
      executions: window.goalFixture.calls.filter((call) => call.type === 'exec').length,
      resumes: window.goalFixture.calls.filter((call) => call.input.action === 'resume').length,
    }));
    await resetStart.click();
    await resetConfirmation
      .getByText('아직 저장하지 않은 진행 요약 입력도 비웁니다.', { exact: true })
      .waitFor();
    await resetConfirm.click();
    await page
      .getByText('검증 기록을 비웠습니다. ChatGPT에서 이어하기로 현재 파일부터 다시 점검하세요.', {
        exact: true,
      })
      .waitFor();
    assert.equal(await resetConfirmation.count(), 0);
    const afterReset = await page.evaluate((goalId) => {
      const records = window.goalFixture.getGoals();
      return {
        goal: records.find((goal) => goal.goal_id === goalId),
        count: records.length,
        resets: window.goalFixture.calls.filter((call) => call.input.action === 'reset'),
        executions: window.goalFixture.calls.filter((call) => call.type === 'exec').length,
        resumes: window.goalFixture.calls.filter((call) => call.input.action === 'resume').length,
      };
    }, beforeReset.goal.goal_id);
    assert.equal(afterReset.count, beforeReset.count);
    assert.equal(afterReset.resets.length, resetCallsBefore + 1);
    assert.deepEqual(afterReset.resets.at(-1).input, {
      workspace_id: beforeReset.goal.workspace_id,
      goal_id: beforeReset.goal.goal_id,
      expected_revision: beforeReset.goal.revision,
      action: 'reset',
    });
    for (const field of [
      'goal_id',
      'workspace_id',
      'objective',
      'scope',
      'tracked_paths',
      'created_at',
      'deadline_at',
      'max_executions',
      'executions_used',
    ])
      assert.deepEqual(afterReset.goal[field], beforeReset.goal[field], field);
    assert.equal(afterReset.goal.state, 'paused');
    assert.equal(afterReset.goal.revision, beforeReset.goal.revision + 1);
    assert.equal(afterReset.goal.evidence_valid, false);
    assert.deepEqual(afterReset.goal.receipts, []);
    assert.deepEqual(
      afterReset.goal.criteria,
      beforeReset.goal.criteria.map((criterion) => ({
        ...criterion,
        status: 'pending',
        evidence: null,
      })),
    );
    assert.deepEqual(afterReset.goal.checkpoint, {
      ...beforeReset.goal.checkpoint,
      summary: '',
      next_step: '',
    });
    assert.equal(afterReset.executions, beforeReset.executions);
    assert.equal(afterReset.resumes, beforeReset.resumes);
    assert.equal(await page.getByLabel('진행 요약', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('직접 이어갈 다음 단계', { exact: true }).inputValue(), '');
    await page.getByTestId('goal-chat-continue').waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-reset-paused-compact.png'),
      fullPage: true,
    });
    const finalGoalCalls = await page.evaluate(() => window.goalFixture.calls);
    await page.evaluate(() => {
      const url = 'http://127.0.0.1:5173/health';
      const readiness = {
        url,
        method: 'HEAD',
        expected_status: 200,
        ready: true,
        attempts_used: 2,
        status_code: 200,
        duration_ms: 110,
        failure: null,
        attempts: [
          { attempt: 1, status_code: 503, duration_ms: 5, failure: 'unexpected_status' },
          { attempt: 2, status_code: 200, duration_ms: 5, failure: null },
        ],
      };
      window.goalFixture.jobs = [
        {
          job_id: 'exec_11111111-1111-4111-8111-111111111111',
          workspace_id: `ws_${'a'.repeat(24)}`,
          workspace_name: 'Goal fixture',
          operation: {
            kind: 'readiness',
            url,
            expected_status: 200,
            attempts: 3,
            interval_ms: 100,
            request_timeout_ms: 1000,
          },
          cwd: '.',
          state: 'succeeded',
          command: `HEAD ${url}`,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          exit_code: 0,
          error_code: null,
          message: 'Project execution succeeded.',
          used_network: true,
          truncated: false,
          duration_ms: 110,
          output: JSON.stringify(readiness),
          readiness_result: readiness,
        },
      ];
    });
    await page.getByRole('button', { name: '작업기록', exact: true }).click();
    await page
      .getByText('서버 준비 확인 · http://127.0.0.1:5173/health', { exact: true })
      .waitFor();
    await page.getByText('준비됨 · HTTP 200 · 2회 확인', { exact: true }).waitFor();
    await page.locator('.execution-output').filter({ hasText: '"attempts_used":2' }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: join(evidenceDirectory, 'readiness-completed-compact.png'),
      fullPage: true,
    });
    await page.evaluate(() => {
      const job = window.goalFixture.jobs[0];
      job.job_id = 'exec_22222222-2222-4222-8222-222222222222';
      job.operation = { kind: 'environment' };
      job.command = 'environment inspection';
      job.readiness_result = undefined;
      job.environment_result = { issues: ['lockfile_missing', 'runtime_missing'] };
      job.output = JSON.stringify({
        issues: ['lockfile_missing', 'runtime_missing'],
        browser: { launch_verified: false },
      });
    });
    await page.getByText('실행 환경 확인 · .', { exact: true }).waitFor();
    await page.getByRole('button').filter({ hasText: '실행 환경 확인 · .' }).click();
    await page
      .getByText('확인이 필요한 항목 2개 · 버전·실행 검증은 별도', { exact: true })
      .waitFor();
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: join(evidenceDirectory, 'environment-completed-compact.png'),
      fullPage: true,
    });

    await page.goto(fixtureUrl + '&fixtureLocale=en');
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Start with what you want to do', exact: true })
      .waitFor();
    await page
      .getByTestId('goal-chat-request')
      .fill('Improve the settings page and verify persistence.');
    assert.ok(
      (await page.getByTestId('goal-chat-create-preview').inputValue()).startsWith(
        'Register this task as a Goal',
      ),
    );
    assert.equal(await page.getByLabel('Objective', { exact: true }).isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: join(evidenceDirectory, 'goal-natural-language-en-compact.png'),
      fullPage: true,
    });
    console.log(
      JSON.stringify({
        passed: true,
        bridgeFixture: true,
        evidenceDirectory,
        actions: finalGoalCalls
          .filter((call) => call.type === 'update')
          .map((call) => call.input.action),
        goalLinkedCheck: true,
        readinessHistory: true,
        environmentHistory: true,
        fileCriterionTrackedAutomatically: true,
        bindingInRenderer: false,
        naturalLanguageRequest: true,
        copyDoesNotRegisterOrExecute: true,
        clipboardFailureFallback: true,
        workspaceSwitchClearsDraft: true,
        staleCopySuppressed: true,
        sameGoalContinuation: true,
        checkpointConflictProtected: true,
        koreanAndEnglish: true,
        unlimitedExecutionBudget: true,
        resumeBudgetDraftProtected: true,
        paginatedGoalHistory: true,
        finishedRecordCleanupPreservesActive: true,
        deletionRequiresConfirmation: true,
        collapsedGoalDetails: true,
        resetRequiresConfirmation: true,
        resetRevisionGuard: true,
        resetWorkspaceGuard: true,
        resetOwnedWorkGuard: true,
        resetPreservesTaskAndUsage: true,
        resetDoesNotExecute: true,
        pageErrors,
      }),
    );
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
