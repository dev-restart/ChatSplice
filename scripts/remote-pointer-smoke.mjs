// Run from the repository root after build:
// pnpm --filter @chatsplice/desktop exec electron ../../scripts/remote-pointer-smoke.mjs
// This uses an isolated local fixture only; never the owner's ChatGPT profile.
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

import { CHATGPT_NO_DRAG_CSS } from '../apps/desktop/dist/main/remote-pointer-policy.js';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { app, BaseWindow, WebContentsView } = require('electron');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'chatsplice-pointer-smoke-')));
let stage = 'app-ready';
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ fixture: 'isolated-loopback', state: 'timeout', stage }));
  app.exit(1);
}, 15000);

async function runFixture() {
  let window;
  let chrome;
  let remote;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><style>
      body { margin: 0; }
      header { height: 80px; -webkit-app-region: drag !important; }
      button { width: 80px; height: 50px; margin: 10px; }
      #disabled { pointer-events: none; }
    </style><header><button id="home">Home</button></header>
    <button id="disabled" disabled>Disabled</button>
    <script>window.fixtureClicks = 0;
      document.querySelector('#home').onclick = () => { window.fixtureClicks += 1; };
    </script>`);
  });
  try {
    stage = 'loopback-listen';
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    window = new BaseWindow({ width: 800, height: 500, show: false, title: 'Local pointer test' });
    const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
    chrome = new WebContentsView({ webPreferences: preferences });
    remote = new WebContentsView({ webPreferences: preferences });
    window.contentView.addChildView(chrome);
    window.contentView.addChildView(remote);
    chrome.setBounds({ x: 0, y: 0, width: 800, height: 80 });
    remote.setBounds({ x: 0, y: 80, width: 800, height: 380 });
    stage = 'fixture-load';
    await Promise.all([chrome.webContents.loadURL(url), remote.webContents.loadURL(url)]);
    const region = `getComputedStyle(document.querySelector('header')).getPropertyValue('-webkit-app-region')`;
    stage = 'css-cascade';
    assert.equal(await remote.webContents.executeJavaScript(region), 'drag');
    await remote.webContents.insertCSS(CHATGPT_NO_DRAG_CSS, { cssOrigin: 'user' });
    assert.equal(await remote.webContents.executeJavaScript(region), 'no-drag');
    assert.equal(await chrome.webContents.executeJavaScript(region), 'drag');
    assert.equal(
      await remote.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('#disabled')).pointerEvents`,
      ),
      'none',
    );
    window.show();
    window.focus();
    remote.webContents.focus();
    stage = 'synthetic-click';
    remote.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 40,
      y: 30,
      button: 'left',
      clickCount: 1,
    });
    remote.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 40,
      y: 30,
      button: 'left',
      clickCount: 1,
    });
    const clicks = await remote.webContents.executeJavaScript('window.fixtureClicks');
    assert.equal(clicks, 1);
    console.log(
      JSON.stringify({
        fixture: 'isolated-loopback',
        remote_app_region: 'no-drag',
        local_chrome_app_region: 'drag',
        disabled_pointer_events: 'none',
        synthetic_clicks: clicks,
        real_chatgpt_ui_checked: false,
        physical_mouse_hit_test_checked: false,
      }),
    );
  } catch (error) {
    console.error(stage, error instanceof Error ? error.message : 'Pointer fixture failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (remote && !remote.webContents.isDestroyed()) remote.webContents.close();
    if (chrome && !chrome.webContents.isDestroyed()) chrome.webContents.close();
    if (window && !window.isDestroyed()) window.destroy();
    server.close();
    app.exit(process.exitCode ?? 0);
  }
}

// Do not await app readiness at ESM top level: the entry module must finish first.
void app
  .whenReady()
  .then(runFixture)
  .catch((error) => {
    console.error('app-ready', error instanceof Error ? error.message : 'App readiness failed');
    clearTimeout(deadline);
    app.exit(1);
  });
