import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/welcome.js', ['src/welcome.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const file = files.get(request.url);
  if (request.method !== 'GET' || file === undefined) {
    response.writeHead(404).end();
    return;
  }

  const [name, type] = file;
  try {
    const contents = await readFile(new URL(name, import.meta.url));
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(contents);
  } catch {
    response.writeHead(500).end('The preview file could not be read.');
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${server.address().port}/`);
});
