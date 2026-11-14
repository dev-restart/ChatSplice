import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

function isWithin(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..');
}

export function registerLocalRendererProtocol(rendererDirectory: string): void {
  for (const scheme of ['chatsplice', 'localchat']) {
    protocol.handle(scheme, async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'renderer') {
        return new Response('Not found', { status: 404 });
      }
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = resolve(rendererDirectory, `.${requested}`);
      if (!isWithin(rendererDirectory, target)) {
        return new Response('Not found', { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(target).toString());
      if (
        !response.ok ||
        target !== resolve(rendererDirectory, 'index.html') ||
        !['console', 'editor'].includes(url.searchParams.get('surface') ?? '')
      ) {
        return response;
      }

      // xterm's DOM renderer generates style elements for cell dimensions,
      // fonts and the cursor, plus style attributes for ANSI truecolor.
      // Permit those only in owner terminal/editor views; script and network
      // restrictions remain unchanged.
      // Replace the existing meta policy: adding a second policy cannot relax it.
      const html = (await response.text()).replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/,
        (_match, prefix: string, policy: string, suffix: string) =>
          `${prefix}${policy.replace(
            "style-src 'self';",
            "style-src 'self' 'unsafe-inline';",
          )}${suffix}`,
      );
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  }
}
