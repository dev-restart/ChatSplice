import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SettingsRepository } from '@chatsplice/core';
import {
  MCP_AUTH_HEADER,
  TunnelClientInstallResultSchema,
  TunnelConfigurationSchema,
  TunnelDoctorResultSchema,
  TunnelStartInputSchema,
  TunnelStatusSchema,
} from '@chatsplice/protocol';
import type {
  TunnelClientInstallResult,
  TunnelConfiguration,
  TunnelDoctorResult,
  TunnelStartInput,
  TunnelStatus,
} from '@chatsplice/protocol';

import { detectInstalledTunnelClient } from './detect.js';
import { probeTunnelHealth } from './health.js';
import { installTunnelClient } from './install.js';

const EXTERNAL_ADMIN_URL = 'http://127.0.0.1:8080';
const REFRESH_INTERVAL_MS = 1_500;
const RESTART_DELAY_MS = 2_000;
const RESTART_DELAY_MAX_MS = 30_000;
const DOCTOR_TIMEOUT_MS = 15_000;

type ProcessSpawner = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface TunnelSupervisorOptions {
  readonly dataDirectory: string;
  readonly mcpUrl: string;
  readonly tokenPath: string;
  readonly settingsRepository: SettingsRepository;
  readonly spawnProcess?: ProcessSpawner;
  readonly probeHealth?: typeof probeTunnelHealth;
  readonly externalAdminUrl?: string;
  readonly installClient?: typeof installTunnelClient;
}

export function buildTunnelEnvironment(
  configuration: TunnelConfiguration,
  runtimeApiKey: string,
  mcpUrl: string,
  tokenPath: string,
  healthUrlPath: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['LANG', 'LC_ALL', 'PATH', 'TMPDIR'] as const) {
    const value = baseEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  const localHeader = `${MCP_AUTH_HEADER}: file:${tokenPath}`;
  return {
    ...environment,
    CONTROL_PLANE_API_KEY: runtimeApiKey,
    CONTROL_PLANE_ORGANIZATION_ID: configuration.organization_id,
    CONTROL_PLANE_TUNNEL_ID: configuration.tunnel_id,
    MCP_SERVER_URL: mcpUrl,
    MCP_EXTRA_HEADERS: localHeader,
    MCP_DISCOVERY_EXTRA_HEADERS: localHeader,
    HEALTH_LISTEN_ADDR: '127.0.0.1:0',
    HEALTH_URL_FILE: healthUrlPath,
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'info',
  };
}

function baseStatus(configuration?: TunnelConfiguration): TunnelStatus {
  return TunnelStatusSchema.parse({
    mode: 'none',
    state: configuration === undefined ? 'unconfigured' : 'stopped',
    healthy: false,
    ready: false,
    configuration: configuration ?? null,
    detected_executable_path: null,
    detected_tunnel_id: null,
    mcp_url: null,
    admin_url: null,
    error_code: null,
  });
}

function waitForDoctor(
  child: ChildProcess,
): Promise<'passed' | 'failed' | 'timed_out' | 'launch_failed'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'passed' | 'failed' | 'timed_out' | 'launch_failed'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
      finish('timed_out');
    }, DOCTOR_TIMEOUT_MS);
    timeout.unref();
    child.once('error', () => finish('launch_failed'));
    child.once('exit', (code) => finish(code === 0 ? 'passed' : 'failed'));
  });
}

export class TunnelSupervisor {
  readonly #options: TunnelSupervisorOptions;
  readonly #spawnProcess: ProcessSpawner;
  readonly #probeHealth: typeof probeTunnelHealth;
  readonly #externalAdminUrl: string;
  readonly #healthUrlPath: string;
  #child: ChildProcess | undefined;
  #runtimeApiKey: string | undefined;
  #status: TunnelStatus;
  #closed = false;
  #manualStop = false;
  #lifecycleRevision = 0;
  #refreshTimer: NodeJS.Timeout;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartAttempts = 0;

