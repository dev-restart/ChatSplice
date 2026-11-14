import * as z from 'zod/v4';

import { ProjectBrowserExpectationSchema } from './browser.js';

const WorkspaceId = z.string().regex(/^ws_[a-f0-9]{24}$/);
const Binding = z.string().regex(/^wb_[a-f0-9]{64}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const JobId = z.string().regex(/^exec_[a-f0-9-]{36}$/);

export const GoalIdSchema = z
  .string()
  .regex(/^goal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const GoalCriterionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Shared by durable records and both owner/public create and resume contracts. */
export const GoalExecutionBudgetSchema = z
  .number()
  .int()
  .nonnegative()
  .describe(
    'Execution-count budget: 0 means unlimited; positive values are explicit limits. Omit on resume to preserve the stored value. New Goals default to 0.',
  );
export const GoalPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === '.' ||
      (!value.startsWith('/') &&
        !/^[A-Za-z]:/.test(value) &&
        !value.includes('\\') &&
        Array.from(value).every(
          (character) => character.charCodeAt(0) >= 32 && character !== '\u007f',
        ) &&
        value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')),
    'Goal paths must be workspace-relative without traversal.',
  );

const CriterionBase = {
  criterion_id: GoalCriterionIdSchema,
  description: z.string().min(1).max(500),
  required: z.boolean().default(true),
};

export const GoalCheckOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node_script'),
      script: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/),
    })
    .strict(),
  z
    .object({ kind: z.literal('cargo'), task: z.enum(['check', 'test', 'build', 'fmt', 'clippy']) })
    .strict(),
]);

const CriterionDefinitions = [
  z
    .object({
      ...CriterionBase,
      kind: z.literal('file'),
      path: GoalPathSchema.refine((value) => value !== '.'),
    })
    .strict(),
  z
    .object({
      ...CriterionBase,
      kind: z.literal('check'),
      cwd: GoalPathSchema.default('.'),
      operation: GoalCheckOperationSchema,
    })
    .strict(),
  z
    .object({
      ...CriterionBase,
      kind: z.literal('browser'),
      expectation: ProjectBrowserExpectationSchema,
    })
    .strict(),
] as const;

export const GoalCriterionDefinitionSchema = z.discriminatedUnion('kind', CriterionDefinitions);
export type GoalCriterionDefinition = z.infer<typeof GoalCriterionDefinitionSchema>;

export const GoalStateSchema = z.enum([
  'active',
  'paused',
  'cancelling',
  'cancelled',
  'interrupted',
  'completed',
]);
export type GoalState = z.infer<typeof GoalStateSchema>;
export const GoalCriterionStatusSchema = z.enum(['pending', 'passed', 'failed', 'stale']);
export const GoalEvidenceSchema = z
  .object({
    kind: z.enum(['file', 'check', 'browser']),
    job_id: JobId.nullable(),
    sha256: Digest.nullable(),
    scope_digest: Digest,
    build_id: Digest,
    run_id: z.uuid(),
    verified_at: z.iso.datetime(),
  })
  .strict();
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>;

const EvidenceFields = {
  status: GoalCriterionStatusSchema,
  evidence: GoalEvidenceSchema.nullable(),
};
export const GoalCriterionSchema = z.discriminatedUnion('kind', [
  CriterionDefinitions[0].extend(EvidenceFields),
  CriterionDefinitions[1].extend(EvidenceFields),
  CriterionDefinitions[2].extend(EvidenceFields),
]);
export type GoalCriterion = z.infer<typeof GoalCriterionSchema>;

function validCriteria(criteria: readonly { criterion_id: string; required: boolean }[]): boolean {
  return (
    criteria.some((criterion) => criterion.required) &&
    new Set(criteria.map((criterion) => criterion.criterion_id)).size === criteria.length
  );
}

export const GoalCheckpointSchema = z
  .object({
    summary: z.string().max(1000),
    next_step: z.string().max(1000),
    files: z.array(z.object({ path: GoalPathSchema, sha256: Digest.nullable() }).strict()).max(32),
    saved_at: z.iso.datetime(),
  })
  .strict();
export type GoalCheckpoint = z.infer<typeof GoalCheckpointSchema>;

export const GoalReceiptSchema = z
  .object({
    job_id: JobId,
    request_hash: Digest,
    criterion_id: GoalCriterionIdSchema.nullable(),
    state: z.enum([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'interrupted',
    ]),
    build_id: Digest,
    run_id: z.uuid(),
    created_at: z.iso.datetime(),
    started_at: z.iso.datetime().nullable(),
    finished_at: z.iso.datetime().nullable(),
    exit_code: z.number().int().nullable(),
  })
  .strict();
export type GoalReceipt = z.infer<typeof GoalReceiptSchema>;

