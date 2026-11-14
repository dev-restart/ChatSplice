import type { ControlErrorCode } from '@chatsplice/protocol';

export class ChatSpliceError extends Error {
  public readonly code: ControlErrorCode;

  public constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = 'ChatSpliceError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected local runtime error.';
}
