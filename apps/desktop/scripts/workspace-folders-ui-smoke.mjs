/* global localStorage, window, structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';

async function openProjectSettings(page, name) {
  // Rows only reveal their actions on hover; settings live in the ⋯ menu.
  await page.getByRole('button', { name: `${name} ChatGPT Project 열기`, exact: true }).hover();
  await page.getByRole('button', { name: `${name} 관리`, exact: true }).click();
  await page.getByRole('menuitem', { name: '프로젝트 설정', exact: true }).click();
}

import { fileURLToPath, URL } from 'node:url';

// This fixture never starts the live daemon or opens a real folder picker.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rendererRoot = resolve(
  process.env.CHATSPLICE_RENDERER_DIR ?? join(root, 'apps/desktop/dist/renderer'),
);
function installFixture() {
  localStorage.setItem('chatsplice.ui-locale.v1', 'ko');
  const now = new Date().toISOString();
  const sourceId = `ws_${'a'.repeat(24)}`;
  const targetId = `ws_${'b'.repeat(24)}`;
  const source = {
    workspace_id: sourceId,
    display_name: 'Folder fixture',
    root_path: '/fixture/project',
    kind: 'user',
    created_at: now,
  };
  const folder = {
    workspace_id: targetId,
    display_name: 'Shared assets',
    root_path: '/fixture/shared-assets',
    kind: 'reference',
    created_at: now,
  };
  const tabs = [
    {
      chatgpt_tab_id: `tab_${'a'.repeat(24)}`,
      workspace_id: sourceId,
      label: 'Folder fixture · ChatGPT Project',
      active: true,
      project_instructions_confirmed: true,
    },
  ];
  const panel = {
    workspace_id: sourceId,
    console_open: false,
    files_open: false,
    files_width: 340,
    console_height: 300,
  };
  const state = {
    workspaces: [source],
    references: [],
    calls: [],
    busyNext: false,
    cancelNext: false,
    draft: 'Preserve this draft',
    panel,
    tabs,
  };
  const tabResult = () => ({ tabs: structuredClone(tabs), active_tab_id: tabs[0].chatgpt_tab_id });
  const reference = (mode) => ({
    source_workspace_id: sourceId,
    reference_workspace_id: targetId,
    created_at: now,
    ...(mode === undefined ? {} : { access_mode: mode }),
    ...(mode === 'read_write'
      ? { source_root_path: source.root_path, reference_root_path: folder.root_path }
      : {}),
  });
  const status = {
    runtime_identity: { status: 'verified' },
    daemon: {
      healthy: true,
      ready: true,
      read_only_mode: false,
      mcp_app_name: 'ChatSplice MCP',
      auto_attach_workspace_ids: [],
      execution_jobs: [],
      latest_mcp_activities: [],
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
  state.seedLegacy = () => {
    if (!state.workspaces.some((entry) => entry.workspace_id === targetId))
      state.workspaces.push(folder);
    state.references = [reference(undefined)];
  };
  window.workspaceFoldersFixture = state;
  window.chatsplice = {
    getStatus: async () => structuredClone(status),
    listWorkspaces: async () => ({
      workspaces: structuredClone(state.workspaces),
      count: state.workspaces.length,
    }),
    listWorkspaceReferences: async () => ({
      references: structuredClone(state.references),
      count: state.references.length,
    }),
    listChatGptTabs: async () => tabResult(),
    activateChatGptTab: async () => tabResult(),
    getPanelState: async () => structuredClone(panel),
    setPanelState: async (next) => {
      Object.assign(panel, next);
      return structuredClone(panel);
    },
    getSidebarLayout: async () => ({ width: 360, collapsed: false }),
    setModalOverlay: async () => undefined,
    automateProjectInstructionsUpdate: async () => ({
      automation: { status: 'completed', reason: 'instructions_current', message: 'Current' },
      tabs: tabResult(),
    }),
    updateChatGptTab: async () => tabResult(),
    openWorkspaceReference: async (input) => {
      state.calls.push({ action: 'add', input: structuredClone(input) });
      if (state.cancelNext) {
        state.cancelNext = false;
        return null;
      }
      if (!state.workspaces.some((entry) => entry.workspace_id === targetId))
        state.workspaces.push(folder);
      const result = reference(input.access_mode);
      state.references = [result];
      return structuredClone(result);
    },
    setWorkspaceReferenceAccess: async (input) => {
      state.calls.push({ action: 'access', input: structuredClone(input) });
      if (state.busyNext) {
        state.busyNext = false;
        throw new Error('workspace_reference_busy');
      }
      const result = reference(input.access_mode);
      state.references = [result];
      return structuredClone(result);
    },
    removeWorkspaceReference: async (input) => {
      state.calls.push({ action: 'remove', input: structuredClone(input) });
      state.references = state.references.filter(
        (entry) => entry.reference_workspace_id !== input.reference_workspace_id,
      );
      return { references: structuredClone(state.references), count: state.references.length };
    },
  };
}
const fixtureScript = `(${installFixture.toString()})();`;
const bootstrap = '<script src="/workspace-folders-fixture.js"></script>';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/workspace-folders-fixture.js') {
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
        'content-type': types[extname(path)] ?? 'application/octet-stream',
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
    JSON.stringify({ fixtureUrl, rendererRoot, bridgeFixture: true, nativePicker: false }),
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
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-workspace-folders-ui-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, locale: 'ko-KR' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(fixtureUrl);
    await openProjectSettings(page, 'Folder fixture');
    const section = page.getByTestId('workspace-folders');
    await section.getByText('추가한 폴더가 없어요.', { exact: true }).waitFor();
    const newAccess = section.getByRole('combobox', { name: '추가할 폴더의 권한', exact: true });
    assert.equal(await newAccess.inputValue(), 'read_write');
    await section.screenshot({ path: join(evidenceDirectory, 'folders-empty.png') });
    await section.getByRole('button', { name: '폴더 추가', exact: true }).click();
    const access = section.getByRole('combobox', { name: 'Shared assets 폴더 권한', exact: true });
    await section.getByText('/fixture/shared-assets', { exact: true }).waitFor();
    assert.equal(await access.inputValue(), 'read_write');
    assert.equal(
      await page.getByRole('button', { name: 'Shared assets 관리', exact: true }).count(),
      0,
    );
    await section.screenshot({ path: join(evidenceDirectory, 'folders-write.png') });
    const reapply = section.getByRole('button', {
      name: '현재 경로로 권한 다시 적용',
      exact: true,
    });
    assert.equal(await reapply.count(), 0);
    await page.evaluate(() => {
      window.workspaceFoldersFixture.references[0].reference_root_path =
        '/fixture/previous-shared-assets';
    });
    await reapply.waitFor();
    await reapply.click();
    await page.waitForFunction(
      () =>
        window.workspaceFoldersFixture.references[0]?.reference_root_path ===
        '/fixture/shared-assets',
    );
    await reapply.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      window.workspaceFoldersFixture.busyNext = true;
    });
    await access.selectOption('read_only');
    await section.getByRole('alert').filter({ hasText: '끝나거나 멈춘' }).waitFor();
    assert.equal(await access.inputValue(), 'read_write');
    await section.screenshot({ path: join(evidenceDirectory, 'folders-busy.png') });
    await access.selectOption('read_only');
    await page.waitForFunction(
      () => window.workspaceFoldersFixture.references[0]?.access_mode === 'read_only',
    );
    await page.waitForFunction(() => {
      const select = window.document.querySelector('[aria-label="Shared assets 폴더 권한"]');
      return select?.value === 'read_only' && !select.disabled;
    });
    assert.equal(await access.inputValue(), 'read_only');
    assert.equal(await section.getByRole('alert').count(), 0);
    await page.keyboard.press('Escape');
    await openProjectSettings(page, 'Folder fixture');
    assert.equal(await access.inputValue(), 'read_only');
    assert.equal(await newAccess.inputValue(), 'read_write');
    await section.getByRole('button', { name: '연결 해제', exact: true }).click();
    await section.getByText('추가한 폴더가 없어요.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.workspaceFoldersFixture.workspaces.length), 2);
    await page.evaluate(() => {
      window.workspaceFoldersFixture.cancelNext = true;
    });
    await section.getByRole('button', { name: '폴더 추가', exact: true }).click();
    assert.equal(
      await section.getByRole('combobox', { name: 'Shared assets 폴더 권한', exact: true }).count(),
      0,
    );
    await page.evaluate(() => window.workspaceFoldersFixture.seedLegacy());
    await access.waitFor();
    assert.equal(await access.inputValue(), 'read_only');
    await page.setViewportSize({ width: 480, height: 820 });
    await section.scrollIntoViewIfNeeded();
    const bounds = await section.boundingBox();
    assert.ok(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 480);
    await page.screenshot({ path: join(evidenceDirectory, 'folders-narrow.png'), fullPage: true });
    assert.deepEqual(
      await page.evaluate(() => ({
        workspace: window.workspaceFoldersFixture.panel.workspace_id,
        root: window.workspaceFoldersFixture.workspaces[0].root_path,
        draft: window.workspaceFoldersFixture.draft,
        tabs: window.workspaceFoldersFixture.tabs.length,
      })),
      {
        workspace: `ws_${'a'.repeat(24)}`,
        root: '/fixture/project',
        draft: 'Preserve this draft',
        tabs: 1,
      },
    );
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        bridgeFixture: true,
        nativePicker: false,
        defaultWriteAccess: true,
        legacyReadOnly: true,
        busyUpdatePreservesAccess: true,
        disconnectKeepsFolder: true,
        cancelDoesNotConnect: true,
        extraFolderHiddenFromProjectList: true,
        currentProjectPreserved: true,
        narrowLayout: true,
        evidenceDirectory,
        pageErrors,
      }),
    );
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