export const GoalRecordSchema = z
  .object({
    goal_id: GoalIdSchema,
    workspace_id: WorkspaceId,
    objective: z.string().min(1).max(2000),
    scope: z.string().max(2000),
    tracked_paths: z.array(GoalPathSchema).min(1).max(32),
    criteria: z
      .array(GoalCriterionSchema)
      .min(1)
      .max(16)
      .refine(
        validCriteria,
        'Criteria IDs must be unique and at least one criterion must be required.',
      ),
    state: GoalStateSchema,
    revision: z.number().int().positive(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    deadline_at: z.iso.datetime(),
    // Zero explicitly means no execution-count limit; positive values remain opt-in budgets.
    max_executions: GoalExecutionBudgetSchema,
    executions_used: z.number().int().nonnegative(),
    checkpoint: GoalCheckpointSchema.nullable(),
    receipts: z.array(GoalReceiptSchema).max(128),
    message: z.string().max(1000),
    root_matches: z.boolean().default(true),
    evidence_valid: z.boolean().default(false),
  })
  .strict();
export type GoalRecord = z.infer<typeof GoalRecordSchema>;

const CreateFields = {
  workspace_id: WorkspaceId,
  action: z.literal('create'),
  objective: z.string().min(1).max(2000),
  scope: z.string().max(2000).default(''),
  tracked_paths: z.array(GoalPathSchema).min(1).max(32),
  criteria: z
    .array(GoalCriterionDefinitionSchema)
    .min(1)
    .max(16)
    .refine(
      validCriteria,
      'Criteria IDs must be unique and at least one criterion must be required.',
    ),
  next_step: z.string().max(1000).default(''),
  max_executions: GoalExecutionBudgetSchema.default(0),
  deadline_ms: z.number().int().min(1000).max(86_400_000).default(3_600_000),
};
const TargetFields = {
  workspace_id: WorkspaceId,
  goal_id: GoalIdSchema,
  expected_revision: z.number().int().positive(),
};
const OwnerMutations = [
  z.object(CreateFields).strict(),
  z
    .object({
      ...TargetFields,
      action: z.literal('checkpoint'),
      summary: z.string().max(1000),
      next_step: z.string().max(1000),
    })
    .strict(),
  z
    .object({
      ...TargetFields,
      action: z.literal('verify_file'),
      criterion_id: GoalCriterionIdSchema,
    })
    .strict(),
  z.object({ ...TargetFields, action: z.literal('pause') }).strict(),
  z
    .object({
      ...TargetFields,
      action: z.literal('resume'),
      deadline_ms: z.number().int().min(1000).max(86_400_000).optional(),
      max_executions: GoalExecutionBudgetSchema.optional(),
    })
    .strict(),
  z.object({ ...TargetFields, action: z.literal('cancel') }).strict(),
  z.object({ ...TargetFields, action: z.literal('complete') }).strict(),
  z.object({ ...TargetFields, action: z.literal('delete') }).strict(),
  z.object({ ...TargetFields, action: z.literal('reset') }).strict(),
] as const;

export const GoalOwnerReadInputSchema = z
  .object({
    workspace_id: WorkspaceId,
    goal_id: GoalIdSchema.optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(32).optional(),
  })
  .strict();
export type GoalOwnerReadInput = z.infer<typeof GoalOwnerReadInputSchema>;
export const GoalReadInputSchema = GoalOwnerReadInputSchema.extend({ workspace_binding: Binding });
export type GoalReadInput = z.infer<typeof GoalReadInputSchema>;
export const GoalReadResultSchema = z
  .object({
    goals: z.array(GoalRecordSchema).max(32),
    total: z.number().int().nonnegative().optional(),
    has_more: z.boolean().optional(),
    next_offset: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type GoalReadResult = z.infer<typeof GoalReadResultSchema>;
export const GoalOwnerUpdateInputSchema = z.discriminatedUnion('action', OwnerMutations);
export type GoalOwnerUpdateInput = z.infer<typeof GoalOwnerUpdateInputSchema>;
export const GoalUpdateInputSchema = z.discriminatedUnion('action', [
  OwnerMutations[0].extend({ workspace_binding: Binding }),
  OwnerMutations[1].extend({ workspace_binding: Binding }),
  OwnerMutations[2].extend({ workspace_binding: Binding }),
  OwnerMutations[3].extend({ workspace_binding: Binding }),
  OwnerMutations[4].extend({ workspace_binding: Binding }),
  OwnerMutations[5].extend({ workspace_binding: Binding }),
  OwnerMutations[6].extend({ workspace_binding: Binding }),
  OwnerMutations[7].extend({ workspace_binding: Binding }),
  OwnerMutations[8].extend({ workspace_binding: Binding }),
]);
export type GoalUpdateInput = z.infer<typeof GoalUpdateInputSchema>;

// Advertised project.goal_update arguments: one root object for ChatGPT
// function definitions. No defaults here, because omitting max_executions on
// resume must preserve the stored budget; GoalUpdateInputSchema applies the
// per-action requirements, create defaults and unknown-field rejection.
export const GoalUpdateToolInputSchema = z
  .object({
    workspace_id: WorkspaceId,
    workspace_binding: Binding,
    action: z.enum([
      'create',
      'checkpoint',
      'verify_file',
      'pause',
      'resume',
      'cancel',
      'complete',
      'delete',
      'reset',
    ]),
    goal_id: GoalIdSchema.optional().describe('Every action except create.'),
    expected_revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Freshly read revision; every action except create.'),
    objective: CreateFields.objective.optional().describe('create only.'),
    scope: z.string().max(2000).optional().describe("create only; default ''."),
    tracked_paths: CreateFields.tracked_paths.optional().describe('create only.'),
    criteria: CreateFields.criteria.optional().describe('create only.'),
    summary: z.string().max(1000).optional().describe('checkpoint only.'),
    next_step: z
      .string()
      .max(1000)
      .optional()
      .describe("checkpoint (required) or create (default '')."),
    criterion_id: GoalCriterionIdSchema.optional().describe('verify_file only.'),
    deadline_ms: z
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .optional()
      .describe('create (default 3600000) or resume renewal.'),
    max_executions: GoalExecutionBudgetSchema.optional().describe(
      'create (default 0, no limit) or resume; omit on resume to keep the stored budget.',
    ),
  })
  .strict();
export const GoalUpdateResultSchema = z
  .object({
    goal: GoalRecordSchema,
    deleted: z.literal(true).optional(),
  })
  .strict();
export type GoalUpdateResult = z.infer<typeof GoalUpdateResultSchema>;
