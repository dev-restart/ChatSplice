import { describe, expect, it } from 'vitest';

import { buildTunnelCredentialPromptScript } from './credential-prompt.js';

describe('tunnel credential prompt copy', () => {
  it('uses the renderer-selected English prompt', () => {
    const script = buildTunnelCredentialPromptScript('en');

    expect(script).toContain('Enter the OpenAI Secure MCP Tunnel runtime key.');
    expect(script).toContain('"Cancel"');
    expect(script).toContain('"Save"');
  });

  it('uses Korean copy only when Korean is selected', () => {
    const script = buildTunnelCredentialPromptScript('ko');

    expect(script).toContain('OpenAI Secure MCP Tunnel runtime key를 입력하세요.');
    expect(script).toContain('"취소"');
    expect(script).toContain('"저장"');
  });
});
