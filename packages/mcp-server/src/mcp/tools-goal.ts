import {
  EXECUTION_CONTRACT_VERSION,
  MCP_SERVER_VERSION,
  GoalReadInputSchema,
  GoalReadResultSchema,
  GoalUpdateInputSchema,
  GoalUpdateToolInputSchema,
  GoalUpdateResultSchema,
} from '@chatsplice/protocol';

import type { McpToolCatalogIdentity } from './tool-catalog.js';
import type { McpToolContext } from './tool-context.js';
import { toolError } from './tool-error.js';
import { parseToolInput } from './tool-input.js';

type GoalToolContext = Pick<
  McpToolContext,
  'server' | 'goalService' | 'readToolCatalogIdentity' | 'assertSourceBinding'
>;

/** Additive text remains readable by clients caching an older Goal output schema. */
async function goalToolContract(ctx: GoalToolContext): Promise<string> {
  let catalog: McpToolCatalogIdentity | null = null;
  try {
    // Delay discovery until invocation: catalog registration also registers this tool.
    catalog = await ctx.readToolCatalogIdentity();
  } catch {
    // Diagnostics must not hide a valid Goal read or disclose internal error details.
  }
  return JSON.stringify(
    {
      kind: 'goal_tool_contract',
      source: 'running_mcp_server',
      execution_contract_version: EXECUTION_CONTRACT_VERSION,
      mcp_descriptor_version: MCP_SERVER_VERSION,
      catalog_identity_status: catalog === null ? 'unavailable' : 'available',
      tool_count: catalog?.tool_count ?? null,
      tool_schema_digest: catalog?.tool_schema_digest ?? null,
      client_tool_schema_status: 'not_observable',
      max_executions: {
        minimum: 0,
        unlimited_value: 0,
        create_default: 0,
        omitted_resume: 'preserve_stored_value',
      },
      history_reset: {
        action: 'reset',
        requires_no_owned_work: true,
        state_after_reset: 'paused',
        preserves_objective_and_files: true,
        preserves_execution_usage_and_replay_protection: true,
      },
      guidance: [
        'Before resume, recheck this same Goal, current root/files, latest revision and terminal owned jobs; renew the deadline when needed.',
        'If the stored max_executions is already 0, omit max_executions on resume to retain unlimited execution counts. Omission preserves a positive budget too; changing a positive budget to unlimited requires explicit 0.',
        'If your advertised create/resume schema still requires minimum:1 or maximum:128, it differs from this running server contract. Refresh this connection in ChatGPT Plugins, then use a new conversation to recheck the advertised tools. A local app restart does not prove the client schema was refreshed.',
      ],
    },
    null,
    2,
  );
}

