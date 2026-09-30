import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../renderer/App.svelte', import.meta.url), 'utf8');
const activityViewSource = readFileSync(
  new URL('../renderer/activity-view.ts', import.meta.url),
  'utf8',
);
const automationControllerSource = readFileSync(
  new URL('../renderer/project-automation-controller.svelte.ts', import.meta.url),
  'utf8',
);
const tunnelControllerSource = readFileSync(
  new URL('../renderer/tunnel-controller.svelte.ts', import.meta.url),
  'utf8',
);
const stylesSource = readFileSync(new URL('../renderer/styles.css', import.meta.url), 'utf8');
const windowSource = readFileSync(new URL('./window.ts', import.meta.url), 'utf8');

describe('App renderer copy and locale selection', () => {
  it('keeps localization inside the renderer boundary', () => {
    expect(appSource).toContain("from './i18n.js'");
    expect(appSource).toContain('UI_LOCALE_STORAGE_KEY');
    expect(appSource).toContain('$: t = translator(locale, mcpAppName);');
    expect(appSource).toContain("t('language')");
  });

  it('classifies local.prepare_apply before generic MCP success and failure states', () => {
    const activityStateStart = activityViewSource.indexOf('function activityStateLabel');
    const workspaceStateStart = activityViewSource.indexOf(
      'function workspaceMcpState',
      activityStateStart,
    );
    const functionSource = activityViewSource.slice(activityStateStart, workspaceStateStart);
    const prepareApplyIndex = functionSource.indexOf(
      "if (activity.tool === 'local.prepare_apply')",
    );

    expect(prepareApplyIndex).toBeGreaterThanOrEqual(0);
    expect(prepareApplyIndex).toBeLessThan(
      functionSource.indexOf("const localApply = activity.source === 'local_apply'"),
    );
    expect(functionSource).toContain("t('recentApplyRequestFailed')");
    expect(functionSource).toContain("t('applyRequestInProgress')");
    expect(functionSource).toContain("t('recentApplyRequest')");
  });

  it('keeps Project setup and tunnel guidance concise in both locales', () => {
    expect(appSource).toContain("t('updateInstructions')");
    expect(automationControllerSource).toContain(
      'this.projectChatRefreshWorkspaceId = workspaceId;',
    );
    expect(appSource).toContain('class="project-chat-refresh-note"');
    expect(appSource).toContain("t('projectChatRefreshRequired')");
    expect(appSource).toContain("t('projectChatRefreshBody')");
    expect(tunnelControllerSource).toContain('deps.bridge.checkTunnel()');
    expect(appSource).toContain("message.includes('credential_unreadable')");
    expect(appSource).toContain("t('runtimeKeyUnreadable')");
    expect(appSource).toContain('supportsAutomaticTunnelInstall');
    expect(tunnelControllerSource).toContain('await deps.bridge.installTunnelClient()');
    const manualPathFallbackStart = appSource.indexOf('{#if !supportsAutomaticTunnelInstall}');
    const manualPathFallbackEnd = appSource.indexOf('{/if}', manualPathFallbackStart);
    const manualPathFallback = appSource.slice(manualPathFallbackStart, manualPathFallbackEnd);
    expect(manualPathFallbackStart).toBeGreaterThanOrEqual(0);
    expect(manualPathFallback).toContain("t('tunnelClientPath')");
    expect(manualPathFallback).toContain('bind:value={tunnelController.manualExecutablePath}');
    expect(appSource).not.toContain("t('installTunnelClientAction')");
  });

  it('separates workspace management and message-level MCP guidance into dialogs', () => {
    expect(appSource).toContain('class="workspace-modal"');
    expect(appSource).toContain('class="help-modal"');
    expect(appSource).toContain('use:mountModal');
    expect(appSource).toContain('node.showModal()');
    expect(appSource).toContain("querySelector<HTMLElement>('[data-modal-initial-focus]')");
    expect(appSource).toContain('function trapModalFocus');
    expect(appSource).toContain('onkeydown={trapModalFocus}');
    expect(appSource).toContain('aria-modal="true"');
    expect(appSource).toContain('data-modal-initial-focus');
    expect(appSource).toContain('oncancel={cancelHelp}');
    expect(appSource).toContain('oncancel={cancelWorkspaceDetails}');
    expect(appSource).toContain("t('helpStepThreeTitle')");
    expect(appSource).toContain("t('helpStepFourTitle')");
    expect(appSource).toContain("t('localMcpSelectionGuide')");
    expect(appSource).not.toContain('project-context-menu');
    expect(appSource).not.toContain('<svelte:window onkeydown');
  });

  it('uses the full-window overlay for help, connection management, and workspace management', () => {
    const overlayStart = appSource.indexOf('const nextModalOverlayActive');
    const overlaySource = appSource.slice(overlayStart, overlayStart + 260);
    expect(overlayStart).toBeGreaterThanOrEqual(0);
    expect(overlaySource.replace(/\s+/g, ' ')).toContain(
      "const nextModalOverlayActive = helpOpen || tunnelHelpTopic !== null || workspaceDetailsId !== '' || connectionModalOpen;",
    );
    expect(appSource).toContain('class="help-modal tunnel-help-modal"');
    expect(appSource).toContain('class="connection-modal"');
    expect(appSource).toContain("t('manageConnection')");
    expect(appSource).not.toContain('aria-labelledby="read-only-heading"');
    expect(appSource).not.toContain('aria-labelledby="chatgpt-heading"');
    expect(appSource).not.toContain('aria-labelledby="connection-heading"');
    expect(appSource).not.toContain('class="diagnostics-details"');
  });

  it('keeps panel controls in the native chrome and exposes accessible resizers', () => {
    const footerStart = appSource.indexOf('<footer class="runtime-footer">');
    const footerEnd = appSource.indexOf('</footer>', footerStart);
    const footer = appSource.slice(footerStart, footerEnd);
    expect(footer).not.toContain('toggleWorkbenchPanel');
    expect(appSource).toContain('class="chrome-panel-toggles"');
    expect(appSource).toContain('files_width');
    expect(appSource).toContain('console_height');
    expect(appSource).toContain('role="separator"');
    expect(appSource).toContain('aria-orientation="vertical"');
    expect(appSource).toContain('aria-orientation="horizontal"');
    expect(stylesSource).toContain('.files-resize-handle');
    expect(stylesSource).toContain('.console-resize-handle');
  });

  it('keeps ChatGPT visible beneath the full-window modal backdrop', () => {
    expect(windowSource).toContain("localView.setBackgroundColor('#00000000')");
    expect(appSource).toContain('class:modal-overlay-active={modalOverlayActive}');
    expect(appSource).toContain('style={`--sidebar-width: ${sidebarWidth}px`}');
    expect(stylesSource).toContain('.shell.modal-overlay-active');
    expect(stylesSource).toContain('.shell.modal-overlay-active > :not(dialog)');
    expect(stylesSource).toContain('transparent var(--sidebar-width)');
  });

  it('keeps activity status colors wired to defined CSS tokens', () => {
    expect(stylesSource).toContain('--color-success: var(--color-ok);');
    expect(stylesSource).toContain('--color-warning: var(--color-warn);');
    expect(stylesSource).toContain('background: var(--color-success);');
    expect(stylesSource).toContain('background: var(--color-warning);');
  });
});
