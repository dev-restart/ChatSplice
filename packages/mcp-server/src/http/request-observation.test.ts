import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { MCP_REQUEST_ID_HEADER, observeMcpResponse } from './request-observation.js';

class ResponseFixture extends EventEmitter {
  headersSent = false;
  writableFinished = false;
  statusCode = 200;
  readonly headers = new Map<string, string>();
  readonly end = vi.fn();
  readonly destroy = vi.fn();
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

describe('MCP response observations', () => {
  it('correlates receipt and one finish record without treating the later close as an interruption', () => {
    const response = new ResponseFixture();
    const record = vi.fn();
    let clock = 100;
    const observation = observeMcpResponse(response, { now: () => clock, record });
    expect(observation.request_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(response.headers.get(MCP_REQUEST_ID_HEADER)).toBe(observation.request_id);
    clock = 142.9;
    response.statusCode = 202;
    response.writableFinished = true;
    response.emit('finish');
    response.emit('close');
    expect(record.mock.calls).toEqual([
      ['info', 'mcp_request_received', { request_id: observation.request_id, duration_ms: 0 }],
      [
        'info',
        'mcp_response_finished',
        {
          request_id: observation.request_id,
          duration_ms: 42,
          status_code: 202,
          response_finished: true,
          error_observed: false,
        },
      ],
    ]);
    expect(response.listenerCount('finish')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
    expect(response.end).not.toHaveBeenCalled();
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it('records a premature close separately and never closes or retries a request itself', () => {
    const response = new ResponseFixture();
    const record = vi.fn();
    let clock = 10;
    const observation = observeMcpResponse(response, { now: () => clock, record });
    clock = 87;
    response.emit('close');
    response.emit('finish');
    expect(record).toHaveBeenLastCalledWith('warn', 'mcp_response_interrupted', {
      request_id: observation.request_id,
      duration_ms: 77,
      status_code: 200,
      response_finished: false,
      error_observed: false,
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(response.end).not.toHaveBeenCalled();
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it('records only allowlisted error metadata once and keeps the terminal response evidence', () => {
    const response = new ResponseFixture();
    const record = vi.fn();
    const observation = observeMcpResponse(response, { record });
    observation.error('adapter');
    observation.error('handler');
    response.emit(
      'error',
      new Error('private token, command, and request body must not be logged'),
    );
    response.statusCode = 500;
    response.writableFinished = true;
    response.emit('finish');
    expect(record.mock.calls.map((call) => call[1])).toEqual([
      'mcp_request_received',
      'mcp_request_error',
      'mcp_response_finished',
    ]);
    const fields = record.mock.calls[1]![2];
    expect(Object.keys(fields).sort()).toEqual([
      'duration_ms',
      'request_id',
      'response_finished',
      'source',
      'status_code',
    ]);
    expect(fields.source).toBe('adapter');
    expect(JSON.stringify(record.mock.calls)).not.toContain('private token');
    expect(record.mock.calls[2]![2]).toMatchObject({
      request_id: observation.request_id,
      status_code: 500,
      error_observed: true,
    });
  });

  it('keeps request identifiers distinct and contains logger failure', () => {
    const first = new ResponseFixture();
    const second = new ResponseFixture();
    const failedLogger = vi.fn(() => {
      throw new Error('closed log sink');
    });
    const left = observeMcpResponse(first, { record: failedLogger });
    const right = observeMcpResponse(second, { record: failedLogger });
    expect(left.request_id).not.toBe(right.request_id);
    expect(() => {
      left.error('request');
      first.writableFinished = true;
      first.emit('finish');
      second.emit('close');
    }).not.toThrow();
    expect(first.end).not.toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(first.listenerCount('close')).toBe(0);
    expect(second.listenerCount('finish')).toBe(0);
  });
});
