import * as z from 'zod/v4';

const WorkspaceId = z.string().regex(/^ws_[a-f0-9]{24}$/);
const Binding = z.string().regex(/^wb_[a-f0-9]{64}$/);
const JobId = z.string().regex(/^exec_[a-f0-9-]{36}$/);

export const ProjectExecOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node_script'),
      script: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/),
    })
    .strict(),
  z
    .object({ kind: z.literal('cargo'), task: z.enum(['check', 'test', 'build', 'fmt', 'clippy']) })
    .strict(),
  z
    .object({
      kind: z.literal('install'),
      ecosystem: z.enum(['node', 'rust']),
      mode: z.enum(['locked', 'resolve']).optional(),
    })
    .strict(),
]);
export type ProjectExecOperation = z.infer<typeof ProjectExecOperationSchema>;

export const ProjectExecInputSchema = z
  .object({
    workspace_id: WorkspaceId,
    workspace_binding: Binding,
    request_id: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          value === '.' ||
          (!value.startsWith('/') &&
            !/^[A-Za-z]:/.test(value) &&
            !value.includes('\\') &&
            !value.includes('\u0000') &&
            value.split('/').every((part) => part !== '..' && part !== '' && part !== '.')),
        'cwd must be a workspace-relative directory without traversal.',
      )
      .default('.'),
    operation: ProjectExecOperationSchema,
    timeout_ms: z.number().int().min(1000).max(1_800_000).default(600_000),
  })
  .strict();
export type ProjectExecInput = z.infer<typeof ProjectExecInputSchema>;

/**
 * Owner-side desktop submission input. The daemon derives the immutable
 * workspace binding from the registered workspace before it accepts this
 * request, so the app-owned renderer never receives or transports it.
 */
export const ProjectExecSubmitInputSchema = z
  .object({
    workspace_id: WorkspaceId,
    request_id: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/),
    cwd: ProjectExecInputSchema.shape.cwd,
    operation: ProjectExecOperationSchema,
    timeout_ms: ProjectExecInputSchema.shape.timeout_ms,
  })
  .strict();
export type ProjectExecSubmitInput = z.infer<typeof ProjectExecSubmitInputSchema>;

export const ProjectExecTargetSchema = z
  .object({ workspace_id: WorkspaceId, job_id: JobId })
  .strict();
export type ProjectExecTarget = z.infer<typeof ProjectExecTargetSchema>;
export const ProjectExecCancelInputSchema = ProjectExecTargetSchema.extend({
  workspace_binding: Binding,
});
export const ProjectExecAwaitInputSchema = ProjectExecCancelInputSchema.extend({
  timeout_ms: z.number().int().min(0).max(30_000).default(10_000),
});
export type ProjectExecAwaitInput = z.infer<typeof ProjectExecAwaitInputSchema>;
export type ProjectExecCancelInput = z.infer<typeof ProjectExecCancelInputSchema>;

export const ProjectExecStateSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type ProjectExecState = z.infer<typeof ProjectExecStateSchema>;
export const ProjectExecSummarySchema = z
  .object({
    job_id: JobId,
    workspace_id: WorkspaceId,
    workspace_name: z.string().min(1).max(200),
    operation: ProjectExecOperationSchema,
    cwd: z.string().max(4096),
    state: ProjectExecStateSchema,
    command: z.string().max(4096),
    created_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    exit_code: z.number().int().nullable(),
    error_code: z.string().max(100).nullable(),
    message: z.string().max(1000),
    used_network: z.boolean(),
    truncated: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectExecSummary = z.infer<typeof ProjectExecSummarySchema>;
export const ProjectExecJobSchema = ProjectExecSummarySchema.extend({
  output: z.string().max(65_536),
});
export type ProjectExecJob = z.infer<typeof ProjectExecJobSchema>;
export const ProjectExecListSchema = z
  .object({ jobs: z.array(ProjectExecSummarySchema).max(100) })
  .strict();
export type ProjectExecList = z.infer<typeof ProjectExecListSchema>;
