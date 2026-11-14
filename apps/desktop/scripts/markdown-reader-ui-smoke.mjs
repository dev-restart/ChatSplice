/* global localStorage, window, document, getComputedStyle */
import assert from 'node:assert/strict';
import console from 'node:console';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rendererRoot = resolve(
  process.env.CHATSPLICE_RENDERER_DIR ?? join(root, 'apps/desktop/dist/renderer'),
);
const require = createRequire(join(root, 'packages/mcp-server/package.json'));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(
  root,
  'packages/mcp-server/node_modules/.cache/chatsplice-playwright',
);
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
const { chromium } = require('playwright');
const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-markdown-reader-ui-'));

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

const markdown = `# 시작하기

문단에 **굵게**, *기울임*, ~~취소선~~, \`인라인 코드\`가 섞여 있습니다.

## 목록

- 첫째
- 둘째
  - 안쪽 항목

1. 하나
2. 둘

- [x] 끝낸 일
- [ ] 남은 일

> 인용문입니다.

| 이름 | 값 |
| --- | ---: |
| a | 1 |

\`\`\`js
const answer = 42;
\`\`\`

[안전한 링크](https://example.com/docs) [위험한 링크](javascript:window.__pwned=1)

![로고](https://evil.example/pixel.png)

<script>window.__pwned = 1</script>
<img src="x" onerror="window.__pwned = 1">
`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, locale: 'ko-KR' });
  const pageErrors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === `http://127.0.0.1:${server.address().port}`) await route.continue();
    else {
      externalRequests.push(route.request().url());
      await route.abort();
    }
  });
  await page.addInitScript((source) => {
    localStorage.setItem('chatsplice.ui-locale.v1', 'ko');
    const workspaceId = `ws_${'a'.repeat(24)}`;
    const tabId = `edtab_${'b'.repeat(24)}`;
    const tab = (path, dirty) => ({
      editor_tab_id: tabId,
      workspace_id: workspaceId,
      path,
      label: path,
      dirty,
      draft_revision: state.revision,
      loaded: true,
    });
    const state = { path: 'docs/README.md', content: source, dirty: false, revision: 1 };
    const editorState = () => ({
      workspace_id: workspaceId,
      tabs: [tab(state.path, state.dirty)],
      active_editor_tab_id: tabId,
      open_document_ids: [tabId],
      revision: state.revision,
    });
    const document = () => ({
      editor_tab_id: tabId,
      workspace_id: workspaceId,
      path: state.path,
      content: state.content,
      sha256: 'c'.repeat(64),
      draft_revision: state.revision,
      dirty: state.dirty,
    });
    window.markdownFixture = state;
    const methods = {
      getEditorState: async () => editorState(),
      getEditorDocument: async () => document(),
      updateEditorDocument: async (input) => {
        state.content = input.content;
        state.dirty = true;
        return document();
      },
      saveEditorDocument: async () => document(),
      reloadEditorDocument: async () => document(),
      activateEditorTab: async () => editorState(),
      closeEditorTab: async () => editorState(),
      getPanelState: async () => ({
        workspace_id: workspaceId,
        console_open: false,
        files_open: false,
        files_width: 340,
        console_height: 300,
      }),
    };
    window.chatsplice = new Proxy(methods, {
      get: (target, key) => target[key] ?? (async () => undefined),
    });
  }, markdown);

  await page.goto(`http://127.0.0.1:${server.address().port}/?surface=editor`);
  const toggle = page.getByRole('group', { name: '보기 방식' });
  await toggle.waitFor();
  assert.equal(
    await toggle.getByRole('button', { name: '읽기' }).getAttribute('aria-pressed'),
    'true',
  );
  const reader = page.getByTestId('markdown-reader');
  await reader.waitFor();

  // Styled structure instead of raw Markdown source.
  assert.equal(await reader.locator('h1').innerText(), '시작하기');
  assert.equal(await reader.locator('h2').innerText(), '목록');
  assert.equal(await reader.locator('strong').first().innerText(), '굵게');
  assert.equal(await reader.locator('em').first().innerText(), '기울임');
  assert.equal(await reader.locator('del').innerText(), '취소선');
  assert.equal((await reader.locator('ul > li').count()) >= 4, true);
  assert.equal(await reader.locator('ol > li').count(), 2);
  assert.equal(
    await reader
      .locator('ul > li')
      .first()
      .evaluate((el) => getComputedStyle(el).listStyleType),
    'disc',
    'bullets are visible',
  );
  assert.equal(
    await reader.locator('ol').evaluate((el) => getComputedStyle(el).listStyleType),
    'decimal',
  );
  assert.equal(await reader.locator('li.task input[type=checkbox]:checked').count(), 1);
  assert.equal(await reader.locator('li.task input[type=checkbox]:not(:checked)').count(), 1);
  assert.equal(await reader.locator('blockquote').innerText(), '인용문입니다.');
  assert.deepEqual(await reader.locator('th').allInnerTexts(), ['이름', '값']);
  assert.equal(await reader.locator('pre code').innerText(), 'const answer = 42;');
  assert.equal(await reader.locator('h1').evaluate((el) => getComputedStyle(el).fontSize), '27px');
  assert.equal(
    await page.locator('.cm-content').first().isVisible(),
    false,
    'source editor is hidden',
  );
  const readerText = await reader.innerText();
  assert.equal(/\*\*|~~|^#{1,6} |```/m.test(readerText), false, 'no Markdown syntax is shown');

  // Documents can never run code, navigate or load remote content.
  assert.equal(await reader.locator('a, img, script, iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await page.getByText('<script>window.__pwned = 1</script>', { exact: false }).first().waitFor();
  assert.equal(await reader.getByText('[이미지: 로고]').count(), 1);
  assert.equal(await reader.locator('.md-link[title="https://example.com/docs"]').count(), 1);
  assert.equal(await reader.locator('.md-link-inert').count(), 1, 'unsafe scheme is not described');
  assert.deepEqual(externalRequests, []);
  await page.screenshot({ path: join(evidenceDirectory, 'markdown-read.png') });

  // Edit mode brings the source editor back; the choice is remembered.
  await toggle.getByRole('button', { name: '편집' }).click();
  await page.locator('.cm-content').waitFor();
  assert.equal(await page.getByTestId('markdown-reader').count(), 0);
  assert.equal(
    await page.evaluate(() => localStorage.getItem('chatsplice.markdown-mode.v1')),
    'edit',
  );
  await page.screenshot({ path: join(evidenceDirectory, 'markdown-edit.png') });
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n\n## 새로 쓴 제목');
  await toggle.getByRole('button', { name: '읽기' }).click();
  await page.getByRole('heading', { name: '새로 쓴 제목' }).waitFor();

  // Other file types never show the toggle.
  await page.evaluate(() => {
    window.markdownFixture.path = 'src/main.ts';
    window.markdownFixture.content = 'export const value = 1;\n';
    window.markdownFixture.dirty = false;
    window.markdownFixture.revision += 1;
  });
  await page.waitForFunction(() => !document.querySelector('[role=group][aria-label="보기 방식"]'));
  assert.equal(await page.getByTestId('markdown-reader').count(), 0);

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: true, evidenceDirectory, pageErrors }));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