  public constructor(options: TunnelSupervisorOptions) {
    this.#options = options;
    this.#spawnProcess =
      options.spawnProcess ??
      ((command, arguments_, spawnOptions) => spawn(command, [...arguments_], spawnOptions));
    this.#probeHealth = options.probeHealth ?? probeTunnelHealth;
    this.#externalAdminUrl = options.externalAdminUrl ?? EXTERNAL_ADMIN_URL;
    this.#healthUrlPath = join(options.dataDirectory, 'run', 'tunnel-health-url');
    this.#status = baseStatus(options.settingsRepository.getTunnelConfiguration());
    this.#refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.#refreshTimer.unref();
    void this.refresh();
  }

  public status(): TunnelStatus {
    return TunnelStatusSchema.parse(this.#status);
  }

  public async configure(input: TunnelConfiguration): Promise<TunnelStatus> {
    const configuration = TunnelConfigurationSchema.parse(input);
    this.#lifecycleRevision += 1;
    if (this.#closed) {
      return this.status();
    }
    const previous = this.#options.settingsRepository.getTunnelConfiguration();
    if (this.#child !== undefined && JSON.stringify(previous) !== JSON.stringify(configuration)) {
      const stopping = this.stop();
      const expectedRevision = this.#lifecycleRevision;
      await stopping;
      if (this.#closed || expectedRevision !== this.#lifecycleRevision) {
        return this.status();
      }
    }
    if (this.#closed) {
      return this.status();
    }
    this.#options.settingsRepository.setTunnelConfiguration(configuration);
    this.#status = { ...baseStatus(configuration), state: 'stopped' };
    await this.refresh();
    return this.status();
  }

  public async start(input: TunnelStartInput): Promise<TunnelStatus> {
    const { runtime_api_key: runtimeApiKey } = TunnelStartInputSchema.parse(input);
    const lifecycleRevision = ++this.#lifecycleRevision;
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    let configuration = this.#options.settingsRepository.getTunnelConfiguration();
    if (configuration === undefined) {
      this.#status = baseStatus();
      return this.status();
    }

    await this.refresh();
    if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
      return this.status();
    }
    if (
      this.#status.mode === 'external' &&
      this.#status.ready &&
      this.#status.detected_tunnel_id === configuration.tunnel_id
    ) {
      return this.status();
    }
    if (this.#status.mode === 'external' && this.#status.healthy) {
      this.#status = {
        ...this.#status,
        ready: false,
        state: 'degraded',
        error_code: 'external_tunnel_running',
      };
      return this.status();
    }
    if (this.#child !== undefined && this.#child.exitCode === null) {
      return this.status();
    }

