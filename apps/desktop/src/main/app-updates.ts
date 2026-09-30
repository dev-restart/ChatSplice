import type { AppUpdater } from 'electron-updater';

export const RELEASES_URL = 'https://github.com/dev-restart/ChatSplice/releases';

export function supportsAppUpdates(
  packaged: boolean,
  platform: string,
  metadata: unknown,
): boolean {
  return (
    packaged &&
    platform === 'darwin' &&
    typeof metadata === 'object' &&
    metadata !== null &&
    'chatspliceUpdateChannel' in metadata &&
    metadata.chatspliceUpdateChannel === 'stable'
  );
}

type UpdateDependencies = {
  updater: Pick<
    AppUpdater,
    | 'autoDownload'
    | 'autoInstallOnAppQuit'
    | 'allowPrerelease'
    | 'allowDowngrade'
    | 'logger'
    | 'checkForUpdates'
    | 'downloadUpdate'
    | 'quitAndInstall'
    | 'on'
  >;
  choose: (message: string, buttons: string[]) => Promise<number>;
  stageNativeUpdate: () => Promise<void>;
  prepareToInstall: () => Promise<boolean>;
};

/** Only the owner main process can check, download or install updates. */
export class AppUpdateController {
  private checking = false;
  private downloading = false;
  private downloaded = false;
  private installing = false;

  constructor(private readonly dependencies: UpdateDependencies) {
    const updater = dependencies.updater;
    updater.autoDownload = false;
    // Native quit handlers can run before our dirty-editor confirmation.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // Do not log update URLs, headers or native error payloads.
    updater.logger = null;
    updater.on('error', () => undefined);
    updater.on('update-downloaded', () => {
      this.downloaded = true;
    });
  }

  async check(manual = false): Promise<void> {
    if (this.checking || this.downloading || this.installing) return;
    if (this.downloaded) return this.offerInstall();
    this.checking = true;
    try {
      const result = await this.dependencies.updater.checkForUpdates();
      if (result === null || !result.isUpdateAvailable) {
        if (manual) await this.dependencies.choose('현재 최신 버전입니다.', ['확인']);
        return;
      }
      const selected = await this.dependencies.choose('새 버전을 다운로드할까요?', [
        '다운로드',
        '나중에',
      ]);
      if (selected !== 0) return;
      this.downloading = true;
      await this.dependencies.updater.downloadUpdate();
      if (this.downloaded) {
        try {
          // Squirrel must verify/stage the ZIP before stopping local services.
          await this.dependencies.stageNativeUpdate();
        } catch (error) {
          this.downloaded = false;
          throw error;
        }
        await this.offerInstall();
      }
    } catch {
      if (manual || this.downloading)
        await this.dependencies.choose('업데이트를 완료하지 못했습니다. 잠시 후 다시 확인하세요.', [
          '확인',
        ]);
    } finally {
      this.checking = false;
      this.downloading = false;
    }
  }

  private async offerInstall(): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    try {
      const selected = await this.dependencies.choose(
        '업데이트가 준비되었습니다. 작업을 마치고 다시 시작할까요?',
        ['다시 시작', '나중에'],
      );
      if (selected !== 0 || !(await this.dependencies.prepareToInstall())) return;
      this.dependencies.updater.quitAndInstall();
    } finally {
      this.installing = false;
    }
  }
}
