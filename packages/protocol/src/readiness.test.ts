import { describe, expect, it } from 'vitest';

import { isLocalReadinessUrl, ProjectReadinessOperationSchema } from './readiness.js';

describe('bounded loopback readiness contract', () => {
  it('accepts literal loopback HTTP(S) and supplies finite retry defaults', () => {
    for (const url of [
      'http://localhost:5173/health',
      'http://127.0.0.1:8000/',
      'https://[::1]:8443/ready',
    ]) {
      expect(isLocalReadinessUrl(url)).toBe(true);
      expect(ProjectReadinessOperationSchema.parse({ kind: 'readiness', url })).toEqual({
        kind: 'readiness',
        url,
        expected_status: 200,
        attempts: 1,
        interval_ms: 500,
        request_timeout_ms: 1000,
      });
    }
  });

  it.each([
    'http://example.com/health',
    'http://localhost.example.com/health',
    'http://127.0.0.2/health',
    'http://127.1/health',
    'http://2130706433/health',
    'http://0x7f000001/health',
    'http://[::ffff:127.0.0.1]/health',
    'http://user:password@localhost/health',
    'http://localhost@outside.example/health',
    'file:///tmp/health',
    ' http://localhost/health',
    'http://localhost/health#fragment',
    'http://localhost:99999/health',
  ])('rejects credentials, nonliteral targets and non-HTTP schemes: %s', (url) => {
    expect(ProjectReadinessOperationSchema.safeParse({ kind: 'readiness', url }).success).toBe(
      false,
    );
  });

  it('rejects caller-supplied credentials, request methods, bodies and unbounded retries', () => {
    const input = { kind: 'readiness', url: 'http://127.0.0.1/health' };
    for (const extra of [
      { method: 'POST' },
      { headers: { Authorization: 'private' } },
      { body: 'private' },
      { attempts: 0 },
      { attempts: 11 },
      { interval_ms: 99 },
      { interval_ms: 5001 },
      { request_timeout_ms: 99 },
      { request_timeout_ms: 10_001 },
      { expected_status: 302 },
    ]) {
      expect(ProjectReadinessOperationSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
});
