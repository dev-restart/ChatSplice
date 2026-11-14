import { describe, expect, it } from 'vitest';

import {
  CreateTerminalSessionInputSchema,
  ReadTerminalSessionInputSchema,
  TerminalSessionSnapshotSchema,
  TerminalSessionSummarySchema,
} from './terminal.js';

const WORKSPACE_ID = `ws_${'a'.repeat(24)}`;
const TERMINAL_ID = `term_${'b'.repeat(24)}`;

describe('terminal protocol', () => {
  it('defaults dimensions and validates the renderer contract', () => {
    expect(CreateTerminalSessionInputSchema.parse({ workspace_id: WORKSPACE_ID })).toEqual({
      workspace_id: WORKSPACE_ID,
      cols: 120,
      rows: 30,
    });
    expect(
      ReadTerminalSessionInputSchema.parse({
        workspace_id: WORKSPACE_ID,
        terminal_id: TERMINAL_ID,
        after_sequence: 4,
      }),
    ).toMatchObject({ terminal_id: TERMINAL_ID, after_sequence: 4 });
  });

  it('keeps state and replay fields bounded and strict', () => {
    const summary = {
      terminal_id: TERMINAL_ID,
      label: 'Terminal 1',
      workspace_id: WORKSPACE_ID,
      state: 'shellrunning' as const,
      cols: 120,
      rows: 30,
      sequence: 7,
    };
    expect(TerminalSessionSummarySchema.parse(summary)).toEqual(summary);
    expect(
      TerminalSessionSnapshotSchema.safeParse({
        ...summary,
        output: 'pwd\r\n',
        replay_truncated: false,
      }).success,
    ).toBe(true);
    expect(TerminalSessionSummarySchema.safeParse({ ...summary, state: 'running' }).success).toBe(
      false,
    );
    expect(
      TerminalSessionSnapshotSchema.safeParse({
        ...summary,
        output: 'output',
        replay_truncated: false,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
