import { describe, expect, it } from 'vitest';
import { WorkspaceOperationLock } from './operation-lock.js';

describe('workspace operation coordination', () => {
  it('cancels a queued operation without waiting for or interrupting the active owner', async () => {
    const lock = new WorkspaceOperationLock();
    const release = lock.tryReserve('/work/project')!;
    const controller = new AbortController();
    let ran = false;
    const pending = lock.run(
      '/work/project',
      async () => {
        ran = true;
      },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(ran).toBe(false);
    expect(lock.isBusy('/work/project')).toBe(true);
    release();
    expect(lock.isBusy('/work/project')).toBe(false);
  });
  it('serializes overlapping roots FIFO while independent roots continue', async () => {
    const lock = new WorkspaceOperationLock();
    const release = lock.tryReserve('/work/project')!;
    const order: string[] = [];
    const child = lock.run('/work/project/child', async () => {
      order.push('child');
    });
    const parent = lock.run('/work/project', async () => {
      order.push('parent');
    });
    await lock.run('/work/other', async () => {
      order.push('other');
    });
    expect(order).toEqual(['other']);
    expect(lock.tryReserve('/work/project')).toBeUndefined();
    release();
    await Promise.all([child, parent]);
    expect(order).toEqual(['other', 'child', 'parent']);
    expect(lock.isBusy('/work/project')).toBe(false);
  });

  it('allows nested bundle operations and releases the lock after an exception', async () => {
    const lock = new WorkspaceOperationLock();
    await expect(
      lock.run('/work', async () =>
        lock.run('/work', async () => {
          throw new Error('disk failure');
        }),
      ),
    ).rejects.toThrow('disk failure');
    expect(lock.isBusy('/work')).toBe(false);
    const release = lock.tryReserve('/work');
    expect(release).toBeTypeOf('function');
    release?.();
  });
});
