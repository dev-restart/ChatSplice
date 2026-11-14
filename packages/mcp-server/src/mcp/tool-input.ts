import { ChatSpliceError } from '@chatsplice/core';
import type { z } from 'zod';

/**
 * Applies the precise per-mode input schema behind a flattened advertised
 * schema. Failures are ordinary request errors the model can repair.
 */
export function parseToolInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`)
      .join('; ');
    throw new ChatSpliceError('BAD_REQUEST', `Invalid arguments for this action. ${issues}`);
  }
  return parsed.data;
}
