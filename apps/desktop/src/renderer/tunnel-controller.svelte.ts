import type { DesktopStatus, TunnelConfiguration, TunnelDoctorResult } from '@chatsplice/protocol';

import type { ChatSpliceBridge } from '../preload/index.js';
import type { Translate } from './appearance.js';
import type { UiLocale } from './i18n.js';
import { tunnelClientInstallErrorLabel, tunnelDoctorErrorLabel } from './tunnel-view.js';

/**
 * Tunnel connection-management state and flows. Status/toast state stays with
 * App.svelte; this controller owns only the connection form and doctor result.
 */
export interface TunnelControllerDeps {
  readonly bridge: ChatSpliceBridge;
  readonly t: () => Translate;
  readonly getLocale: () => UiLocale;
  readonly getStatus: () => DesktopStatus | null;
  readonly setStatus: (next: DesktopStatus) => void;
  readonly runAction: (name: string, action: () => Promise<void>) => Promise<void>;
  readonly onNotice: (message: string) => void;
  readonly onError: (message: string) => void;
  readonly supportsAutomaticTunnelInstall: boolean;
}

export class TunnelController {
  tunnelFormInitialized = $state(false);
  tunnelId = $state('');
  organizationId = $state('');
  manualExecutablePath = $state('');
  automaticStart = $state(true);
  tunnelDoctorResult = $state<TunnelDoctorResult | null>(null);

  readonly #deps: TunnelControllerDeps;

  constructor(deps: TunnelControllerDeps) {
    this.#deps = deps;
  }

  syncTunnelForm(nextStatus: DesktopStatus): void {
    const configuration = nextStatus.daemon.tunnel.configuration;
    if (configuration !== null) {
      this.tunnelId = configuration.tunnel_id;
      this.organizationId = configuration.organization_id;
      this.manualExecutablePath = configuration.executable_path;
      this.automaticStart = configuration.automatic_start;
      this.tunnelFormInitialized = true;
      return;
    }
    if (!this.tunnelFormInitialized) {
      this.tunnelId = nextStatus.daemon.tunnel.detected_tunnel_id ?? '';
      this.manualExecutablePath = nextStatus.daemon.tunnel.detected_executable_path ?? '';
      this.automaticStart = true;
      this.tunnelFormInitialized = true;
    }
  }

  #tunnelConfiguration(clientPath: string): TunnelConfiguration | null {
    if (this.tunnelId.trim() === '' || this.organizationId.trim() === '') return null;
    return {
      tunnel_id: this.tunnelId.trim(),
      organization_id: this.organizationId.trim(),
      executable_path: clientPath,
      automatic_start: this.automaticStart,
    };
  }

  async #resolveTunnelClientPath(): Promise<string | null> {
    const deps = this.#deps;
    const detectedPath = deps.getStatus()?.daemon.tunnel.detected_executable_path;
    if (detectedPath !== null && detectedPath !== undefined) return detectedPath;

    if (!deps.supportsAutomaticTunnelInstall) {
      const manualPath = this.manualExecutablePath.trim();
      if (manualPath === '') deps.onError(deps.t()('tunnelClientPathRequired'));
      return manualPath || null;
    }

    const result = await deps.bridge.installTunnelClient();
    if (result.status === 'failed') {
      deps.onError(tunnelClientInstallErrorLabel(deps.t(), result.error_code ?? 'network_error'));
      return null;
    }
    if (result.executable_path === null) {
      deps.onError(deps.t()('actionFailed'));
      return null;
    }
    return result.executable_path;
  }

  async saveTunnelConfiguration(): Promise<void> {
    const deps = this.#deps;
    if (this.tunnelId.trim() === '' || this.organizationId.trim() === '') {
      deps.onError(deps.t()('tunnelConfigurationRequired'));
      return;
    }
    await deps.runAction('tunnel-save', async () => {
      this.tunnelDoctorResult = null;
      const clientPath = await this.#resolveTunnelClientPath();
      if (clientPath === null) return;
      const configuration = this.#tunnelConfiguration(clientPath);
      if (configuration === null) return;
      deps.setStatus(await deps.bridge.configureTunnel(configuration));
      deps.onNotice(deps.t()('tunnelConfigurationSaved'));
    });
  }

  async requestTunnelCredential(): Promise<void> {
    const deps = this.#deps;
    if (deps.getStatus()?.daemon.tunnel.configuration === null) {
      deps.onError(deps.t()('saveAdvancedConfigurationFirst'));
      return;
    }
    await deps.runAction('credential', async () => {
      this.tunnelDoctorResult = null;
      const result = await deps.bridge.requestTunnelCredential(deps.getLocale());
      deps.setStatus(result.status);
      if (result.error_code === 'invalid_runtime_key') {
        deps.onError(deps.t()('invalidRuntimeKeyReenter'));
        return;
      }
      deps.onNotice(
        result.saved
          ? result.status.daemon.tunnel.error_code === 'external_tunnel_running'
            ? deps.t()('runtimeKeySavedExternalTunnel')
            : deps.t()('runtimeKeySaved')
          : deps.t()('runtimeKeyCancelled'),
      );
    });
  }

  async startTunnel(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('tunnel-start', async () => {
      this.tunnelDoctorResult = null;
      deps.setStatus(await deps.bridge.startTunnel());
      deps.onNotice(deps.t()('tunnelStarted'));
    });
  }

  async checkTunnel(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('tunnel-check', async () => {
      const result = await deps.bridge.checkTunnel();
      this.tunnelDoctorResult = result;
      if (result.state === 'passed') {
        deps.onNotice(deps.t()('tunnelCheckPassed'));
        return;
      }
      deps.onError(tunnelDoctorErrorLabel(deps.t(), result));
    });
  }

  async stopTunnel(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('tunnel-stop', async () => {
      this.tunnelDoctorResult = null;
      deps.setStatus(await deps.bridge.stopTunnel());
      deps.onNotice(deps.t()('tunnelStopped'));
    });
  }

  async removeTunnelCredential(): Promise<void> {
    const deps = this.#deps;
    await deps.runAction('credential-remove', async () => {
      this.tunnelDoctorResult = null;
      deps.setStatus(await deps.bridge.removeTunnelCredential());
      deps.onNotice(deps.t()('runtimeKeyRemoved'));
    });
  }
}
