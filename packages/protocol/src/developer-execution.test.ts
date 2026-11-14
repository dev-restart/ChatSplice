import { describe, expect, it } from 'vitest';

import { ProjectExecInputSchema, isBackgroundOperation } from './execution.js';
import { isLocalPreviewUrl } from './browser.js';

const bound = {
  workspace_id: `ws_${'a'.repeat(24)}`,
  workspace_binding: `wb_${'a'.repeat(64)}`,
  request_id: 'developer-request-01',
};

describe('developer execution contract', () => {
  it('accepts developer shell, finite input and background lifetimes without model settings', () => {
    const input = ProjectExecInputSchema.parse({
      ...bound,
      operation: {
        kind: 'shell',
        command: 'python3 -m venv .venv',
        background: true,
        network: 'local',
        stdin: 'input\n',
      },
      timeout_ms: 86_400_000,
    });
    expect(isBackgroundOperation(input.operation)).toBe(true);
    expect(ProjectExecInputSchema.safeParse({ ...input, model: 'another-model' }).success).toBe(
      false,
    );
    expect(
      ProjectExecInputSchema.safeParse({
        ...input,
        operation: { kind: 'shell', command: 'bad\u0000command' },
      }).success,
    ).toBe(false);
  });

  it('keeps browser actions local and bounded', () => {
    for (const url of ['http://127.0.0.1:5173/', 'http://localhost:3000', 'http://[::1]:8000/']) {
      expect(isLocalPreviewUrl(url)).toBe(true);
      expect(
        ProjectExecInputSchema.safeParse({
          ...bound,
          operation: { kind: 'browser', action: { kind: 'open', url } },
        }).success,
      ).toBe(true);
    }
    for (const url of [
      'https://chatgpt.com/',
      'file:///tmp/test.html',
      'http://localhost.evil/',
      'http://user:password@localhost/',
      'javascript:alert(1)',
    ])
      expect(isLocalPreviewUrl(url)).toBe(false);
    expect(
      ProjectExecInputSchema.safeParse({
        ...bound,
        operation: {
          kind: 'browser',
          action: { kind: 'open', url: 'http://localhost', width: 10000 },
        },
      }).success,
    ).toBe(false);
  });
});
