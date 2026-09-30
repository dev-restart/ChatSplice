/**
 * Collect process output without allowing a UTF-8 replacement character at a
 * byte-limit boundary to make the final string exceed its advertised cap.
 * Chunks are kept as bytes and decoded only after adjacent stream chunks have
 * been joined, so a multibyte character split by the OS stream is preserved.
 */
export class BoundedOutputCapture {
  readonly #maximumBytes: number;
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #wasTruncated = false;
  #decoded: { readonly value: string; readonly discardedIncompleteBytes: boolean } | undefined;

  public constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError('The output byte limit must be a positive safe integer.');
    }
    this.#maximumBytes = maximumBytes;
  }

  public append(chunk: Buffer): void {
    const remaining = this.#maximumBytes - this.#capturedBytes;
    if (remaining <= 0) {
      this.#wasTruncated = true;
      return;
    }
    const captured = chunk.subarray(0, remaining);
    this.#chunks.push(Buffer.from(captured));
    this.#capturedBytes += captured.byteLength;
    this.#wasTruncated ||= chunk.byteLength > remaining;
    this.#decoded = undefined;
  }

  public get value(): string {
    return this.#decode().value;
  }

  public get truncated(): boolean {
    return this.#wasTruncated || this.#decode().discardedIncompleteBytes;
  }

  #decode(): { readonly value: string; readonly discardedIncompleteBytes: boolean } {
    if (this.#decoded !== undefined) return this.#decoded;
    const bytes = Buffer.concat(this.#chunks, this.#capturedBytes);
    for (let length = bytes.byteLength; length >= 0; length -= 1) {
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        this.#decoded = { value, discardedIncompleteBytes: length !== bytes.byteLength };
        return this.#decoded;
      } catch {
        // The final byte sequence is incomplete or invalid. Remove its tail
        // instead of emitting a replacement character outside the byte cap.
      }
    }
    this.#decoded = { value: '', discardedIncompleteBytes: bytes.byteLength > 0 };
    return this.#decoded;
  }
}

export function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}
