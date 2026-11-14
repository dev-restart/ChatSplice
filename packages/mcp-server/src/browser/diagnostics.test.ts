import { describe, expect, it } from 'vitest';

import { browserActionFailure, browserActionTimeout, browserLaunchError } from './diagnostics.js';

describe('bounded browser diagnostics', () => {
  it.each([
    ["Executable doesn't exist at /private/cache/secret", 'browser_missing'],
    ['sandbox initialization failed: Operation not permitted secret', 'browser_permission_denied'],
    ['EACCES while reading a private location', 'browser_permission_denied'],
    ['Timeout 30000ms exceeded. secret', 'browser_launch_timeout'],
    ['Target closed unexpectedly secret', 'browser_launch_failed'],
  ])('classifies startup errors without exposing raw details', (message, reason) => {
    const failure = browserLaunchError(new Error(message));
    expect(failure.message).toContain(`[${reason}]`);
    expect(failure.message).not.toContain('secret');
    expect(failure.message).not.toContain('/private/cache');
  });
  it('does not call every failure a missing browser', () => {
    expect(browserLaunchError(undefined).message).toContain('[browser_launch_failed]');
    expect(browserLaunchError(new Error('EPERM; executable not found')).message).toContain(
      '[browser_permission_denied]',
    );
  });
  it('keeps action reasons fixed instead of echoing selectors or expected values', () => {
    expect(browserActionFailure(new Error('strict mode violation: private-value'), false)).toBe(
      'selector_ambiguous',
    );
    expect(browserActionFailure(new Error('Timeout 1000ms exceeded'), false)).toBe(
      'action_timeout',
    );
    expect(browserActionFailure(new Error('expected private-value'), true)).toBe(
      'assertion_failed',
    );
    expect(browserActionFailure(null, false)).toBe('action_failed');
  });
  it('subtracts time already spent and reserves a finite capture budget', () => {
    expect(browserActionTimeout(1000, 10000, 1000, 5000)).toBe(5000);
    expect(browserActionTimeout(1000, 10000, 9500, 5000)).toBe(1125);
    expect(browserActionTimeout(1000, 1000, 1900, 5000)).toBe(75);
    expect(browserActionTimeout(1000, 1000, 2001, 5000)).toBe(1);
    expect(browserActionTimeout(1000, 600000, 1000)).toBe(30000);
  });
});
