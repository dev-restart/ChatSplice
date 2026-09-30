import { describe, expect, it } from 'vitest';

import {
  isAllowedAuthPopup,
  isAllowedChatGptNavigation,
  isRestorableChatGptUrl,
  isSafeExternalUrl,
} from './navigation-policy.js';

describe('navigation policy', () => {
  it('allows ChatGPT and explicit identity providers', () => {
    expect(isAllowedChatGptNavigation('https://chatgpt.com/')).toBe(true);
    expect(isAllowedAuthPopup('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);
  });

  it('rejects confusing hostnames and privileged schemes', () => {
    expect(isAllowedChatGptNavigation('https://chatgpt.com.evil.example/')).toBe(false);
    expect(isAllowedChatGptNavigation('file:///etc/passwd')).toBe(false);
    expect(isAllowedAuthPopup('javascript:alert(1)')).toBe(false);
  });

  it('opens only HTTPS URLs externally', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://example.com/')).toBe(false);
    expect(isSafeExternalUrl('custom://example.com/')).toBe(false);
  });

  it('restores only top-level ChatGPT navigation and never an auth redirect', () => {
    expect(isRestorableChatGptUrl('https://chatgpt.com/c/opaque-value')).toBe(true);
    expect(isRestorableChatGptUrl('https://auth.openai.com/authorize')).toBe(false);
    expect(isRestorableChatGptUrl('https://chatgpt.com.evil.example/c/value')).toBe(false);
  });
});
