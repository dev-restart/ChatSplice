import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  status: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./daemon-client.js', () => ({
  IncompatibleDaemonError: class extends Error {},
  DaemonClient: class {
    status = mocks.status;
    shutdown = mocks.shutdown;
  },
}));

import { DaemonSupervisor } from './daemon-supervisor.js';

describe('DaemonSupervisor startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it('reuses an already responding compatible daemon without spawning a child', async () => {
    mocks.status.mockResolvedValue({ ready: true });
    await new DaemonSupervisor('/test/data', '/test/socket').start();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reports a failed child launch instead of letting its error crash Electron', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null });
    mocks.spawn.mockReturnValue(child);
    mocks.status.mockRejectedValue(new Error('offline'));
    const starting = new DaemonSupervisor('/test/data', '/test/socket').start();
    const outcome = starting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toEqual(new Error('chatspliced could not be started.'));
  });

  it('waits between not-ready responses rather than repeatedly polling without a delay', async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null });
    mocks.spawn.mockReturnValue(child);
    mocks.status
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValue({ ready: true });
    const starting = new DaemonSupervisor('/test/data', '/test/socket').start();
    await vi.advanceTimersByTimeAsync(0);
    const initialRequests = mocks.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(initialRequests).toBe(2);
    expect(mocks.status).toHaveBeenCalledTimes(3);
  });
});