    let executable = await detectInstalledTunnelClient(
      this.#options.dataDirectory,
      configuration.executable_path,
    );
    if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
      return this.status();
    }
    if (executable === undefined && configuration.automatic_start) {
      const installed = TunnelClientInstallResultSchema.parse(
        await (this.#options.installClient ?? installTunnelClient)(this.#options.dataDirectory),
      );
      if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) return this.status();
      if (installed.executable_path !== null && installed.status !== 'failed') {
        executable = await detectInstalledTunnelClient(
          this.#options.dataDirectory,
          installed.executable_path,
        );
        if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) return this.status();
        if (executable !== undefined) {
          configuration = this.#options.settingsRepository.setTunnelConfiguration({
            ...configuration,
            executable_path: executable,
          });
        }
      }
      if (installed.status === 'failed') {
        this.#status = {
          ...baseStatus(configuration),
          state: 'failed',
          error_code: installed.error_code ?? 'tunnel_client_not_found',
        };
        return this.status();
      }
    }
    if (executable === undefined) {
      this.#status = {
        ...baseStatus(configuration),
        state: 'failed',
        error_code: 'tunnel_client_not_found',
      };
      return this.status();
    }

    await rm(this.#healthUrlPath, { force: true });
    if (
      this.#closed ||
      lifecycleRevision !== this.#lifecycleRevision ||
      (this.#child !== undefined && this.#child.exitCode === null)
    ) {
      return this.status();
    }
    this.#runtimeApiKey = runtimeApiKey;
    this.#manualStop = false;
    let child: ChildProcess;
    try {
      child = this.#spawnProcess(executable, ['run'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildTunnelEnvironment(
          configuration,
          runtimeApiKey,
          this.#options.mcpUrl,
          this.#options.tokenPath,
          this.#healthUrlPath,
        ),
      });
    } catch {
      this.#status = {
        ...baseStatus(configuration),
        mode: 'managed',
        state: 'failed',
        error_code: 'tunnel_client_launch_failed',
      };
      this.#scheduleRestart();
      return this.status();
    }
    this.#child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    const failed = (errorCode: string): void => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (this.#closed || this.#manualStop) return;
      this.#status = {
        ...baseStatus(configuration),
        mode: 'managed',
        state: 'failed',
        error_code: errorCode,
      };
      this.#scheduleRestart();
    };
    child.once('error', () => failed('tunnel_client_launch_failed'));
    child.once('exit', () => failed('tunnel_client_exited'));
    this.#status = {
      ...baseStatus(configuration),
      mode: 'managed',
      state: 'starting',
      mcp_url: this.#options.mcpUrl,
    };
    return this.status();
  }

  #scheduleRestart(): void {
    const configuration = this.#options.settingsRepository.getTunnelConfiguration();
    if (
      this.#restartTimer !== undefined ||
      !configuration?.automatic_start ||
      this.#runtimeApiKey === undefined ||
      this.#closed ||
      this.#manualStop
    )
      return;
    const revision = this.#lifecycleRevision;
    const delay = Math.min(
      RESTART_DELAY_MAX_MS,
      RESTART_DELAY_MS * 2 ** Math.min(this.#restartAttempts++, 4),
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      const key = this.#runtimeApiKey;
      if (
        key !== undefined &&
        !this.#closed &&
        !this.#manualStop &&
        revision === this.#lifecycleRevision
      ) {
        void this.start({ runtime_api_key: key }).catch(() => {
          this.#status = {
            ...baseStatus(this.#options.settingsRepository.getTunnelConfiguration()),
            state: 'failed',
            error_code: 'tunnel_restart_failed',
          };
          this.#scheduleRestart();
        });
      }
    }, delay);
    this.#restartTimer.unref();
  }

  /**
   * Runs the vendor-supported readiness preflight with a fixed argv. This is
   * intentionally independent from managed tunnel state: it never starts,
   * stops, restarts, or retains a runtime API key, and it discards all output.
   */
  public async doctor(input: TunnelStartInput): Promise<TunnelDoctorResult> {
    const { runtime_api_key: runtimeApiKey } = TunnelStartInputSchema.parse(input);
    const configuration = this.#options.settingsRepository.getTunnelConfiguration();
    if (configuration === undefined) {
      return TunnelDoctorResultSchema.parse({
        state: 'failed',
        error_code: 'tunnel_not_configured',
      });
    }

    const executable = await detectInstalledTunnelClient(
      this.#options.dataDirectory,
      configuration.executable_path,
    );
    if (executable === undefined) {
      return TunnelDoctorResultSchema.parse({
        state: 'failed',
        error_code: 'tunnel_client_not_found',
      });
    }

    let child: ChildProcess;
    try {
      child = this.#spawnProcess(executable, ['doctor', '--explain'], {
        shell: false,
        stdio: 'ignore',
        env: buildTunnelEnvironment(
          configuration,
          runtimeApiKey,
          this.#options.mcpUrl,
          this.#options.tokenPath,
          this.#healthUrlPath,
        ),
      });
    } catch {
      return TunnelDoctorResultSchema.parse({
        state: 'failed',
        error_code: 'tunnel_doctor_launch_failed',
      });
    }

    const outcome = await waitForDoctor(child);
    return TunnelDoctorResultSchema.parse(
      outcome === 'passed'
        ? { state: 'passed', error_code: null }
        : {
            state: 'failed',
            error_code:
              outcome === 'timed_out'
                ? 'tunnel_doctor_timed_out'
                : outcome === 'launch_failed'
                  ? 'tunnel_doctor_launch_failed'
                  : 'tunnel_doctor_failed',
          },
    );
  }

  /**
   * Fetches and installs OpenAI's official `tunnel-client` release, then
   * refreshes so a newly installed executable is reflected in
   * `detected_executable_path` immediately instead of waiting for the next
   * timer tick.
   */
  public async install(): Promise<TunnelClientInstallResult> {
    const result = TunnelClientInstallResultSchema.parse(
      await installTunnelClient(this.#options.dataDirectory),
    );
    await this.refresh();
    return result;
  }

  public async stop(): Promise<TunnelStatus> {
    const lifecycleRevision = ++this.#lifecycleRevision;
    this.#manualStop = true;
    this.#restartAttempts = 0;
    this.#runtimeApiKey = undefined;
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (lifecycleRevision === this.#lifecycleRevision) {
      this.#status = baseStatus(this.#options.settingsRepository.getTunnelConfiguration());
    }
    return this.status();
  }

  public async refresh(): Promise<TunnelStatus> {
    if (this.#closed) {
      return this.status();
    }
    const lifecycleRevision = this.#lifecycleRevision;
    const configuration = this.#options.settingsRepository.getTunnelConfiguration();
    const detectedExecutablePath = await detectInstalledTunnelClient(
      this.#options.dataDirectory,
      configuration?.executable_path,
    );
    if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
      return this.status();
    }
    const managed = this.#child !== undefined && this.#child.exitCode === null;
    let adminUrl: string | undefined;
    if (managed) {
      adminUrl = (await readFile(this.#healthUrlPath, 'utf8').catch(() => '')).trim() || undefined;
    } else {
      adminUrl = this.#externalAdminUrl;
    }
    if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
      return this.status();
    }
    if (adminUrl === undefined) {
      return this.status();
    }

    try {
      const health = await this.#probeHealth(adminUrl, this.#options.mcpUrl);
      if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
        return this.status();
      }
      if (health.ready) this.#restartAttempts = 0;
      const belongsToConfiguredTunnel =
        configuration === undefined || health.tunnelId === configuration.tunnel_id;
      this.#status = TunnelStatusSchema.parse({
        mode: managed ? 'managed' : 'external',
        state: health.ready && belongsToConfiguredTunnel ? 'ready' : 'degraded',
        healthy: health.healthy,
        ready: health.ready && belongsToConfiguredTunnel,
        configuration: configuration ?? null,
        detected_executable_path: detectedExecutablePath ?? null,
        detected_tunnel_id: health.tunnelId,
        mcp_url: health.mcpUrl,
        admin_url: adminUrl,
        error_code: belongsToConfiguredTunnel ? health.errorCode : 'tunnel_id_mismatch',
      });
    } catch {
      if (this.#closed || lifecycleRevision !== this.#lifecycleRevision) {
        return this.status();
      }
      if (managed) {
        this.#status = {
          ...baseStatus(configuration),
          mode: 'managed',
          state: 'starting',
          mcp_url: this.#options.mcpUrl,
        };
      } else {
        this.#status = {
          ...(this.#status.state === 'failed' ? this.#status : baseStatus(configuration)),
          detected_executable_path: detectedExecutablePath ?? null,
        };
      }
    }
    return this.status();
  }

  public async close(): Promise<void> {
    this.#closed = true;
    this.#lifecycleRevision += 1;
    clearInterval(this.#refreshTimer);
    await this.stop();
  }
}
