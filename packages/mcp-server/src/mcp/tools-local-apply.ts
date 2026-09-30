// Registers local.prepare_apply and local.await_apply, the bounded proposal write path.
import { ChatSpliceError } from '@chatsplice/core';
import {
  LocalApplyProposalAwaitInputSchema,
  LocalApplyProposalInputSchema,
  LocalApplyProposalStatusSchema,
} from '@chatsplice/protocol';

import { toolError } from './tool-error.js';
import type { McpToolContext } from './tool-context.js';

export function registerLocalApplyTools(ctx: McpToolContext): void {
  const {
    server,
    assertSourceBinding,
    assertMutationsAllowed,
    localApplyProposalStore,
    localApplyStartWaitMs,
  } = ctx;

  server.registerTool(
    'local.prepare_apply',
    {
      title: 'Request Automatic ChatSplice Changes',
      description:
        'Requests automatic local execution for a new project change, including edits, creates, one-level folders, rename/delete, allowlisted check/build, and up to five bounded git commands. Use after bounded fs.read/list/search evidence, including follow-ups after image generation or UTF-8 SVG recreation. Submitting an expiring chatsplice.apply.v1 proposal authorizes its file changes and commands; git may contact a remote. Reuse idempotency_key for identical retries; use a new key for a new operation. ChatSplice automatically detects the proposal, verifies the exact binding, and applies it without a confirmation dialog, so stay in this conversation and call local.await_apply with the returned proposal_id until the state resolves. Never start new work with local.await_apply.',
      inputSchema: LocalApplyProposalInputSchema,
      outputSchema: LocalApplyProposalStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        assertMutationsAllowed();
        const proposal = localApplyProposalStore.submit(input);
        const output = await localApplyProposalStore.awaitResult(
          proposal.proposal_id,
          localApplyStartWaitMs,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'local.await_apply',
    {
      title: 'Continuation Only — Existing ChatSplice Apply Proposal',
      description:
        'Continuation only: wait for a prior local.prepare_apply result using its returned proposal_id. Never use this for a new change request; it does not edit files, start a process, or open a proposal.',
      inputSchema: LocalApplyProposalAwaitInputSchema,
      outputSchema: LocalApplyProposalStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const output = await localApplyProposalStore.awaitResult(
          input.proposal_id,
          input.timeout_ms,
        );
        if (output.workspace_id !== input.workspace_id) {
          throw new ChatSpliceError(
            'BAD_REQUEST',
            'This apply proposal does not belong to the explicitly bound workspace.',
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
