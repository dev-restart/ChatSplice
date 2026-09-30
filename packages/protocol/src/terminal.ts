import * as z from 'zod/v4';

const WorkspaceIdSchema = z.string().regex(/^ws_[a-f0-9]{24}$/);

/**
 * Terminal sessions are app-owned local UI state. They never cross the MCP
 * control socket and therefore have their own identifier and input shapes.
 */
export const TerminalSessionIdSchema = z.string().regex(/^term_[a-f0-9]{24}$/);
export type TerminalSessionId = z.infer<typeof TerminalSessionIdSchema>;

export const TerminalSessionStateSchema = z.enum(['shellrunning', 'exited']);
export type TerminalSessionState = z.infer<typeof TerminalSessionStateSchema>;

export const TerminalColumnsSchema = z.number().int().min(1).max(500);
export const TerminalRowsSchema = z.number().int().min(1).max(300);

export const TerminalSessionSummarySchema = z
  .object({
    terminal_id: TerminalSessionIdSchema,
    label: z.string().trim().min(1).max(120),
    workspace_id: WorkspaceIdSchema,
    state: TerminalSessionStateSchema,
    cols: TerminalColumnsSchema,
    rows: TerminalRowsSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type TerminalSessionSummary = z.infer<typeof TerminalSessionSummarySchema>;

export const TerminalSessionSnapshotSchema = TerminalSessionSummarySchema.extend({
  /** Output is UTF-8 text retained by the bounded in-memory replay buffer. */
  output: z.string().max(262_144),
  replay_truncated: z.boolean(),
}).strict();
export type TerminalSessionSnapshot = z.infer<typeof TerminalSessionSnapshotSchema>;

export const TerminalSessionSummaryListSchema = z.array(TerminalSessionSummarySchema).max(32);
export type TerminalSessionSummaryList = z.infer<typeof TerminalSessionSummaryListSchema>;

export const CreateTerminalSessionInputSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    cols: TerminalColumnsSchema.default(120),
    rows: TerminalRowsSchema.default(30),
  })
  .strict();
export type CreateTerminalSessionInput = z.infer<typeof CreateTerminalSessionInputSchema>;

export const TerminalSessionTargetSchema = z
  .object({
    workspace_id: WorkspaceIdSchema,
    terminal_id: TerminalSessionIdSchema,
  })
  .strict();
export type TerminalSessionTarget = z.infer<typeof TerminalSessionTargetSchema>;

export const ReadTerminalSessionInputSchema = TerminalSessionTargetSchema.extend({
  after_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type ReadTerminalSessionInput = z.infer<typeof ReadTerminalSessionInputSchema>;

export const WriteTerminalSessionInputSchema = TerminalSessionTargetSchema.extend({
  data: z.string().max(131_072),
}).strict();
export type WriteTerminalSessionInput = z.infer<typeof WriteTerminalSessionInputSchema>;

export const ResizeTerminalSessionInputSchema = TerminalSessionTargetSchema.extend({
  cols: TerminalColumnsSchema,
  rows: TerminalRowsSchema,
}).strict();
export type ResizeTerminalSessionInput = z.infer<typeof ResizeTerminalSessionInputSchema>;
