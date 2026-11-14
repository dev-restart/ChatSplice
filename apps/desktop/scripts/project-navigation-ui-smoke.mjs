/* global localStorage, window, structuredClone, document, URLSearchParams */
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

// Exercises the actual built renderer against an isolated owner bridge. No live
// daemon, native ChatGPT view, account, Project, message or source file is touched.
// Native MRU, URL navigation and unsaved editor preservation have separate main
// process tests; this fixture proves renderer dispatch, errors and layout only.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rendererRoot = resolve(
  process.env.CHATSPLICE_RENDERER_DIR ?? join(projectRoot, 'apps/desktop/dist/renderer'),
);

function installFixture() {
  const locale = new URLSearchParams(window.location.search).get('fixtureLocale') ?? 'ko';
  localStorage.setItem('chatsplice.ui-locale.v1', locale);
  const now = new Date().toISOString();
  const workspaces = [
    {
      workspace_id: `ws_${'a'.repeat(24)}`,
      display_name:
        'demo-project · 보안 진단과 실행 환경을 함께 점검하고 결과를 한곳에 모아 보여 주는 아주 긴 이름의 프로젝트',
      root_path: '/fixture/demo-project',
      kind: 'user',
      created_at: now,
    },
    {
      workspace_id: `ws_${'b'.repeat(24)}`,
      display_name: 'demo-audio · 다국어 음성과 사용자 인터페이스 개선',
      root_path: '/fixture/demo-audio',
      kind: 'user',
      created_at: now,
    },
  ];
  const [first, second] = workspaces;
  const tabs = [
    {
      chatgpt_tab_id: `tab_${'1'.repeat(24)}`,
      workspace_id: first.workspace_id,
      label: 'Earlier security investigation',
      project_instructions_confirmed: true,
    },
    {
      chatgpt_tab_id: `tab_${'2'.repeat(24)}`,
      workspace_id: first.workspace_id,
      label: 'Latest security investigation',
      project_instructions_confirmed: true,
    },
    {
      chatgpt_tab_id: `tab_${'3'.repeat(24)}`,
      workspace_id: second.workspace_id,
      label: 'Voice development chat',
      project_instructions_confirmed: true,
    },
  ];
  const panel = {
    workspace_id: second.workspace_id,
    console_open: false,
    files_open: false,
    files_width: 340,
    console_height: 300,
  };
  const state = {
    workspaces,
    tabs,
    panel,
    calls: [],
    activeTabId: tabs[2].chatgpt_tab_id,
    recentByWorkspace: {
      [first.workspace_id]: tabs[1].chatgpt_tab_id,
      [second.workspace_id]: tabs[2].chatgpt_tab_id,
    },
    foreground: 'editor',
    editorDraft: 'Unsaved source draft stays owned by the main process.',
    nextCreateError: null,
    nextSelectError: null,
    deferNextCreate: false,
    deferNextSelect: false,
    finishDeferredSelect: null,
    finishDeferredCreate: null,
    nextTabOrdinal: 4,
    holdTabRefresh: false,
    pendingTabRefreshes: [],
  };
  const resultFor = (activeTabId = state.activeTabId, entries = tabs) => ({
    tabs: structuredClone(entries).map((tab) => ({
      ...tab,
      active: tab.chatgpt_tab_id === activeTabId,
    })),
    active_tab_id: activeTabId,
  });
  const activate = (tab) => {
    state.activeTabId = tab.chatgpt_tab_id;
    panel.workspace_id = tab.workspace_id;
    state.foreground = 'chatgpt';
    if (tab.workspace_id !== null) state.recentByWorkspace[tab.workspace_id] = tab.chatgpt_tab_id;
    return resultFor();
  };
  const forbidden = (action) => async (input) => {
    state.calls.push({ action, input: structuredClone(input) });
    throw new Error(`fixture_forbidden_${action}`);
  };
  const status = {
    runtime_identity: { status: 'verified' },
    daemon: {
      healthy: true,
      ready: true,
      read_only_mode: false,
      mcp_app_name: 'ChatSplice MCP',
      auto_attach_workspace_ids: [],
      execution_jobs: [
        {
          job_id: 'exec_11111111-1111-4111-8111-111111111111',
          workspace_id: first.workspace_id,
          workspace_name: first.display_name,
          operation: { kind: 'environment' },
          cwd: '.',
          state: 'succeeded',
          command: 'environment inspection',
          created_at: now,
          started_at: now,
          finished_at: now,
          exit_code: 0,
          error_code: null,
          message: 'Fixture execution completed.',
          used_network: false,
          truncated: false,
          duration_ms: 30,
        },
      ],
      latest_mcp_activities: [
        {
          activity_id: 'fixture-navigation-read',
          workspace_id: first.workspace_id,
          workspace_name: first.display_name,
          tool: 'fs.read',
          state: 'succeeded',
          source: 'direct_mcp',
          started_at: now,
          completed_at: now,
          summary: 'Read a fixture source file.',
        },
      ],
      tunnel: {
        mode: 'external',
        ready: true,
        error_code: null,
        configuration: null,
        detected_tunnel_id: null,
        detected_executable_path: null,
      },
    },
    chatgpt_login_confirmed: true,
    credential_store: { available: true, configured: true, error_code: null },
  };
  window.projectNavigationFixture = state;
  window.chatsplice = {
    getStatus: async () => structuredClone(status),
    listWorkspaces: async () => ({ workspaces: structuredClone(workspaces), count: 2 }),
    listWorkspaceReferences: async () => ({ references: [], count: 0 }),
    listChatGptTabs: async () => {
      // Navigation must update the rendered selection without waiting for the
      // two-second background refresh. The smoke holds those subsequent reads.
      if (state.holdTabRefresh) {
        const snapshot = resultFor();
        return new Promise((resolveRefresh) => {
          state.pendingTabRefreshes.push({ snapshot, resolveRefresh });
        });
      }
      return resultFor();
    },
    getPanelState: async () => structuredClone(panel),
    setPanelState: async (next) => {
      state.calls.push({ action: 'setPanelState', input: structuredClone(next) });
      Object.assign(panel, next);
      return structuredClone(panel);
    },
    getSidebarLayout: async () => ({ width: 300, collapsed: false }),
    setModalOverlay: async () => undefined,
    automateProjectInstructionsUpdate: async (input) => {
      state.calls.push({ action: 'automateProjectInstructionsUpdate', input });
      if (state.homeCheckFails) {
        return {
          automation: { status: 'needs_user', reason: 'needs_manual_merge', message: 'Other' },
          tabs: resultFor(),
        };
      }
      return {
        automation: { status: 'completed', reason: 'instructions_current', message: 'Current' },
        tabs: resultFor(),
      };
    },
    updateChatGptTab: async (input) => {
      state.calls.push({ action: 'updateChatGptTab', input: structuredClone(input) });
      const tab = tabs.find((entry) => entry.chatgpt_tab_id === input.chatgpt_tab_id);
      if (tab === undefined) throw new Error('fixture_tab_missing');
      Object.assign(tab, input);
      return resultFor();
    },
    selectWorkspace: async (workspaceId) => {
      state.calls.push({ action: 'selectWorkspace', workspaceId });
      if (state.nextSelectError !== null) {
        const error = state.nextSelectError;
        state.nextSelectError = null;
        throw new Error(error);
      }
      const selected = tabs.find(
        (tab) => tab.chatgpt_tab_id === state.recentByWorkspace[workspaceId],
      );
      if (selected === undefined) throw new Error('fixture_tab_missing');
      if (state.deferNextSelect) {
        state.deferNextSelect = false;
        return new Promise((resolveSelection) => {
          state.finishDeferredSelect = () => {
            state.finishDeferredSelect = null;
            resolveSelection(activate(selected));
          };
        });
      }
      return activate(selected);
    },
    activateChatGptTab: async (tabId) => {
      state.calls.push({ action: 'activateChatGptTab', tabId });
      const selected = tabs.find((tab) => tab.chatgpt_tab_id === tabId);
      if (selected === undefined) throw new Error('fixture_tab_missing');
      return activate(selected);
    },
    createChatGptTab: async (input) => {
      state.calls.push({ action: 'createChatGptTab', input: structuredClone(input) });
      if (state.nextCreateError !== null) {
        const error = state.nextCreateError;
        state.nextCreateError = null;
        throw new Error(error);
      }
      const tab = {
        chatgpt_tab_id: `tab_${String(state.nextTabOrdinal++).padStart(24, '0')}`,
        workspace_id: input.workspace_id,
        label: input.label ?? 'Fixture chat',
        project_instructions_confirmed: input.project_chat === true,
      };
      if (state.deferNextCreate) {
        state.deferNextCreate = false;
        const staleResult = resultFor(tab.chatgpt_tab_id, [...tabs, tab]);
        return new Promise((resolveResult) => {
          // The owner remains on the newer selection. Return an obsolete
          // renderer response deliberately to test its request revision guard.
          state.finishDeferredCreate = () => {
            state.finishDeferredCreate = null;
            resolveResult(staleResult);
          };
        });
      }
      tabs.push(tab);
      return activate(tab);
    },
    automateChatGptProject: forbidden('automateChatGptProject'),
    openWorkspace: forbidden('openWorkspace'),
    registerWorkspace: forbidden('registerWorkspace'),
    closeEditorTab: forbidden('closeEditorTab'),
    closeChatGptTab: forbidden('closeChatGptTab'),
  };
}

