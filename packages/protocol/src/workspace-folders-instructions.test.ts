import { describe, expect, it } from 'vitest';

import { projectBindingText } from './project-instructions.js';

describe('shared folder project instructions', () => {
  it('keeps the source binding and explains explicit folder modes within the field limit', () => {
    const text = projectBindingText(
      'ws_0123456789abcdef01234567',
      'wb_' + 'a'.repeat(64),
      '\\"'.repeat(60),
      'a'.repeat(40),
    );
    expect(text).toContain('fs.reference_list workspace_id is reference_workspace_id');
    expect(text).toContain('keep source binding');
    expect(text).toContain('Missing stored modes stay read_only');
    expect(text).toContain('read_write permits edits/commands');
    expect(text).toContain('fs.reference_request defaults to read_write');
    expect(text).toContain('read_only requests viewing');
    expect(text).toContain('Await by request_id');
    expect(text).toContain('verify granted access_mode');
    expect(text).toContain('Reuse approved folders');
    expect(text).toContain('a request alone grants no access');
    expect(text).toContain('no separate Pi/Codex model or coding worker is started');
    expect(text.length).toBeLessThan(6_000);
  });
});
