/* global document, localStorage, window, structuredClone */
import assert from 'node:assert/strict';
import console from 'node:console';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { startChatSpliceRuntime } from '../../../packages/mcp-server/dist/index.js';
import {
  buildChatGptProjectAutomationScript,
  buildChatGptProjectCreateClickScript,
  buildChatGptProjectCreateModalProbeScript,
  buildChatGptProjectInstructionsUpdateScript,
} from '../dist/main/chatgpt-project-automation.js';
import { readDesktopRuntimeIdentity } from '../dist/main/runtime-identity.js';
import { ChatGptTabManager } from '../dist/main/chatgpt-tabs.js';

async function openProjectSettings(page, name) {
  // Rows only reveal their actions on hover; settings live in the ⋯ menu.
  await page.getByRole('button', { name: `${name} ChatGPT Project 열기`, exact: true }).hover();
  await page.getByRole('button', { name: `${name} 관리`, exact: true }).click();
  await page.getByRole('menuitem', { name: '프로젝트 설정', exact: true }).click();
}

async function verifyPointerProjectFlow(browser, evidenceDirectory) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Project controls fixture</title>
    <main><h1>프로젝트</h1><button id="opener">만들기</button></main>
    <script>
      let persisted = '', pointerOpens = 0;
      function openSettings() {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<h2>프로젝트 설정</h2><label for="fixture-instructions">지침</label><textarea id="fixture-instructions" name="project-instructions"></textarea><button id="save" hidden>저장</button><button aria-label="대화 상자 닫기" id="close">닫기</button>';
        document.body.append(dialog);
        const field = dialog.querySelector('textarea');
        field.value = persisted;
        field.addEventListener('input', () => { dialog.querySelector('#save').hidden = false; });
        dialog.querySelector('#save').onclick = () => {
          const draft = field.value;
          dialog.querySelector('#save').disabled = true;
          field.disabled = true;
          setTimeout(() => { persisted = draft; dialog.remove(); }, 100);
        };
        dialog.querySelector('#close').onclick = () => dialog.remove();
      }
      function project() {
        if (location.pathname === '/projects') {
          location.assign('/g/project-fixture/project');
          return;
        }
        document.querySelector('main').innerHTML = '<h1>Project controls fixture</h1><button aria-label="프로젝트 액션" aria-haspopup="menu" aria-expanded="false" id="actions">...</button>';
        const actions = document.querySelector('#actions');
        // Radix-style trigger: a click alone deliberately does not open it.
        actions.onpointerdown = (event) => {
          if (event.button !== 0 || event.ctrlKey || actions.getAttribute('aria-expanded') === 'true') return;
          pointerOpens++;
          actions.setAttribute('aria-expanded', 'true');
          const menu = document.createElement('div');
          menu.setAttribute('role', 'menu');
          menu.innerHTML = '<button role="menuitem">프로젝트 설정</button>';
          document.body.append(menu);
          menu.querySelector('button').onclick = () => {
            menu.remove();
            actions.setAttribute('aria-expanded', 'false');
            openSettings();
          };
        };
      }
      document.querySelector('#opener').onclick = () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<h2>프로젝트 만들기</h2><label for="chatgpt-project-name">프로젝트 이름</label><input id="chatgpt-project-name"><button id="create" disabled>프로젝트 만들기</button>';
        document.body.append(dialog);
        dialog.querySelector('input').addEventListener('input', () => { dialog.querySelector('#create').disabled = false; });
        dialog.querySelector('#create').onclick = () => { dialog.remove(); project(); };
      };
      window.fixtureReceipt = () => ({ persisted, pointerOpens });
      if (location.pathname !== '/projects') project();
    </script></html>`;
  await page.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto('https://chatgpt.com/projects');
  assert.equal(await page.evaluate(buildChatGptProjectCreateClickScript()), 'clicked');
  assert.equal(await page.evaluate(buildChatGptProjectCreateModalProbeScript(1_500)), true);
  const input = {
    workspaceId: `ws_${'a'.repeat(24)}`,
    workspaceName: 'Project controls fixture',
    bindingText: 'Fixture instructions: exact saved text',
  };
  const submitted = await page
    .evaluate(buildChatGptProjectAutomationScript({ ...input, createOnly: true }).source)
    .catch((error) => ({
      navigationInterrupted: error.message.includes('Execution context was destroyed'),
    }));
  await page.waitForURL('https://chatgpt.com/g/project-fixture/project');
  assert.ok(submitted === 'submitted' || submitted.navigationInterrupted);
  const result = await page.evaluate(
    buildChatGptProjectInstructionsUpdateScript({
      ...input,
      initializeEmpty: true,
      expectedProjectUrl: page.url(),
    }).source,
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(await page.evaluate(() => window.fixtureReceipt()), {
    persisted: input.bindingText,
    pointerOpens: 2,
  });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: join(evidenceDirectory, 'pointer-menu-full-navigation.png') });
  await page.close();
}

async function verifyConversationRecovery(browser, evidenceDirectory) {
  const context = await browser.newContext();
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const home = 'https://chatgpt.com/g/g-p-recovery-fixture/project';
  const conversation = 'https://chatgpt.com/g/g-p-recovery-fixture/c/fixture-123';
  const workspaceId = `ws_${'b'.repeat(24)}`;
  const instructions = [
    '--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS v1 ---',
    `- workspace_id: ${workspaceId}`,
    '- workspace_binding: fixture-private-binding',
    'Current runtime instructions',
    '--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---',
  ].join('\n');
  const pageErrors = [];
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Recovery fixture</title>
    <main></main><script>
      const main = document.querySelector('main');
      if (location.pathname.includes('/c/')) {
        main.innerHTML = '<h1>Conversation fixture</h1><button aria-label="Chat actions">...</button><textarea aria-label="Message draft"></textarea>';
      } else {
        main.innerHTML = '<h1>Project home fixture</h1><button aria-label="프로젝트 액션" aria-haspopup="menu" aria-expanded="false">...</button>';
        const trigger = main.querySelector('button');
        trigger.onpointerdown = () => {
          if (trigger.getAttribute('aria-expanded') === 'true') return;
          trigger.setAttribute('aria-expanded', 'true');
          const menu = document.createElement('div');
          menu.setAttribute('role', 'menu');
          menu.innerHTML = '<button role="menuitem">프로젝트 설정</button>';
          document.body.append(menu);
          menu.querySelector('button').onclick = () => {
            menu.remove(); trigger.setAttribute('aria-expanded', 'false');
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = '<h2>프로젝트 설정</h2><label for="fixture-instructions">지침</label><textarea id="fixture-instructions" name="project-instructions"></textarea><button id="save" hidden>저장</button><button aria-label="대화 상자 닫기" id="close">닫기</button>';
            document.body.append(dialog);
            const field = dialog.querySelector('textarea');
            field.value = localStorage.getItem('instructions') || '';
            field.oninput = () => { dialog.querySelector('#save').hidden = false; };
            dialog.querySelector('#save').onclick = () => {
              localStorage.setItem('instructions', field.value);
              localStorage.setItem('saves', String(Number(localStorage.getItem('saves') || 0) + 1));
              dialog.remove();
            };
            dialog.querySelector('#close').onclick = () => dialog.remove();
          };
        };
      }
    </script></html>`;
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  const views = pages.map((page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let loads = 0;
    const contents = Object.assign(new EventEmitter(), {
      loadURL: async (url) => {
        loads++;
        await page.goto(url);
      },
      getURL: () => page.url(),
      isDestroyed: () => page.isClosed(),
      isLoadingMainFrame: () => false,
      executeJavaScript: (source) => page.evaluate(source),
      focus: () => undefined,
      close: () => undefined,
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) contents.emit('did-navigate', {}, page.url());
    });
    return {
      webContents: contents,
      setBounds: () => undefined,
      setVisible: () => undefined,
      loads: () => loads,
    };
  });
  const now = new Date().toISOString();
  const record = {
    chatgpt_tab_id: `tab_${'b'.repeat(24)}`,
    workspace_id: workspaceId,
    label: 'Recovery fixture',
    url: conversation,
    project_url: home,
    project_instructions_confirmed: true,
    created_at: now,
    updated_at: now,
  };
  let nextView = 0;
  const manager = await ChatGptTabManager.create({
    window: {
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      focus: () => undefined,
    },
    initialState: { tabs: [record], active_tab_id: record.chatgpt_tab_id },
    createView: () => views[nextView++],
    persist: async () => undefined,
  });
  try {
    await pages[0].getByRole('textbox', { name: 'Message draft' }).fill('작성 중인 내용 보존');
    const input = {
      workspace_id: workspaceId,
      workspace_name: 'Recovery fixture',
      binding_text: instructions,
    };
    const automatic = await manager.automateProjectInstructionsUpdate({
      ...input,
      automatic: true,
    });
    assert.equal(automatic.automation.reason, 'project_home_required');
    assert.equal(nextView, 1);

    const restored = await manager.automateProjectInstructionsUpdate(input);
    assert.equal(restored.automation.reason, 'instructions_updated');
    assert.equal(restored.tabs.active_tab_id, record.chatgpt_tab_id);
    assert.equal(pages[0].url(), conversation);
    assert.equal(views[0].loads(), 1);
    assert.equal(
      await pages[0].getByRole('textbox', { name: 'Message draft' }).inputValue(),
      '작성 중인 내용 보존',
    );
    assert.equal(await pages[1].evaluate(() => localStorage.getItem('instructions')), instructions);
    assert.equal(await pages[1].evaluate(() => localStorage.getItem('saves')), '1');
    assert.equal(await pages[1].getByRole('dialog').count(), 0);

    const custom = `User instructions\n${instructions.replace('Current runtime instructions', 'Older runtime instructions')}\nKeep this text`;
    await pages[1].evaluate((text) => localStorage.setItem('instructions', text), custom);
    assert.equal(
      (await manager.automateProjectInstructionsUpdate(input)).automation.reason,
      'instructions_updated',
    );
    assert.equal(
      await pages[1].evaluate(() => localStorage.getItem('instructions')),
      `User instructions\n${instructions}\nKeep this text`,
    );

    const wrongBinding = instructions.replace('fixture-private-binding', 'another-fixture-binding');
    await pages[1].evaluate((text) => localStorage.setItem('instructions', text), wrongBinding);
    assert.equal(
      (await manager.automateProjectInstructionsUpdate(input)).automation.reason,
      'needs_manual_merge',
    );
    assert.equal(
      manager.list().tabs.every((tab) => !tab.project_instructions_confirmed),
      true,
    );
    assert.equal(await pages[1].evaluate(() => localStorage.getItem('instructions')), wrongBinding);
    assert.equal(await pages[1].evaluate(() => localStorage.getItem('saves')), '2');
    assert.equal(
      await pages[0].getByRole('textbox', { name: 'Message draft' }).inputValue(),
      '작성 중인 내용 보존',
    );
    assert.deepEqual(pageErrors, []);
    await pages[0].screenshot({
      path: join(evidenceDirectory, 'recovered-conversation-draft.png'),
    });
  } finally {
    await manager.close();
    await context.close();
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const desktopRoot = join(root, 'apps/desktop');
const rendererRoot = join(desktopRoot, 'dist/renderer');
const require = createRequire(join(root, 'packages/mcp-server/package.json'));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(
  root,
  'packages/mcp-server/node_modules/.cache/chatsplice-playwright',
);
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
const { chromium } = require('playwright');
const evidenceDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-project-setup-ui-'));
const dataDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-project-setup-runtime-'));
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
    const now = new Date().toISOString();
    const workspace = {
      workspace_id: `ws_${'a'.repeat(24)}`,
      display_name: 'Project setup fixture',
      root_path: '/fixture/project',
      kind: 'user',
      created_at: now,
    };
    const state = {
      workspaces: [],
      tabs: [],
      calls: [],
      fail: false,
      instructionIssue: null,
      manualInstructionFailure: false,
      instructionChecks: 0,
    };
    const panel = {
      workspace_id: null,
      console_open: false,
      files_open: false,
      files_width: 340,
      console_height: 300,
    };
    const tabResult = () => ({
      tabs: structuredClone(state.tabs),
      active_tab_id: state.tabs[0]?.chatgpt_tab_id ?? null,
    });
    window.projectSetupFixture = state;
    window.chatsplice = {
      getStatus: async () => structuredClone(initial),
      listWorkspaces: async () => ({
        workspaces: structuredClone(state.workspaces),
        count: state.workspaces.length,
      }),
      listWorkspaceReferences: async () => ({ references: [] }),
      listChatGptTabs: async () => tabResult(),
      activateChatGptTab: async () => tabResult(),
      getPanelState: async () => structuredClone(panel),
      setPanelState: async (next) => {
        Object.assign(panel, next);
        return structuredClone(panel);
      },
      getSidebarLayout: async () => ({ width: 360, collapsed: false }),
      setModalOverlay: async () => undefined,
      openWorkspace: async () => {
        state.calls.push('folder');
        if (!state.workspaces.length) state.workspaces.push(workspace);
        panel.workspace_id = workspace.workspace_id;
        return structuredClone(workspace);
      },
      automateChatGptProject: async () => {
        state.calls.push('automatic-setup');
        if (!state.tabs.length)
          state.tabs.push({
            chatgpt_tab_id: `tab_${'a'.repeat(24)}`,
            workspace_id: workspace.workspace_id,
            label: 'Project setup fixture · ChatGPT Project',
            active: true,
            project_instructions_confirmed: false,
          });
        if (state.fail)
          return {
            automation: {
              status: 'needs_user',
              reason: 'project_setup_failed',
              message: 'Save verification failed',
            },
            tabs: tabResult(),
          };
        state.tabs[0].project_instructions_confirmed = true;
        return {
          automation: {
            status: 'completed',
            reason: 'created_and_bound',
            message: 'Saved and reopened',
          },
          tabs: tabResult(),
        };
      },
      automateProjectInstructionsUpdate: async (input) => {
        if (input.automatic) {
          state.instructionChecks++;
          const reason =
            state.instructionIssue ??
            (state.tabs[0]?.project_instructions_confirmed
              ? 'instructions_current'
              : 'automation_deferred');
          return {
            automation: {
              status: reason === 'instructions_current' ? 'completed' : 'needs_user',
              reason,
              message: 'Automatic check result',
            },
            tabs: tabResult(),
          };
        }
        state.calls.push('manual-instructions-update');
        if (state.manualInstructionFailure)
          return {
            automation: {
              status: 'needs_user',
              reason: 'chatgpt_ui_changed',
              message: 'Verification failed',
            },
            tabs: tabResult(),
          };
        state.tabs[0].project_instructions_confirmed = true;
        state.instructionIssue = null;
        return {
          automation: {
            status: 'completed',
            reason: 'instructions_updated',
            message: 'Saved and reopened',
          },
          tabs: tabResult(),
        };
      },
      selectWorkspace: async () => {
        panel.workspace_id = workspace.workspace_id;
        return tabResult();
      },
      getEditorState: async () => ({
        workspace_id: workspace.workspace_id,
        active_editor_tab_id: null,
        tabs: [],
      }),
      copyProjectBinding: async () => {
        state.calls.push('manual-copy');
        return { binding_text: 'Fixture instructions' };
      },
      updateChatGptTab: async () => {
        throw new Error('A local confirmation is not remote save evidence');
      },
    };
  }, desktopStatus);
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const addFolder = page.getByRole('button', { name: '프로젝트 폴더 추가', exact: true });
  await addFolder.click();
  await page.getByText('연결됨', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.projectSetupFixture.calls), [
    'folder',
    'automatic-setup',
  ]);
  assert.equal(await page.getByRole('button', { name: '저장 상태 확인', exact: true }).count(), 0);
  await addFolder.click();
  assert.deepEqual(await page.evaluate(() => window.projectSetupFixture.calls), [
    'folder',
    'automatic-setup',
    'folder',
  ]);

  await page.evaluate(() => {
    window.projectSetupFixture.tabs[0].project_instructions_confirmed = false;
  });
  await page.getByText('설정 필요', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Project setup fixture ChatGPT Project 열기', exact: true })
    .click();
  await page.getByText('연결됨', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.projectSetupFixture.calls), [
    'folder',
    'automatic-setup',
    'folder',
    'automatic-setup',
  ]);

  await page.evaluate(() => {
    window.projectSetupFixture.tabs[0].project_instructions_confirmed = false;
    window.projectSetupFixture.fail = true;
  });
  await page.getByText('설정 필요', { exact: true }).waitFor();
  await addFolder.click();
  await page.getByText('자동 연결 실패', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.projectSetupFixture.tabs[0].project_instructions_confirmed),
    false,
  );
  assert.equal(
    await page.evaluate(() => window.projectSetupFixture.calls.includes('manual-copy')),
    false,
  );
  assert.deepEqual(pageErrors, []);
  await page.screenshot({
    path: join(evidenceDirectory, 'failed-save-is-unconfirmed.png'),
    fullPage: true,
  });
  await openProjectSettings(page, 'Project setup fixture');
  const manualSetup = page.getByRole('button', { name: '기존 프로젝트에 직접 연결', exact: true });
  try {
    await manualSetup.click({ timeout: 5_000 });
  } catch (error) {
    await page.screenshot({ path: join(evidenceDirectory, 'fallback-diagnostic.png') });
    console.error(
      JSON.stringify({ pageErrors, visibleText: await page.locator('body').innerText() }),
    );
    throw error;
  }
  const savedStateCheck = page.getByRole('button', { name: '저장 상태 확인', exact: true });
  await savedStateCheck.click();
  await page.getByText('지침 확인 필요', { exact: true }).first().waitFor();
  assert.equal(
    await page.evaluate(() => window.projectSetupFixture.tabs[0].project_instructions_confirmed),
    false,
  );
  assert.equal(
    await page.evaluate(
      () => window.projectSetupFixture.calls.filter((call) => call === 'automatic-setup').length,
    ),
    4,
  );
  assert.deepEqual(pageErrors, []);
  // A historical confirmation must not clear a fresh instruction verification issue.
  await page.evaluate(() => {
    window.projectSetupFixture.tabs[0].project_instructions_confirmed = true;
    window.projectSetupFixture.instructionIssue = 'project_home_required';
  });
  const checksBefore = await page.evaluate(() => window.projectSetupFixture.instructionChecks);
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    (count) => window.projectSetupFixture.instructionChecks >= count + 2,
    checksBefore,
  );
  await page.getByText('지침 확인 필요', { exact: true }).first().waitFor();
  await openProjectSettings(page, 'Project setup fixture');
  await page.waitForFunction(() =>
    document.body.innerText.includes('연결된 Project 홈에서 확인하며'),
  );
  await page.getByRole('button', { name: '저장 상태 확인', exact: true }).waitFor();
  const setupCallsBeforeRecovery = await page.evaluate(
    () => window.projectSetupFixture.calls.filter((call) => call === 'automatic-setup').length,
  );
  const copyCallsBeforeRecovery = await page.evaluate(
    () => window.projectSetupFixture.calls.filter((call) => call === 'manual-copy').length,
  );
  await page.evaluate(() => {
    window.projectSetupFixture.instructionIssue = 'automation_deferred';
    window.projectSetupFixture.manualInstructionFailure = true;
  });
  await page.getByRole('button', { name: '저장 상태 확인', exact: true }).click();
  await page.waitForFunction(() =>
    window.projectSetupFixture.calls.includes('manual-instructions-update'),
  );
  await page.getByText('지침 확인 필요', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '저장 상태 확인', exact: true }).count(), 1);
  await page.evaluate(() => {
    window.projectSetupFixture.manualInstructionFailure = false;
  });
  await page.getByRole('button', { name: '저장 상태 확인', exact: true }).click();
  await page.getByText('이 Project에서 새 채팅을 시작하세요', { exact: true }).first().waitFor();
  assert.equal(
    await page.evaluate(
      () => window.projectSetupFixture.calls.filter((call) => call === 'automatic-setup').length,
    ),
    setupCallsBeforeRecovery,
  );
  assert.equal(
    await page.evaluate(
      () => window.projectSetupFixture.calls.filter((call) => call === 'manual-copy').length,
    ),
    copyCallsBeforeRecovery,
  );
  assert.deepEqual(pageErrors, []);
  await page.screenshot({
    path: join(evidenceDirectory, 'verified-instructions-new-chat-required.png'),
    fullPage: true,
  });
  await verifyPointerProjectFlow(browser, evidenceDirectory);
  await verifyConversationRecovery(browser, evidenceDirectory);
  console.log(
    JSON.stringify({
      passed: true,
      bridgeFixture: true,
      folderToAutomaticSetup: true,
      retainedProjectRecovery: true,
      failedSaveNotConfirmed: true,
      fallbackRequiresRealVerification: true,
      pointerMenuAndFullDocumentNavigation: true,
      conversationPreservedDuringInstructionsRecovery: true,
      emptyInstructionsRestoredWithVerifiedSave: true,
      historicalConfirmationDoesNotHideVerificationFailure: true,
      evidenceDirectory,
      pageErrors,
    }),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await runtime.close();
}
