import { ChatSpliceError } from '@chatsplice/core';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { log } from '../logging.js';
import { toolError } from './tool-error.js';

interface ToolResultLike {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

type ToolHandler = (...params: unknown[]) => Promise<ToolResultLike> | ToolResultLike;

/**
 * Keeps every tool's result schema as a server-side guarantee without sending
 * it in tools/list. Output schemas were most of the catalog bytes ChatGPT
 * receives on each connection, while the model only needs the results.
 * A result outside its schema is withheld exactly as the SDK validator did.
 */
export function registerToolsWithLocalResultValidation(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: ToolHandler,
  ) => unknown;
  const patched = (name: string, config: Record<string, unknown>, handler: ToolHandler) => {
    const { outputSchema, ...advertised } = config;
    if (outputSchema === undefined) return register(name, advertised, handler);
    const schema = outputSchema as z.ZodType;
    return register(name, advertised, async (...params: unknown[]) => {
      const result = await handler(...params);
      if (result.isError === true) return result;
      if (
        result.structuredContent !== undefined &&
        schema.safeParse(result.structuredContent).success
      )
        return result;
      log('error', 'mcp_tool_result_invalid', { tool: name });
      return toolError(
        new ChatSpliceError(
          'INTERNAL_ERROR',
          `${name} produced a result outside its declared shape, so it was withheld.`,
        ),
      );
    });
  };
  server.registerTool = patched as unknown as McpServer['registerTool'];
}