const fixtureScript = `(${installFixture.toString()})();`;
const bootstrap = '<script src="/project-navigation-fixture.js"></script>';
const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/project-navigation-fixture.js') {
      response
        .writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
        .end(fixtureScript);
      return;
    }
    const path = resolve(rendererRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!path.startsWith(rendererRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    let content = await readFile(path);
    if (extname(path) === '.html')
      content = Buffer.from(content.toString('utf8').replace('</head>', bootstrap + '</head>'));
    response
      .writeHead(200, {
        'content-type': contentTypes[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

if (process.argv.includes('--serve')) {
  console.log(
    JSON.stringify({
      fixtureUrl,
      rendererRoot,
      bridgeFixture: true,
      nativeDaemon: false,
      nativeChatGptNavigation: false,
      fixtureState: 'window.projectNavigationFixture',
    }),
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
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-project-navigation-ui-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 300, height: 900 }, locale: 'ko-KR' });
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    const externalRequests = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === new URL(fixtureUrl).origin)
        await route.continue();
      else {
        externalRequests.push(route.request().url());
        await route.abort();
      }
    });

    const names = [
      'demo-project · 보안 진단과 실행 환경을 함께 점검하고 결과를 한곳에 모아 보여 주는 아주 긴 이름의 프로젝트',
      'demo-audio · 다국어 음성과 사용자 인터페이스 개선',
    ];
    const ids = [`ws_${'a'.repeat(24)}`, `ws_${'b'.repeat(24)}`];
    const messages = {
      ko: {
        unavailable:
          'ChatGPT에서 이 프로젝트의 홈 화면을 한 번 열어 주세요. 그 뒤로는 위치를 기억해요.',
        ambiguous:
          '이 폴더에 연결된 ChatGPT 프로젝트가 여러 개예요. 프로젝트 설정에서 연결을 확인해 주세요.',
      },
      en: {
        unavailable:
          'Open this project’s home page in ChatGPT once. ChatSplice remembers it after that.',
        ambiguous:
          'This folder is linked to more than one ChatGPT project. Check the connection in project settings.',
      },
    };
    const ownerSnapshot = () =>
      page.evaluate(() => {
        const state = window.projectNavigationFixture;
        return {
          workspace: state.panel.workspace_id,
          tab: state.activeTabId,
          tabs: state.tabs.length,
          projects: state.workspaces.length,
          foreground: state.foreground,
          draft: state.editorDraft,
        };
      });
    const assertNoAutomation = async () => {
      assert.deepEqual(
        await page.evaluate(() =>
          window.projectNavigationFixture.calls.filter((call) =>
            [
              'automateChatGptProject',
              'openWorkspace',
              'registerWorkspace',
              'closeEditorTab',
              'closeChatGptTab',
            ].includes(call.action),
          ),
        ),
        [],
      );
    };
    const checkLayout = async (locale) => {
      const geometry = await page.locator('.project-row').evaluateAll((rows) => {
        const bounds = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        };
        return rows.map((row) => {
          const main = row.querySelector('.project-main');
          const name = row.querySelector('.project-copy strong');
          return {
            row: bounds(row),
            main: bounds(main),
            name: bounds(name),
            nameTruncated: name.scrollWidth > name.clientWidth,
            nameOverflow: window.getComputedStyle(name).textOverflow,
            indicators: bounds(row.querySelector('.project-indicators')),
            statusText: row.querySelector('.sr-only').textContent.trim(),
            actions: Array.from(row.querySelectorAll('.project-actions > button')).map(bounds),
          };
        });
      });
      assert.equal(geometry.length, 2);
      // Rows no longer reserve space for action buttons, but the longest fixture
      // name still has to truncate with an ellipsis instead of overflowing.
      assert.ok(
        geometry.some((row) => row.nameTruncated),
        `${locale}: fixture exercises long-name truncation`,
      );
      for (const row of geometry) {
        assert.ok(row.row.x >= 0 && row.row.right <= 301, `${locale}: row fits 300px sidebar`);
        assert.ok(row.name.width >= 110, `${locale}: project name retains usable width`);
        assert.equal(row.nameOverflow, 'ellipsis');
        assert.ok(row.name.right <= row.main.right + 1);
        assert.ok(row.statusText.length > 0, `${locale}: status stays available to assistive tech`);
        // Hover actions overlay the right edge of the row and never overlap each other.
        let previousRight =
          row.row.right - 4 - row.actions.reduce((sum, a) => sum + a.width, 0) - 2;
        for (const action of row.actions) {
          assert.ok(action.x >= previousRight - 2, `${locale}: project actions do not overlap`);
          assert.ok(action.width >= 26 && action.height >= 28, `${locale}: actions stay usable`);
          assert.ok(action.right <= row.row.right + 1);
          previousRight = action.right;
        }
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.screenshot({
        path: join(evidenceDirectory, `project-sidebar-300-${locale}.png`),
        fullPage: true,
      });
      return geometry;
    };
    const layouts = {};
    for (const locale of ['ko', 'en']) {
      await page.goto(`${fixtureUrl}?fixtureLocale=${locale}`);
      const row = (index) =>
        page.locator('.project-group').filter({
          has: page.getByRole('button', {
            name:
              locale === 'ko'
                ? `${names[index]} ChatGPT Project 열기`
                : `Open ChatGPT Project for ${names[index]}`,
            exact: true,
          }),
        });
      const open = (index) => row(index).locator('.project-main');
      const newChat = (index) => row(index).getByTestId('project-new-chat');
      const waitSelected = async (index) => {
        await page.waitForFunction(
          (name) => {
            const selected = Array.from(
              document.querySelectorAll('.project-group.selected .project-copy strong'),
            );
            return name === null
              ? selected.length === 0
              : selected.length === 1 && selected[0].textContent === name;
          },
          index === null ? null : names[index],
          { timeout: 1_000 },
        );
      };
      await newChat(0).waitFor();
      await waitSelected(1);
      await page.evaluate(() => {
        window.projectNavigationFixture.holdTabRefresh = true;
      });
      layouts[locale] = await checkLayout(locale);

      // Hovering shows the path card inside the sidebar; the menu offers the
      // few project actions and closes with Escape without navigating anywhere.
      const callsBeforeChrome = await page.evaluate(
        () => window.projectNavigationFixture.calls.length,
      );
      await row(0).locator('.project-row').hover();
      const card = page.locator('.project-hover-card');
      await card.waitFor();
      assert.equal(await card.getByText('/fixture/demo-project', { exact: true }).count(), 1);
      const cardBox = await card.boundingBox();
      assert.ok(cardBox.x >= 0 && cardBox.x + cardBox.width <= 301, `${locale}: card fits sidebar`);
      await row(0).locator('.project-details-button').click();
      await page.locator('.project-menu').waitFor();
      assert.equal(await page.locator('.project-hover-card').count(), 0);
      assert.deepEqual(
        await page.locator('.project-menu [role="menuitem"]').allInnerTexts(),
        locale === 'ko'
          ? ['프로젝트 설정', '이름 변경', 'Finder에서 보기', '최근 실행', 'ChatSplice에서 제거']
          : [
              'Project settings',
              'Rename',
              'Show in Finder',
              'Recent executions',
              'Remove from ChatSplice',
            ],
      );
      await page.keyboard.press('Escape');
      await page.locator('.project-menu').waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(() => window.projectNavigationFixture.calls.length),
        callsBeforeChrome,
        `${locale}: hover and menu never navigate`,
      );
      await page.mouse.move(900, 400);

      // Dragging a row reorders the list and saves it (reload restore is a unit test); Alt+Arrow
      // moves the focused project without a mouse and keeps focus on it.
      const listedNames = () => page.locator('.project-group .project-copy strong').allInnerTexts();
      assert.deepEqual(await listedNames(), names, `${locale}: starts in registration order`);
      const callsBeforeDrag = await page.evaluate(
        () => window.projectNavigationFixture.calls.length,
      );
      await row(1)
        .locator('.project-row')
        .dragTo(row(0).locator('.project-row'), { targetPosition: { x: 40, y: 4 } });
      assert.deepEqual(await listedNames(), [names[1], names[0]], `${locale}: drag reorders`);
      assert.deepEqual(
        JSON.parse(await page.evaluate(() => localStorage.getItem('chatsplice.project-order.v1'))),
        ids.slice().reverse(),
      );
      assert.equal(
        await page.evaluate(() => window.projectNavigationFixture.calls.length),
        callsBeforeDrag,
        `${locale}: reordering never navigates`,
      );
      await open(1).focus();
      await page.keyboard.press('Alt+ArrowDown');
      assert.deepEqual(await listedNames(), [names[0], names[1]], `${locale}: keyboard reorders`);
      assert.equal(
        await page.evaluate(
          () => document.activeElement?.closest('.project-group')?.dataset.projectId,
        ),
        ids[1],
        `${locale}: focus stays on the moved project`,
      );
      await page.mouse.move(900, 400);

      // The bridge owns MRU. The renderer must request the exact selected
      // workspace, including when a source editor or another project is active.
      await open(0).click();
      await waitSelected(0);
      await page.waitForFunction(
        () => window.projectNavigationFixture.activeTabId === `tab_${'2'.repeat(24)}`,
      );
      assert.ok((await row(0).getAttribute('class')).includes('selected'));
      assert.equal((await ownerSnapshot()).foreground, 'chatgpt');
      assert.equal((await ownerSnapshot()).tabs, 3);
      await open(1).click();
      await waitSelected(1);
      await open(0).click();
      await waitSelected(0);
      await open(0).click(); // Re-clicking the current project is also an action.
      await waitSelected(0);
      const selections = await page.evaluate(() =>
        window.projectNavigationFixture.calls
          .filter((call) => call.action === 'selectWorkspace')
          .map((call) => call.workspaceId),
      );
      assert.deepEqual(selections, [ids[0], ids[1], ids[0], ids[0]]);
      assert.equal((await ownerSnapshot()).tab, `tab_${'2'.repeat(24)}`);

      const nextRefresh = async () => {
        const index = await page.evaluate(
          () => window.projectNavigationFixture.pendingTabRefreshes.length,
        );
        await page.waitForFunction(
          (count) => window.projectNavigationFixture.pendingTabRefreshes.length > count,
          index,
        );
        return index;
      };
      const releaseRefresh = async (index) => {
        await page.evaluate(async (pendingIndex) => {
          const pending = window.projectNavigationFixture.pendingTabRefreshes[pendingIndex];
          pending.resolveRefresh(pending.snapshot);
          await new Promise((resolveFrame) =>
            window.requestAnimationFrame(() => window.requestAnimationFrame(resolveFrame)),
          );
        }, index);
      };

      // A full refresh captures A, then finishes after a newer click on B.
      // Completing its old tabs also releases its old panel snapshot.
      const beforeClickRefresh = await nextRefresh();
      await open(1).click();
      await waitSelected(1);
      const afterNewSelection = await ownerSnapshot();
      await releaseRefresh(beforeClickRefresh);
      await waitSelected(1);
      assert.deepEqual(await ownerSnapshot(), afterNewSelection);
      assert.ok(!(await row(0).getAttribute('class')).includes('selected'));

      // A refresh may also start while selection is still awaiting the owner.
      // Its revision must stay unusable even if the navigation settles first.
      await page.evaluate(() => {
        window.projectNavigationFixture.deferNextSelect = true;
      });
      await open(0).click();
      await page.waitForFunction(
        () => window.projectNavigationFixture.finishDeferredSelect !== null,
      );
      const duringClickRefresh = await nextRefresh();
      await page.evaluate(() => window.projectNavigationFixture.finishDeferredSelect());
      await waitSelected(0);
      const afterPendingSelection = await ownerSnapshot();
      await releaseRefresh(duringClickRefresh);
      await waitSelected(0);
      assert.deepEqual(await ownerSnapshot(), afterPendingSelection);
      assert.ok(!(await row(1).getAttribute('class')).includes('selected'));

      await open(1).click();
      await waitSelected(1);
      await newChat(0).click();
      await page.waitForFunction(() => window.projectNavigationFixture.tabs.length === 4);
      await waitSelected(0);
      const projectInput = await page.evaluate(
        () =>
          window.projectNavigationFixture.calls
            .filter((call) => call.action === 'createChatGptTab')
            .at(-1).input,
      );
      assert.equal(projectInput.workspace_id, ids[0]);
      assert.equal(projectInput.project_chat, true);
      assert.equal(typeof projectInput.label, 'string');
      assert.ok((await row(0).getAttribute('class')).includes('selected'));
      assert.equal((await ownerSnapshot()).workspace, ids[0]);

      await page.locator('.new-chat-button').click();
      await page.waitForFunction(() => window.projectNavigationFixture.tabs.length === 5);
      await waitSelected(null);
      const generalInput = await page.evaluate(
        () =>
          window.projectNavigationFixture.calls
            .filter((call) => call.action === 'createChatGptTab')
            .at(-1).input,
      );
      assert.equal(generalInput.workspace_id, null);
      assert.equal(generalInput.project_chat, undefined);
      assert.equal((await ownerSnapshot()).workspace, null);
      // A settled background refresh must keep general chat unassociated.
      const generalChatRefresh = await nextRefresh();
      await releaseRefresh(generalChatRefresh);
      await waitSelected(null);

      // A project whose home address was never stored is located by the main
      // process; once its identity check passes the new chat opens normally.
      await open(1).click();
      await waitSelected(1);
      await page.evaluate(() => {
        window.projectNavigationFixture.nextCreateError = 'project_chat_url_unavailable';
        window.projectNavigationFixture.calls = [];
      });
      await newChat(0).click();
      await waitSelected(0);
      assert.deepEqual(
        await page.evaluate(() =>
          window.projectNavigationFixture.calls
            .filter((call) =>
              ['createChatGptTab', 'automateProjectInstructionsUpdate'].includes(call.action),
            )
            .map((call) => call.action),
        ),
        ['createChatGptTab', 'automateProjectInstructionsUpdate', 'createChatGptTab'],
        `${locale}: unknown home is verified once, then the chat opens`,
      );
      await assertNoAutomation();

      // Both unavailable and ambiguous associations stay errors: no global
      // launcher, replacement project, closed editor or automatic Project setup.
      for (const failure of ['unavailable', 'ambiguous']) {
        for (const operation of ['create', 'select']) {
          await open(1).click();
          await waitSelected(1);
          const before = await ownerSnapshot();
          await page.evaluate(
            ({ operation, failure }) => {
              const state = window.projectNavigationFixture;
              state[operation === 'create' ? 'nextCreateError' : 'nextSelectError'] =
                `project_chat_url_${failure}`;
            },
            { operation, failure },
          );
          await page.evaluate(() => {
            window.projectNavigationFixture.homeCheckFails = true;
          });
          await (operation === 'create' ? newChat(0) : open(0)).click();
          await page.getByRole('alert').filter({ hasText: messages[locale][failure] }).waitFor();
          const homeChecks = await page.evaluate(
            () =>
              window.projectNavigationFixture.calls.filter(
                (call) => call.action === 'automateProjectInstructionsUpdate',
              ).length,
          );
          // Only a new chat with an unknown home address tries the identity check.
          assert.equal(
            homeChecks > 0,
            operation === 'create' && failure === 'unavailable',
            `${locale}: ${operation}/${failure} home check`,
          );
          await page.evaluate(() => {
            window.projectNavigationFixture.homeCheckFails = false;
            window.projectNavigationFixture.calls = window.projectNavigationFixture.calls.filter(
              (call) => call.action !== 'automateProjectInstructionsUpdate',
            );
          });
          assert.deepEqual(await ownerSnapshot(), before);
          assert.ok((await row(1).getAttribute('class')).includes('selected'));
          assert.ok(!(await row(0).getAttribute('class')).includes('selected'));
          await assertNoAutomation();
          assert.equal(
            await page.getByText(`project_chat_url_${failure}`, { exact: true }).count(),
            0,
          );
          await page.screenshot({
            path: join(evidenceDirectory, `project-${operation}-${failure}-${locale}.png`),
            fullPage: true,
          });
          await page.locator('.toast button').click();
        }
      }

      await page.evaluate(() => {
        window.projectNavigationFixture.deferNextCreate = true;
      });
      await newChat(0).click();
      await page.waitForFunction(
        () => window.projectNavigationFixture.finishDeferredCreate !== null,
      );
      await open(1).click();
      await waitSelected(1);
      const beforeLateResult = await ownerSnapshot();
      await page.evaluate(async () => {
        window.projectNavigationFixture.finishDeferredCreate();
        await new Promise((resolveFrame) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolveFrame)),
        );
      });
      assert.deepEqual(await ownerSnapshot(), beforeLateResult);
      assert.ok((await row(1).getAttribute('class')).includes('selected'));
      assert.ok(!(await row(0).getAttribute('class')).includes('selected'));
      await assertNoAutomation();
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    console.log(
      JSON.stringify({
        passed: true,
        bridgeFixture: true,
        nativeChatGptNavigation: false,
        nativeEditorDraftPreservation: 'covered by main IPC tests',
        projectSelectionDispatch: true,
        currentProjectReclick: true,
        selectionRenderedWithoutPolling: true,
        staleRefreshBeforeNavigationSuppressed: true,
        staleRefreshDuringNavigationSuppressed: true,
        projectNewChatIntent: true,
        globalNewChatPreserved: true,
        generalChatRefreshKeepsNoProjectSelected: true,
        missingAndAmbiguousAssociationErrors: true,
        noAutomaticProjectCreation: true,
        staleCreateResultSuppressed: true,
        koreanAndEnglish: true,
        narrowSidebarWidth: 300,
        evidenceDirectory,
        layouts,
        pageErrors,
        externalRequests,
      }),
    );
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
