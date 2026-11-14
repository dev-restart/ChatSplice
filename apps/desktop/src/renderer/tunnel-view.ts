import type { DesktopStatus, TunnelDoctorResult } from '@chatsplice/protocol';

import type { Translate } from './appearance.js';
import { uiText, type UiLocale } from './i18n.js';

export function resolveTunnelState(
  currentStatus: DesktopStatus | null,
  currentLocale: UiLocale,
): {
  label: string;
  tone: string;
} {
  const tunnel = currentStatus?.daemon.tunnel;
  if (tunnel?.ready) {
    return { label: uiText(currentLocale, 'connected'), tone: 'ok' };
  }
  if (tunnel?.state === 'starting') {
    return { label: uiText(currentLocale, 'connecting'), tone: 'warn' };
  }
  if (tunnel?.state === 'degraded' || tunnel?.state === 'failed') {
    return { label: uiText(currentLocale, 'connectionError'), tone: 'bad' };
  }
  return { label: uiText(currentLocale, 'connectionRequired'), tone: 'muted' };
}

export function tunnelErrorLabel(t: Translate, code: string | null): string {
  const labels: Record<string, string> = {
    mcp_endpoint_mismatch: t('endpointMismatch'),
    tunnel_id_mismatch: t('tunnelIdMismatch'),
    tunnel_client_not_found: t('tunnelClientNotFound'),
    tunnel_client_exited: t('tunnelClientExited'),
    invalid_runtime_key: t('invalidRuntimeKey'),
    external_tunnel_running: t('externalTunnelRunning'),
    tunnel_active_organization_required: t('organizationRequired'),
    mcp_probe_not_ready: t('mcpProbeNotReady'),
  };
  return code === null ? '' : (labels[code] ?? `${t('connectionError')}: ${code}`);
}

export function tunnelDoctorErrorLabel(t: Translate, result: TunnelDoctorResult): string {
  const labels: Record<Exclude<TunnelDoctorResult['error_code'], null>, string> = {
    tunnel_not_configured: t('saveAdvancedConfigurationFirst'),
    tunnel_client_not_found: t('tunnelClientNotFound'),
    tunnel_doctor_launch_failed: t('tunnelCheckLaunchFailed'),
    tunnel_doctor_failed: t('tunnelCheckFailed'),
    tunnel_doctor_timed_out: t('tunnelCheckTimedOut'),
  };
  return result.error_code === null ? t('tunnelCheckUnknownFailure') : labels[result.error_code];
}

export function tunnelClientInstallErrorLabel(
  t: Translate,
  errorCode: 'unsupported_platform' | 'network_error' | 'checksum_mismatch' | 'extraction_failed',
): string {
  if (errorCode === 'unsupported_platform') return t('tunnelClientInstallUnsupportedPlatform');
  if (errorCode === 'checksum_mismatch') return t('tunnelClientInstallChecksumMismatch');
  if (errorCode === 'extraction_failed') return t('tunnelClientInstallExtractionFailed');
  return t('tunnelClientInstallNetworkError');
}
