import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, fetchFile } = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  fetchFile: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: fetchFile },
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      handlers.set(scheme, handler);
    },
  },
}));

import { registerLocalRendererProtocol } from './local-protocol.js';

describe('local renderer dynamic style policy', () => {
  let html: string;

  beforeEach(async () => {
    html = await readFile(new URL('../renderer/index.html', import.meta.url), 'utf8');
    fetchFile.mockReset();
    fetchFile.mockImplementation(
      async () =>
        new Response(html, {
          headers: {
            'content-type': 'text/html',
            'content-length': String(Buffer.byteLength(html)),
          },
        }),
    );
    handlers.clear();
    registerLocalRendererProtocol('/renderer');
  });

  it('allows owner console/editor styles while retaining script and network policy', async () => {
    for (const scheme of ['chatsplice', 'localchat']) {
      for (const path of ['/', '/index.html']) {
        for (const surface of ['console', 'editor']) {
          const response = await handlers.get(scheme)!(
            new Request(`${scheme}://renderer${path}?surface=${surface}`),
          );
          const rendered = await response.text();
          expect(rendered).toContain("style-src 'self' 'unsafe-inline';");
          expect(rendered).toContain("script-src 'self';");
          expect(rendered).toContain("connect-src 'none';");
          expect(rendered.match(/Content-Security-Policy/g)).toHaveLength(1);
          expect(rendered.match(/unsafe-inline/g)).toHaveLength(1);
          expect(response.headers.get('content-length')).toBeNull();
        }
      }
    }
  });

  it('preserves the restrictive policy for all other surfaces and assets', async () => {
    for (const path of [
      '/',
      '/?surface=files',
      '/?surface=chrome',
      '/?surface=edge',
      '/?surface=editor-extra',
      '/app.js?surface=console',
    ]) {
      const response = await handlers.get('chatsplice')!(
        new Request(`chatsplice://renderer${path}`),
      );
      expect(await response.text()).toBe(html);
    }
  });
});
