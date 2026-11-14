import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { log } from '../logging.js';

export const MCP_REQUEST_ID_HEADER = 'x-chatsplice-request-id';

interface ObservedResponse {
  readonly headersSent: boolean;
  readonly writableFinished: boolean;
  readonly statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: 'finish' | 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'finish' | 'close' | 'error', listener: () => void): unknown;
}

export interface McpRequestObservation {
  readonly request_id: string;
  error(source: 'handler' | 'adapter' | 'request' | 'response'): void;
}

/** Observe server response delivery, never the contents or success of an MCP tool.
 * A finish event means Node handed off the response; it does not prove client receipt.
 * There is no timer, retry, response termination or process-wide request registry.
 */
export function observeMcpResponse(
  response: ObservedResponse,
  options: { readonly now?: () => number; readonly record?: typeof log } = {},
): McpRequestObservation {
  const now = options.now ?? (() => performance.now());
  const record = options.record ?? log;
  const requestId = randomUUID();
  const started = now();
  let terminal = false;
  let errorRecorded = false;
  const elapsed = (): number => Math.max(0, Math.trunc(now() - started));
  const emit = (
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void => {
    try {
      record(level, event, { request_id: requestId, duration_ms: elapsed(), ...fields });
    } catch {
      // Diagnostics must not turn a healthy response into a transport failure.
    }
  };
  const error: McpRequestObservation['error'] = (source) => {
    if (terminal || errorRecorded) return;
    errorRecorded = true;
    emit('error', 'mcp_request_error', {
      source,
      status_code: response.statusCode,
      response_finished: response.writableFinished,
    });
  };
  const onError = (): void => error('response');
  const settle = (finished: boolean): void => {
    if (terminal) return;
    terminal = true;
    response.removeListener('finish', onFinish);
    response.removeListener('close', onClose);
    response.removeListener('error', onError);
    emit(
      finished ? 'info' : 'warn',
      finished ? 'mcp_response_finished' : 'mcp_response_interrupted',
      {
        status_code: response.statusCode,
        response_finished: finished,
        error_observed: errorRecorded,
      },
    );
  };
  const onFinish = (): void => settle(true);
  const onClose = (): void => settle(response.writableFinished);
  response.once('finish', onFinish);
  response.once('close', onClose);
  response.once('error', onError);
  if (!response.headersSent) response.setHeader(MCP_REQUEST_ID_HEADER, requestId);
  emit('info', 'mcp_request_received', {});
  return { request_id: requestId, error };
}
