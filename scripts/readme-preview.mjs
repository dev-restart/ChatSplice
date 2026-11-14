import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout } from 'node:timers';
import process from 'node:process';
import console from 'node:console';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
if (process.versions.electron === undefined) {
  const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
  let executable = requireDesktop('electron');
  if (process.platform === 'darwin') {
    const prepared = execFileSync(
      process.execPath,
      [join(root, 'scripts/run-branded-electron.mjs')],
      {
        cwd: join(root, 'apps/desktop'),
        env: { ...process.env, CHATSPLICE_BRANDED_PREPARE_ONLY: '1' },
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n')
      .at(-1);
    executable = join(prepared, 'Contents/MacOS/Electron');
  }
  const profile = await mkdtemp(join(tmpdir(), 'chatsplice-readme-preview-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn(executable, [scriptPath, profile], {
        env: environment,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code !== 0) console.error(`Preview Electron exited: ${code ?? signal}`);
        resolveExit(code);
      });
    });
    process.exitCode = code ?? 1;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  async function renderPreview() {
    app.setPath('userData', process.argv[2]);
    await app.whenReady();
    const renderRoot = join(root, 'apps/desktop/dist/renderer');
    const frame = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#171717;color:#eee;font:13px -apple-system,BlinkMacSystemFont,sans-serif}
  header{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #333}small{color:#b5becb}main{display:grid;grid-template-columns:280px 1fr 280px;height:856px}iframe{border:0;width:100%;height:100%;display:block}#center{display:grid;grid-template-rows:636px 220px}#sidebar{border-right:1px solid #333}#files{border-left:1px solid #333}
  </style></head><body><header><b>ChatSplice</b><small>제품 미리보기 · 가상 데이터 / Fictional demo data</small></header><main><iframe id="sidebar" src="/index.html"></iframe><div id="center"><iframe id="editor" src="/index.html?surface=editor"></iframe><iframe id="console" src="/index.html?surface=console"></iframe></div><iframe id="files" src="/index.html?surface=files"></iframe></main></body></html>`;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost');
        const path = url.pathname;
        if (path === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(frame);
          return;
        }
        const file = resolve(renderRoot, `.${decodeURIComponent(path)}`);
        if (!file.startsWith(`${renderRoot}/`)) throw new Error('outside preview renderer');
        response.setHeader(
          'Content-Type',
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
          }[extname(file)] ?? 'application/octet-stream',
        );
        let bytes = await readFile(file);
        if (
          path === '/index.html' &&
          ['editor', 'console'].includes(url.searchParams.get('surface'))
        ) {
          // Mirror the owner-only style policy used by local-protocol.ts.
          bytes = bytes
            .toString('utf8')
            .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");
        }
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const previewSession = session.fromPartition('readme-preview');
    previewSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(`${origin}/`) }),
    );
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      useContentSize: true,
      show: false,
      webPreferences: {
        session: previewSession,
        preload: join(root, 'scripts/readme-preview-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await window.loadURL(origin);
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 1600));
      await window.webContents.executeJavaScript(
        `document.querySelector('#files').contentDocument.querySelector('.tree-expand')?.click()`,
      );
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
      const content = await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('iframe')).map(frame => frame.contentDocument.body.innerText).join('\\n')`,
      );
      if (!content.includes('WelcomeCard.tsx') || !content.includes('demo-design'))
        throw new Error('Demo renderer did not finish loading.');
      await writeFile(
        join(root, 'docs/images/workbench-demo.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await window.webContents.executeJavaScript(`
      const sidebar = document.querySelector('#sidebar');
      sidebar.style.cssText = 'position:absolute;left:0;top:44px;width:1440px;height:856px;z-index:2';
      sidebar.contentDocument.querySelector('.runtime-footer-nudge').click();
    `);
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
      const connectionText = await window.webContents.executeJavaScript(
        `document.querySelector('#sidebar').contentDocument.body.innerText`,
      );
      if (!connectionText.includes('ChatGPT에 등록한 MCP 앱 이름'))
        throw new Error('Demo connection dialog did not open.');
      await writeFile(
        join(root, 'docs/images/connection-demo.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log(
        'Created public preview using fictional data; no ChatGPT page or real workspace was loaded.',
      );
    } finally {
      window.destroy();
      server.close();
      app.quit();
    }
  }
  // Let Electron finish loading the entry module before waiting for ready/I/O.
  void renderPreview().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
