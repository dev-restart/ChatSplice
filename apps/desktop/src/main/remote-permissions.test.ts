import { describe, expect, it } from 'vitest';

import { allowsRemotePermission } from './remote-permissions.js';

describe('remote ChatGPT permissions', () => {
  it('allows only chatgpt.com to write to the clipboard, from either a bare origin or a full page URL', () => {
    expect(allowsRemotePermission('clipboard-sanitized-write', 'https://chatgpt.com')).toBe(true);
    expect(
      allowsRemotePermission('clipboard-sanitized-write', 'https://chatgpt.com/c/abc123'),
    ).toBe(true);
  });

  it('denies every other permission and every other origin, including a lookalike host', () => {
    expect(allowsRemotePermission('clipboard-read', 'https://chatgpt.com')).toBe(false);
    expect(allowsRemotePermission('camera', 'https://chatgpt.com')).toBe(false);
    expect(allowsRemotePermission('media', 'https://chatgpt.com')).toBe(false);
    expect(allowsRemotePermission('notifications', 'https://chatgpt.com')).toBe(false);
    expect(allowsRemotePermission('clipboard-sanitized-write', 'https://evil.example')).toBe(false);
    expect(
      allowsRemotePermission('clipboard-sanitized-write', 'https://chatgpt.com.evil.example'),
    ).toBe(false);
    expect(allowsRemotePermission('clipboard-sanitized-write', 'http://chatgpt.com')).toBe(false);
    expect(allowsRemotePermission('clipboard-sanitized-write', 'not a URL')).toBe(false);
  });
});
