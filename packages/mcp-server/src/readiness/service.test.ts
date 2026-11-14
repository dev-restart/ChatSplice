import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ProjectReadinessOperationSchema,
  ProjectReadinessResultSchema,
} from '@chatsplice/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { executeReadinessProbe } from './service.js';

const servers: Server[] = [];

async function fixture(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('model-free readiness probe', () => {
  it('uses credential-free HEAD, retries a 503 and stops as soon as status matches', async () => {
    const requests: { method: string | undefined; credentials: unknown }[] = [];
    const url = await fixture((request, response) => {
      requests.push({
        method: request.method,
        credentials: request.headers.authorization ?? request.headers.cookie,
      });
      response.statusCode = requests.length === 1 ? 503 : 204;
      response.setHeader('Set-Cookie', 'private-cookie');
      response.end('private-response-body');
    });
    const output: string[] = [];
    const operation = ProjectReadinessOperationSchema.parse({
      kind: 'readiness',
      url: `${url}/health?private-token=not-returned`,
      expected_status: 204,
      attempts: 5,
      interval_ms: 100,
    });
    const result = await executeReadinessProbe(operation, {
      signal: new AbortController().signal,
      onOutput: (chunk) => output.push(chunk),
    });
    expect(result.exit_code).toBe(0);
    expect(result.readiness_result).toMatchObject({
      method: 'HEAD',
      url: `${url}/health`,
      ready: true,
      attempts_used: 2,
      status_code: 204,
      failure: null,
      attempts: [
        { attempt: 1, status_code: 503, failure: 'unexpected_status' },
        { attempt: 2, status_code: 204, failure: null },
      ],
    });
    expect(requests).toEqual([
      { method: 'HEAD', credentials: undefined },
      { method: 'HEAD', credentials: undefined },
    ]);
    expect(ProjectReadinessResultSchema.safeParse(result.readiness_result).success).toBe(true);
    expect(output.join('')).not.toContain('private');
    expect(output.join('')).not.toContain('not-returned');
  });

  it('does not follow redirects, including a redirect to another local endpoint', async () => {
    let destinationRequests = 0;
    const destination = await fixture((_request, response) => {
      destinationRequests += 1;
      response.end();
    });
    const source = await fixture((_request, response) => {
      response.writeHead(302, { Location: `${destination}/private` });
      response.end();
    });
    const result = await executeReadinessProbe(
      ProjectReadinessOperationSchema.parse({ kind: 'readiness', url: source }),
      { signal: new AbortController().signal },
    );
    expect(result.exit_code).toBe(1);
    expect(result.readiness_result.status_code).toBe(302);
    expect(result.readiness_result.failure).toBe('unexpected_status');
    expect(destinationRequests).toBe(0);
  });

  it('reports fixed connection failures without raw socket details', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await executeReadinessProbe(
      ProjectReadinessOperationSchema.parse({
        kind: 'readiness',
        url: `http://127.0.0.1:${port}/health`,
        attempts: 2,
        interval_ms: 100,
      }),
      { signal: new AbortController().signal },
    );
    expect(result.exit_code).toBe(1);
    expect(result.readiness_result).toMatchObject({
      ready: false,
      attempts_used: 2,
      failure: 'connection_error',
      status_code: null,
    });
  });

  it('bounds each attempt even when the endpoint never sends response headers', async () => {
    const url = await fixture(() => {});
    const result = await executeReadinessProbe(
      ProjectReadinessOperationSchema.parse({
        kind: 'readiness',
        url,
        request_timeout_ms: 100,
        attempts: 2,
        interval_ms: 100,
      }),
      { signal: new AbortController().signal },
    );
    expect(result.exit_code).toBe(1);
    expect(result.timed_out).toBe(false);
    expect(result.readiness_result.attempts).toHaveLength(2);
    expect(
      result.readiness_result.attempts.every((entry) => entry.failure === 'request_timeout'),
    ).toBe(true);
    expect(result.duration_ms).toBeLessThan(2000);
  });

  it('cancels an active request and does not retry afterwards', async () => {
    const controller = new AbortController();
    let requests = 0;
    const url = await fixture(() => {
      requests += 1;
      controller.abort();
    });
    await expect(
      executeReadinessProbe(
        ProjectReadinessOperationSchema.parse({ kind: 'readiness', url, attempts: 10 }),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });

  it('cancels a retry delay before starting another request', async () => {
    const controller = new AbortController();
    let requests = 0;
    const url = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(503);
      response.end();
    });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        executeReadinessProbe(
          ProjectReadinessOperationSchema.parse({
            kind: 'readiness',
            url,
            attempts: 10,
            interval_ms: 5000,
          }),
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer);
    }
    expect(requests).toBe(1);
  });

  it('never connects when already cancelled and pins localhost to IPv4 loopback', async () => {
    let requests = 0;
    const url = await fixture((_request, response) => {
      requests += 1;
      response.end();
    });
    const operation = ProjectReadinessOperationSchema.parse({
      kind: 'readiness',
      url: url.replace('127.0.0.1', 'localhost'),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeReadinessProbe(operation, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(0);
    const result = await executeReadinessProbe(operation, { signal: new AbortController().signal });
    expect(result.exit_code).toBe(0);
    expect(requests).toBe(1);
  });

  it('validates its operation again before sending a request', async () => {
    await expect(
      executeReadinessProbe(
        {
          kind: 'readiness',
          url: 'http://outside.example/health',
          attempts: 1,
          interval_ms: 100,
          request_timeout_ms: 100,
          expected_status: 200,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('literal loopback');
  });

  it('bounds response headers and handles invalid HTTP statuses without echoing them', async () => {
    const oversizedHeaders = await fixture((_request, response) => {
      response.setHeader('X-Private', 'private'.repeat(2000));
      response.end();
    });
    const invalidStatus = await fixture((_request, response) => {
      response.statusCode = 799;
      response.end();
    });
    for (const url of [oversizedHeaders, invalidStatus]) {
      const result = await executeReadinessProbe(
        ProjectReadinessOperationSchema.parse({ kind: 'readiness', url }),
        { signal: new AbortController().signal },
      );
      expect(result.exit_code).toBe(1);
      expect(result.readiness_result.failure).toBe('connection_error');
      expect(result.readiness_result.status_code).toBe(null);
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });
});
