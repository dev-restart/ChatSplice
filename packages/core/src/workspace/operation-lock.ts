import { AsyncLocalStorage } from 'node:async_hooks';

import { ChatSpliceError } from '../errors.js';
import { isWithinOrEqualRoot } from '../fs/path-policy.js';

interface Reservation {
  readonly roots: readonly string[];
  active: boolean;
}

interface WaitingOperation {
  readonly roots: readonly string[];
  readonly resolve: (reservation: Reservation) => void;
}

const overlaps = (left: string, right: string): boolean =>
  isWithinOrEqualRoot(left, right) || isWithinOrEqualRoot(right, left);

const groupsOverlap = (left: readonly string[], right: readonly string[]): boolean =>
  left.some((root) => right.some((other) => overlaps(root, other)));

function normalizeRoots(roots: readonly string[]): string[] {
  const unique = [...new Set(roots)].sort();
  if (unique.length === 0 || unique.length > 101) {
    throw new ChatSpliceError('BAD_REQUEST', 'A workspace operation requires 1–101 roots.');
  }
  return unique.filter(
    (root) => !unique.some((other) => other !== root && isWithinOrEqualRoot(other, root)),
  );
}

/** One daemon owns all direct, proposal and execution reservations. */
export class WorkspaceOperationLock {
  readonly #active = new Set<Reservation>();
  readonly #waiting: WaitingOperation[] = [];
  readonly #context = new AsyncLocalStorage<Reservation>();

  public isBusy(root: string): boolean {
    return (
      [...this.#active].some((item) => item.roots.some((active) => overlaps(active, root))) ||
      this.#waiting.some((item) => item.roots.some((waiting) => overlaps(waiting, root)))
    );
  }

  public tryReserve(root: string): (() => void) | undefined {
    return this.tryReserveMany([root]);
  }

  public tryReserveMany(roots: readonly string[]): (() => void) | undefined {
    const normalized = normalizeRoots(roots);
    if (normalized.some((root) => this.isBusy(root))) return undefined;
    const reservation = this.#reserve(normalized);
    return () => this.#release(reservation);
  }

  public run<T>(root: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.runMany([root], action, signal);
  }

  /** Reserve every participating root together; never hold A while waiting for B. */
  public async runMany<T>(
    roots: readonly string[],
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const normalized = normalizeRoots(roots);
    const inherited = this.#context.getStore();
    if (inherited?.active) {
      if (
        normalized.every((root) => inherited.roots.some((held) => isWithinOrEqualRoot(held, root)))
      ) {
        return action();
      }
      throw new ChatSpliceError(
        'BAD_REQUEST',
        'An active workspace operation cannot expand its reserved folders.',
      );
    }
    if (this.#waiting.length >= 500) {
      throw new ChatSpliceError('BAD_REQUEST', 'The bounded workspace operation queue is full.');
    }
    const reservation = await new Promise<Reservation>((resolve, reject) => {
      const abort = (): void => {
        const index = this.#waiting.indexOf(waiting);
        if (index === -1) return;
        this.#waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('Execution cancelled.', 'AbortError'));
        this.#drain();
      };
      const waiting: WaitingOperation = {
        roots: normalized,
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#waiting.push(waiting);
      this.#drain();
    });
    try {
      signal?.throwIfAborted();
      return await this.#context.run(reservation, action);
    } finally {
      this.#release(reservation);
    }
  }

  #reserve(roots: readonly string[]): Reservation {
    const reservation = { roots, active: true };
    this.#active.add(reservation);
    return reservation;
  }

  #release(reservation: Reservation): void {
    if (!reservation.active) return;
    reservation.active = false;
    this.#active.delete(reservation);
    this.#drain();
  }

  #drain(): void {
    for (let index = 0; index < this.#waiting.length;) {
      const next = this.#waiting[index]!;
      const blocked =
        [...this.#active].some((item) => groupsOverlap(item.roots, next.roots)) ||
        this.#waiting.slice(0, index).some((item) => groupsOverlap(item.roots, next.roots));
      if (blocked) {
        index += 1;
        continue;
      }
      this.#waiting.splice(index, 1);
      next.resolve(this.#reserve(next.roots));
    }
  }
}
