/* global localStorage, window, structuredClone, document */
import assert from 'node:assert/strict';
import console from 'node:console';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { startChatSpliceRuntime } from '../../../packages/mcp-server/dist/index.js';
import { readDesktopRuntimeIdentity } from '../dist/main/runtime-identity.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const desktopRoot = join(root, 'apps/desktop');
const rendererRoot = join(desktopRoot, 'dist/renderer');
const require = createRequire(join(root, 'packages/mcp-server/package.json'));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(
  root,
  'packages/mcp-server/node_modules/.cache/chatsplice-playwright',
);
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
const { chromium } = require('playwright');
const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-connection-ui-'));
const dataDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-connection-runtime-'));
const runtime = await startChatSpliceRuntime({
  dataDirectory,
  controlSocketPath: join(dataDirectory, 'control.sock'),
});
const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
const desktopIdentity = readDesktopRuntimeIdentity(desktopRoot, packageJson.version);
assert.equal(desktopIdentity.status, 'verified');
assert.equal(runtime.status().build_id, desktopIdentity.expected_daemon_build_id);
assert.equal(runtime.status().tool_schema_digest, desktopIdentity.expected_tool_schema_digest);
const desktopStatus = {
  runtime_identity: desktopIdentity,
  daemon: runtime.status(),
  chatgpt_login_confirmed: false,
  credential_store: { available: true, configured: false, error_code: null },
};
const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = resolve(rendererRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!path.startsWith(rendererRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    const content = await readFile(path);
    response
      .writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' })
      .end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, locale: 'ko-KR' });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((initial) => {
    localStorage.setItem('chatsplice.ui-locale.v1', 'ko');
    const status = structuredClone(initial);
    window.connectionFixture = { status };
    window.chatsplice = {
      getStatus: async () => structuredClone(status),
      listWorkspaces: async () => ({ workspaces: [], count: 0 }),
      listWorkspaceReferences: async () => ({ references: [] }),
      listChatGptTabs: async () => ({ tabs: [], active_tab_id: null }),
      getPanelState: async () => ({
        workspace_id: null,
        console_open: false,
        files_open: false,
        files_width: 340,
        console_height: 300,
      }),
      getSidebarLayout: async () => ({ width: 360, collapsed: false }),
      setModalOverlay: async () => undefined,
    };
  }, desktopStatus);
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  // The footer is one icon-only settings entry; connection settings live on that page.
  await page.getByRole('button', { name: /^설정 열기/ }).click();
  await page.getByRole('heading', { name: '연결', exact: true }).waitFor();
  await page.getByText('연결 설정이 필요해요', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'ChatGPT에 등록한 앱 이름' }).waitFor();
  await page.getByRole('heading', { name: /^연결 키/ }).waitFor();
  await page.getByRole('button', { name: '연결 점검', exact: true }).waitFor();
  await page.getByText('앱을 켜면 자동으로 연결', { exact: false }).waitFor();
  // Tunnel identifiers are needed before first use, so setup starts expanded.
  await page.getByPlaceholder('tunnel_…').waitFor();
  // Build identity and saved-Goal counts are not part of the page.
  const pageText = await page.locator('body').innerText();
  for (const hidden of [
    desktopIdentity.desktop_build_id,
    '빌드·도구 세부 정보',
    '로컬에 저장된 Goal',
    '로컬 실행 상태',
  ]) {
    assert.equal(pageText.includes(hidden), false, `settings must not show: ${hidden}`);
  }
  assert.equal(await page.getByRole('status').count(), 0, 'no restart notice while builds match');
  await page.screenshot({
    path: join(evidenceDirectory, 'settings-connection.png'),
    fullPage: true,
  });
  // Guidance and the version each live in exactly one place.
  assert.equal(
    (pageText.match(/0\.0\.\d+/g) ?? []).length >= 1,
    true,
    'version is shown once on settings',
  );
  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('heading', { name: '여러 폴더를 함께 쓰기' }).waitFor();
  await page.getByRole('heading', { name: '연결 값은 어디서 구하나요' }).waitFor();
  await page.getByRole('button', { name: 'OpenAI Platform 열기', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /값을 구하는 방법/ }).count(), 0);
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await page.evaluate(() => {
    window.connectionFixture.status.daemon.build_id = 'd'.repeat(64);
  });
  await page.getByRole('status').filter({ hasText: '완전히 종료' }).waitFor();
  await page.evaluate(() => {
    window.connectionFixture.status.daemon.tool_schema_digest = 'e'.repeat(64);
  });
  await page.getByRole('status').filter({ hasText: '완전히 종료' }).waitFor();
  await page.setViewportSize({ width: 560, height: 820 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.screenshot({
    path: join(evidenceDirectory, 'connection-mismatch-compact.png'),
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      passed: true,
      realDaemonIdentity: true,
      bridgeFixture: true,
      evidenceDirectory,
      localCatalogCount: runtime.status().tool_count,
      pageErrors,
    }),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await runtime.close();
}
