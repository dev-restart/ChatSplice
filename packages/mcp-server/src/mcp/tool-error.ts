import { ChatSpliceError, errorMessage } from '@chatsplice/core';

/**
 * Shapes an unexpected failure into an MCP tool error result.
 * ChatSpliceError codes/messages are part of the tool contract and pass
 * through unchanged. Generic errors are collapsed to INTERNAL_ERROR so daemon
 * internals never leak — except messages beginning with 'Workspace', which
 * core already worded for end users (they name the offending path/policy),
 * so hiding them would make binding mistakes undebuggable.
 */

export function toolError(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  if (error instanceof ChatSpliceError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `INTERNAL_ERROR: ${errorMessage(error).startsWith('Workspace') ? errorMessage(error) : 'The local operation failed. Verify workspace_id and path, then retry.'}`,
      },
    ],
  };
}