export function registerGoalTools(ctx: GoalToolContext): void {
  ctx.server.registerTool(
    'project.goal',
    {
      title: 'Read Persistent Project Goals',
      description:
        'Read one persistent Goal or one page of up to 32 saved Goals for the exactly bound user workspace. Follow has_more/next_offset with offset/limit to inspect older records; there is no fixed saved-Goal count limit. Start here when the user asks to register or track a plain-language objective, or to continue a saved Goal. Inspect existing Goals before creating one; reuse the requested Goal for continuation instead of creating a duplicate. If a create result is uncertain, read the list before retrying because create is not idempotent. Use the latest revision, checkpoint summary/next_step, receipts, root_matches, criteria evidence, deadline and execution budget to decide the next operation. Inspect relevant current project files and manifests/scripts before planning new immutable criteria or resuming. Goal metadata survives daemon restart; evidence is revalidated against the current root and tracked file SHA values. This read never resumes, retries or starts work. An additional goal_tool_contract text reports the running server catalog and budget semantics; it cannot observe whether ChatGPT has refreshed its cached tool definitions. ChatGPT owns planning and continuation during the active conversation.',
      inputSchema: GoalReadInputSchema,
      outputSchema: GoalReadResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { workspace_binding, ...ownerInput } = input;
        ctx.assertSourceBinding(input.workspace_id, workspace_binding);
        const output = await ctx.goalService.read(ownerInput);
        return {
          content: [
            { type: 'text', text: JSON.stringify(output) },
            { type: 'text', text: await goalToolContract(ctx) },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  ctx.server.registerTool(
    'project.goal_update',
    {
      title: 'Update a Persistent Project Goal',
      description:
        'Create, checkpoint, verify_file, pause, resume, cancel, complete, reset or delete a user-requested Goal in the exactly bound workspace. A natural-language objective is sufficient user input: ChatGPT first reads project.goal and relevant project files/manifests/scripts, then chooses objective, scope, concrete tracked_paths, meaningful criteria and next_step. Do not make users invent technical paths or checks. Create only after inspection, without placeholder criteria; scope, tracked paths and criteria are immutable. Track 1-32 relative regular UTF-8 files (each at most 1 MiB, total 8 MiB); planned new files may be absent, but directories and dot are not file placeholders. Declare 1-16 verifiable criteria, at least one required; check criteria must match observed declared Node scripts or Cargo tasks, and browser criteria must describe an observable local result. Create has no expected_revision and is not idempotent: read Goals before retrying an uncertain result. Every other mutation requires a freshly read expected_revision. After successful registration, continue implementation, testing and repair within the authorized scope and remaining budget in the active chat; do not stop at a plan. Link project.exec with goal_id, plus criterion_id only for the exact declared check/browser assertion; await existing jobs instead of replaying them. verify_file rereads the current file SHA; a file hash alone does not prove functional behavior. Rerun missing, failed or stale checks. Save checkpoint summary (including blockers) and next_step before pausing or ending the turn. Resume accepts only paused/interrupted Goals after current root/files are rechecked and owned jobs are terminal; an expired or exhausted active Goal needs pause, a fresh read, then resume with explicit deadline_ms/max_executions renewal. New Goals default to max_executions:0 (no execution-count limit); explicit positive budgets are honored and can be renewed, including resume with max_executions:0. Omit max_executions on resume to preserve the stored budget, including an existing 0; only a requested budget change needs this optional field. Omission does not remove a positive budget. There is no lifetime 128-execution limit. Recent terminal receipts are compacted while running jobs, current criterion evidence and durable duplicate-request hashes are preserved. executions_used is cumulative and may exceed the number of retained receipts. Reset only when the user requests a fresh verification pass: action:reset requires a fresh expected_revision, the original root and no queued/running owned jobs or cancellation in progress. It retains this Goal, objective, criteria definitions, tracked paths, last file baseline, deadline, budget, cumulative executions_used and duplicate-request hashes; it clears checkpoint summary/next_step, all verification evidence and visible receipts, and leaves the Goal paused. Explicit resume revalidates current files and any renewed deadline/budget before new checks. Reset does not delete project files, start work or certify completion. Delete only completed/cancelled Goals with fresh expected_revision and no active owned jobs when the user requests record cleanup; this deletes Goal history and replay hashes, never project files. There is no automatic deletion of unfinished work. Save the final checkpoint before complete; completed Goals do not accept checkpoints. Completion needs current daemon-owned evidence for every required criterion and terminal owned jobs; never claim registration or completion without a successful result. Pause blocks new Goal jobs; cancel cleans up only owned jobs and does not roll back changes. Pause/cancel remain available in read-only mode. Stores bounded metadata without command logs, images, credentials or workspace binding. It never starts a new ChatGPT turn, invokes another model, automatically replays interrupted commands or submits a message.',
      inputSchema: GoalUpdateToolInputSchema,
      outputSchema: GoalUpdateResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (rawInput) => {
      try {
        const input = parseToolInput(GoalUpdateInputSchema, rawInput);
        const { workspace_binding, ...ownerInput } = input;
        ctx.assertSourceBinding(input.workspace_id, workspace_binding);
        const output = await ctx.goalService.update(ownerInput);
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
