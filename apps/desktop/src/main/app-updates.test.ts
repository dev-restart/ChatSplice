import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdateController, supportsAppUpdates } from './app-updates.js';

function fixture(choices: number[] = [0, 0], allowed = true) {
  const events = new EventEmitter();
  const updater = Object.assign(events, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: null,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true })),
    downloadUpdate: vi.fn(async () => {
      events.emit('update-downloaded');
      return [];
    }),
    quitAndInstall: vi.fn(),
  });
  const choose = vi.fn<(message: string, buttons: string[]) => Promise<number>>(
    async () => choices.shift() ?? 1,
  );
  const stageNativeUpdate = vi.fn(async () => undefined);
  const prepareToInstall = vi.fn(async () => allowed);
  const controller = new AppUpdateController({
    updater: updater as unknown as AppUpdater,
    choose,
    stageNativeUpdate,
    prepareToInstall,
  });
  return { controller, updater, choose, stageNativeUpdate, prepareToInstall };
}

describe('owner app updates', () => {
  it('never enables native updates in development or unsigned packages', () => {
    expect(supportsAppUpdates(true, 'darwin', {})).toBe(false);
    expect(supportsAppUpdates(false, 'darwin', { chatspliceUpdateChannel: 'stable' })).toBe(false);
    expect(supportsAppUpdates(true, 'linux', { chatspliceUpdateChannel: 'stable' })).toBe(false);
    expect(supportsAppUpdates(true, 'darwin', { chatspliceUpdateChannel: 'stable' })).toBe(true);
  });
  it('requires download consent and disables implicit quit installation', async () => {
    const f = fixture([1]);
    await f.controller.check();
    expect(f.updater.autoDownload).toBe(false);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    expect(f.updater.allowPrerelease).toBe(false);
    expect(f.updater.allowDowngrade).toBe(false);
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  });
  it('stages the native update before checking dirty files and quitting', async () => {
    const f = fixture();
    await f.controller.check(true);
    expect(f.stageNativeUpdate).toHaveBeenCalledOnce();
    expect(f.prepareToInstall).toHaveBeenCalledOnce();
    expect(f.stageNativeUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      f.prepareToInstall.mock.invocationCallOrder[0]!,
    );
    expect(f.prepareToInstall.mock.invocationCallOrder[0]).toBeLessThan(
      f.updater.quitAndInstall.mock.invocationCallOrder[0]!,
    );
  });
  it('canceling the dirty-editor guard retains the downloaded update for later', async () => {
    const f = fixture([0, 0, 0], false);
    await f.controller.check(true);
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    f.prepareToInstall.mockResolvedValueOnce(true);
    await f.controller.check(true);
    expect(f.updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(f.updater.quitAndInstall).toHaveBeenCalledOnce();
  });
  it('native staging failure never stops local services', async () => {
    const f = fixture();
    f.stageNativeUpdate.mockRejectedValueOnce(new Error('signature mismatch'));
    await f.controller.check(true);
    expect(f.prepareToInstall).not.toHaveBeenCalled();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(f.choose.mock.calls.at(-1)?.[0]).not.toContain('signature mismatch');
  });
  it('concurrent checks cannot open duplicate prompts or downloads', async () => {
    const f = fixture();
    await Promise.all([f.controller.check(), f.controller.check()]);
    expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(f.updater.downloadUpdate).toHaveBeenCalledOnce();
  });
});
