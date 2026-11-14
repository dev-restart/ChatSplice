import { createServer } from 'node:http';

import { ProjectExecInputSchema, type ProjectBrowserAction } from '@chatsplice/protocol';
import { describe, expect, it } from 'vitest';

import { ProjectBrowserService } from './service.js';

// Explicit opt-in: real installed Chromium, disposable context, loopback fixture.
// Never connects to the user's browser, application data or ChatGPT profile.
describe.skipIf(process.env.CHATSPLICE_BROWSER_TESTS !== '1')('real browser assertions', () => {
  it('checks async outcomes, captures failures and recovers at a narrow viewport', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Browser assertion fixture</title></head><body>
      <label for="name">Test name</label><input id="name">
      <button data-testid="save">Save</button><p id="result">Ready</p>
      <button id="load-late">Load action</button>
      <button class="ambiguous">First</button><button class="ambiguous">Second</button>
      <button id="${'long-id'.repeat(150)}" data-testid="long-identifier">Long identifier</button>
      <script>document.querySelector('button').onclick = () => {
        setTimeout(() => {
          document.querySelector('#result').textContent = 'Saved: ' +
            document.querySelector('#name').value;
        }, 150);
      };
      document.querySelector('#load-late').onclick = () => {
        setTimeout(() => {
          const late = document.createElement('button');
          late.id = 'late'; late.textContent = 'Delayed action';
          late.onclick = () => { document.querySelector('#result').textContent = 'Late saved'; };
          document.body.append(late);
        }, 1000);
      };</script></body></html>`;
    const server = createServer((request, response) => {
      const failed = request.url === '/unavailable';
      response.writeHead(failed ? 503 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(failed ? '<h1>Temporarily unavailable</h1>' : html);
    });
    const browser = new ProjectBrowserService();
    let sequence = 0;
    const run = (action: ProjectBrowserAction) =>
      browser.execute(
        ProjectExecInputSchema.parse({
          workspace_id: 'ws_0123456789abcdef01234567',
          workspace_binding: `wb_${'a'.repeat(64)}`,
          request_id: `browser-assertion-${++sequence}`,
          operation: { kind: 'browser', action },
          timeout_ms: 10000,
        }),
        {
          signal: new AbortController().signal,
          onStart: () => undefined,
          onOutput: () => undefined,
        },
        process.cwd(),
      );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No fixture port');
      const url = `http://127.0.0.1:${address.port}/`;
      const opened = await run({ kind: 'open', url });
      expect(opened.exit_code).toBe(0);
      expect(opened.browser_result?.controls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ selector: '#name', text: 'Test name' }),
          expect.objectContaining({ selector: '[data-testid="save"]', text: 'Save' }),
          expect.objectContaining({
            selector: '[data-testid="long-identifier"]',
            text: 'Long identifier',
          }),
        ]),
      );
      expect(
        (await run({ kind: 'click', selector: '[data-testid="long-identifier"]' })).exit_code,
      ).toBe(0);
      const filled = await run({ kind: 'fill', selector: '#name', value: 'demo' });
      expect(filled.exit_code).toBe(0);
      const value = await run({
        kind: 'assert',
        expectation: { kind: 'value', selector: '#name', value: 'demo' },
      });
      expect(value.exit_code).toBe(0);
      const clicked = await run({ kind: 'click', selector: '[data-testid="save"]' });
      expect(clicked.exit_code).toBe(0);
      const saved = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Saved: demo', exact: true },
      });
      expect(saved.exit_code).toBe(0);
      expect(saved.browser_result?.text).toContain('Saved: demo');
      const failed = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Incorrect expectation' },
        timeout_ms: 100,
      });
      expect(failed.exit_code).toBe(1);
      expect(failed.browser_result?.screenshot_available).toBe(true);
      expect(failed.image?.data.byteLength).toBeGreaterThan(0);
      expect(failed.image!.data.byteLength).toBeLessThanOrEqual(1024 * 1024);
      const ambiguous = await run({ kind: 'click', selector: '.ambiguous' });
      expect(ambiguous.exit_code).toBe(1);
      expect(ambiguous.browser_result?.screenshot_available).toBe(true);
      expect(ambiguous.browser_result?.text).toContain('Saved: demo');
      expect((await run({ kind: 'click', selector: '#load-late' })).exit_code).toBe(0);
      expect((await run({ kind: 'click', selector: '#late' })).exit_code).toBe(0);
      const delayed = await run({
        kind: 'assert',
        expectation: { kind: 'text', selector: '#result', text: 'Late saved', exact: true },
      });
      expect(delayed.exit_code).toBe(0);
      const mobile = await run({ kind: 'open', url, width: 390, height: 844 });
      expect(mobile.exit_code).toBe(0);
      expect(mobile.browser_result).toMatchObject({ width: 390, height: 844 });
      for (const expectation of [
        { kind: 'visible', selector: '#name' },
        { kind: 'hidden', selector: '#missing' },
        { kind: 'url', url },
      ] as const) {
        expect((await run({ kind: 'assert', expectation })).exit_code).toBe(0);
      }
      const unavailable = await run({ kind: 'open', url: `${url}unavailable` });
      expect(unavailable.exit_code).toBe(1);
      expect(unavailable.browser_result?.text).toContain('Temporarily unavailable');
      expect(
        unavailable.browser_result?.console.some((line) => line.includes('http-error: 503')),
      ).toBe(true);
      expect((await run({ kind: 'open', url })).exit_code).toBe(0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60000);
});
