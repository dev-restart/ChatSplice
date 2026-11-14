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
import { IncompatibleDaemonError } from './daemon-client.js';

describe('DaemonSupervisor startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it('reuses an already responding compatible daemon without spawning a child', async () => {
    mocks.status.mockResolvedValue({
      healthy: true,
      ready: true,
      execution_jobs: [{ state: 'running' }],
    });
    const supervisor = new DaemonSupervisor('/test/data', '/test/socket');
    await supervisor.start();
    await supervisor.close();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it('waits for a responding daemon without spawning a second process', async () => {
    mocks.status
      .mockResolvedValueOnce({ healthy: true, ready: false })
      .mockResolvedValue({ healthy: true, ready: true });
    const starting = new DaemonSupervisor('/test/data', '/test/socket').start();
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { healthy: false, ready: true },
    { healthy: true, ready: false },
  ])(
    'times out a responding daemon that stays unavailable without replacing it: %j',
    async (status) => {
      mocks.status.mockResolvedValue(status);
      const supervisor = new DaemonSupervisor('/test/data', '/test/socket');
      const outcome = supervisor.start().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await outcome).toEqual(
        new Error('chatspliced did not become ready before the startup timeout.'),
      );
      await supervisor.close();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.shutdown).not.toHaveBeenCalled();
    },
  );

  it('preserves an incompatible existing daemon and its work', async () => {
    const incompatible = new IncompatibleDaemonError('Different execution contract');
    mocks.status.mockRejectedValue(incompatible);
    const supervisor = new DaemonSupervisor('/test/data', '/test/socket');
    await expect(supervisor.start()).rejects.toBe(incompatible);
    await supervisor.close();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it('does not swallow incompatibility while waiting for an existing daemon', async () => {
    const incompatible = new IncompatibleDaemonError('Different execution contract');
    mocks.status
      .mockResolvedValueOnce({ healthy: true, ready: false })
      .mockRejectedValue(incompatible);
    const outcome = new DaemonSupervisor('/test/data', '/test/socket')
      .start()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe(incompatible);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('propagates a launch-time mismatch without shutting down the socket owner', async () => {
    const incompatible = new IncompatibleDaemonError('Different execution contract');
    const child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    mocks.status.mockRejectedValueOnce(new Error('offline')).mockRejectedValue(incompatible);
    const supervisor = new DaemonSupervisor('/test/data', '/test/socket');
    await expect(supervisor.start()).rejects.toBe(incompatible);
    const closing = supervisor.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(mocks.shutdown).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('normally shuts down a ready daemon launched by this supervisor', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    mocks.status
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ healthy: true, ready: true });
    mocks.shutdown.mockImplementation(async () => {
      child.exitCode = 0;
      child.emit('exit', 0);
    });
    const supervisor = new DaemonSupervisor('/test/data', '/test/socket');
    await supervisor.start();
    await supervisor.close();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ healthy: true, ready: false })
      .mockResolvedValue({ healthy: true, ready: true });
    const starting = new DaemonSupervisor('/test/data', '/test/socket').start();
    await vi.advanceTimersByTimeAsync(0);
    const initialRequests = mocks.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    expect(initialRequests).toBe(2);
    expect(mocks.status).toHaveBeenCalledTimes(3);
  });
});
