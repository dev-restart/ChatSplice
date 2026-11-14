import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ProjectReadinessOperationSchema,
  ProjectReadinessResultSchema,
} from '@chatsplice/protocol';
import type {
  ProjectReadinessAttempt,
  ProjectReadinessOperation,
  ProjectReadinessResult,
} from '@chatsplice/protocol';

export interface ReadinessExecutionResult {
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly timed_out: false;
  readonly readiness_result: ProjectReadinessResult;
}

export interface ReadinessProbeOptions {
  readonly signal: AbortSignal;
  readonly onOutput?: (chunk: string) => void;
}

function aborted(): Error {
  const error = new Error('Readiness probe cancelled.');
  error.name = 'AbortError';
  return error;
}

async function probeOnce(
  operation: ProjectReadinessOperation,
  attempt: number,
  signal: AbortSignal,
): Promise<ProjectReadinessAttempt> {
  if (signal.aborted) throw aborted();
  const url = new URL(operation.url);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        // Do not resolve "localhost" through DNS or inherit an HTTP proxy.
        hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'HEAD',
        headers: { Host: url.host, Connection: 'close' },
        agent: false,
        maxHeaderSize: 8192,
        ...(url.protocol === 'https:' && url.hostname === 'localhost'
          ? { servername: 'localhost' }
          : {}),
      },
      (response) => {
        const observedStatus = response.statusCode;
        const status =
          observedStatus !== undefined && observedStatus >= 100 && observedStatus <= 599
            ? observedStatus
            : null;
        finish({
          attempt,
          status_code: status,
          duration_ms: Math.max(0, Date.now() - start),
          failure:
            status === operation.expected_status
              ? null
              : status === null
                ? 'connection_error'
                : 'unexpected_status',
        });
        // Never consume a response body or follow a Location header.
        response.destroy();
        request.destroy();
      },
    );
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    function finish(result: ProjectReadinessAttempt): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }
    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(aborted());
    }
    request.once('error', () => {
      finish({
        attempt,
        status_code: null,
        duration_ms: Math.max(0, Date.now() - start),
        failure: 'connection_error',
      });
    });
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      finish({
        attempt,
        status_code: null,
        duration_ms: Math.max(0, Date.now() - start),
        failure: 'request_timeout',
      });
      request.destroy();
    }, operation.request_timeout_ms);
    if (signal.aborted) onAbort();
    if (!settled) request.end();
  });
}

/** A bounded, credential-free HEAD probe. It does not assert process ownership. */
export async function executeReadinessProbe(
  input: ProjectReadinessOperation,
  options: ReadinessProbeOptions,
): Promise<ReadinessExecutionResult> {
  const operation = ProjectReadinessOperationSchema.parse(input);
  if (options.signal.aborted) throw aborted();
  const started = Date.now();
  const attempts: ProjectReadinessAttempt[] = [];
  for (let attempt = 1; attempt <= operation.attempts; attempt += 1) {
    const result = await probeOnce(operation, attempt, options.signal);
    attempts.push(result);
    if (result.failure === null || attempt === operation.attempts) break;
    await delay(operation.interval_ms, undefined, { signal: options.signal });
  }
  if (options.signal.aborted) throw aborted();
  const last = attempts[attempts.length - 1];
  if (!last) throw new Error('Readiness probe produced no result.');
  const url = new URL(operation.url);
  const duration = Math.max(0, Date.now() - started);
  const readiness = ProjectReadinessResultSchema.parse({
    url: url.origin + url.pathname,
    method: 'HEAD',
    expected_status: operation.expected_status,
    ready: last.failure === null,
    attempts_used: attempts.length,
    status_code: last.status_code,
    duration_ms: duration,
    failure: last.failure,
    attempts,
  });
  options.onOutput?.(`${JSON.stringify(readiness)}\n`);
  return {
    exit_code: readiness.ready ? 0 : 1,
    duration_ms: duration,
    timed_out: false,
    readiness_result: readiness,
  };
}
