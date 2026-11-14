import { describe, expect, it } from 'vitest';

import { WorkspaceOperationLock } from './operation-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('atomic folder reservations', () => {
  it('serializes opposite-order overlapping groups without blocking independent folders', async () => {
    const lock = new WorkspaceOperationLock();
    const entered = deferred();
    const finish = deferred();
    const events: string[] = [];
    const first = lock.runMany(['/projects/a', '/projects/b'], async () => {
      events.push('first');
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    const second = lock.runMany(['/projects/b', '/projects/a'], async () => {
      events.push('second');
    });
    await lock.run('/projects/independent', async () => {
      events.push('independent');
    });
    expect(events).toEqual(['first', 'independent']);
    expect(lock.isBusy('/projects/a/child')).toBe(true);
    expect(lock.isBusy('/projects/b')).toBe(true);
    finish.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'independent', 'second']);
    expect(lock.isBusy('/projects/a')).toBe(false);
    expect(lock.isBusy('/projects/b')).toBe(false);
  });

  it('allows nested work only inside the already reserved roots', async () => {
    const lock = new WorkspaceOperationLock();
    await lock.runMany(['/projects/a', '/projects/b'], async () => {
      await expect(lock.run('/projects/b/src', async () => 'done')).resolves.toBe('done');
      await expect(
        lock.runMany(['/projects/a', '/projects/c'], async () => undefined),
      ).rejects.toThrow('cannot expand');
    });
    expect(lock.tryReserve('/projects/c')).toBeTypeOf('function');
  });

  it('releases every queued root on cancellation', async () => {
    const lock = new WorkspaceOperationLock();
    const release = lock.tryReserve('/projects/a')!;
    const abort = new AbortController();
    const waiting = lock.runMany(
      ['/projects/a', '/projects/b'],
      async () => {
        throw new Error('cancelled operation started');
      },
      abort.signal,
    );
    const outcome = expect(waiting).rejects.toThrow();
    expect(lock.isBusy('/projects/b')).toBe(true);
    abort.abort();
    await outcome;
    expect(lock.isBusy('/projects/b')).toBe(false);
    release();
    expect(lock.isBusy('/projects/a')).toBe(false);
  });

  it('coalesces duplicate and nested roots without leaking reservations', async () => {
    const lock = new WorkspaceOperationLock();
    const release = lock.tryReserveMany(['/projects/a/src', '/projects/a', '/projects/a']);
    expect(release).toBeTypeOf('function');
    expect(lock.tryReserve('/projects/a/other')).toBeUndefined();
    release!();
    release!();
    expect(lock.isBusy('/projects/a')).toBe(false);
  });
});
