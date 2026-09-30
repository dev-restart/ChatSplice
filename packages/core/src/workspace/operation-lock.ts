import { AsyncLocalStorage } from 'node:async_hooks';

import { ChatSpliceError } from '../errors.js';
import { isWithinOrEqualRoot } from '../fs/path-policy.js';

interface Reservation {
  readonly root: string;
  active: boolean;
}

interface WaitingOperation {
  readonly root: string;
  readonly resolve: (reservation: Reservation) => void;
}

const overlaps = (left: string, right: string): boolean =>
  isWithinOrEqualRoot(left, right) || isWithinOrEqualRoot(right, left);

/** One daemon owns all direct, proposal and fallback reservations. */
export class WorkspaceOperationLock {
  readonly #active = new Set<Reservation>();
  readonly #waiting: WaitingOperation[] = [];
  readonly #context = new AsyncLocalStorage<Reservation>();

  public isBusy(root: string): boolean {
    return (
      [...this.#active].some((item) => overlaps(item.root, root)) ||
      this.#waiting.some((item) => overlaps(item.root, root))
    );
  }

  public tryReserve(root: string): (() => void) | undefined {
    if (this.isBusy(root)) return undefined;
    const reservation = this.#reserve(root);
    return () => this.#release(reservation);
  }

  public async run<T>(root: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const inherited = this.#context.getStore();
    if (inherited?.active && isWithinOrEqualRoot(inherited.root, root)) return action();
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
        root,
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

  #reserve(root: string): Reservation {
    const reservation = { root, active: true };
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
        [...this.#active].some((item) => overlaps(item.root, next.root)) ||
        this.#waiting.slice(0, index).some((item) => overlaps(item.root, next.root));
      if (blocked) {
        index += 1;
        continue;
      }
      this.#waiting.splice(index, 1);
      next.resolve(this.#reserve(next.root));
    }
  }
}
