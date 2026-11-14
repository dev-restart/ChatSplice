import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const pane = readFileSync(new URL('./TerminalPane.svelte', import.meta.url), 'utf8');
const consoleSource = readFileSync(new URL('./WorkbenchConsole.svelte', import.meta.url), 'utf8');

function styleRule(source: string, selector: string): string {
  const start = source.indexOf(`  ${selector} {`);
  expect(start, `Missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start) + 1);
}

// Structural guards for the native surface. These do not replace a real
// Electron/browser check of pixel geometry, terminal input or PTY resizing.
describe('terminal viewport and tab layout', () => {
  it('keeps padding outside the element measured by FitAddon', () => {
    const host = styleRule(pane, '.terminal-host');
    const outer = styleRule(pane, '.terminal-pane');
    expect(host).toContain('padding: 0;');
    expect(host).toContain('flex: 1 1 0;');
    expect(host).toContain('min-height: 0;');
    expect(host).not.toContain('height: 100%;');
    expect(host).not.toContain('width: 100%;');
    expect(outer).toContain('flex-direction: column;');
    expect(outer).toContain('padding: 8px 10px 12px;');
  });

  it('schedules layout after resize, font loading and visibility changes with cleanup', () => {
    expect(pane).toContain('fitFrame = window.requestAnimationFrame(');
    expect(pane).toContain('fitFrame !== undefined');
    expect(pane).toContain('new ResizeObserver(() => scheduleFit())');
    expect(pane).toContain("window.addEventListener('resize', scheduleFit)");
    expect(pane).toContain("window.removeEventListener('resize', scheduleFit)");
    expect(pane).toContain('document.fonts.ready.then(() => scheduleFit())');
    expect(pane).toContain("document.fonts.removeEventListener('loadingdone', scheduleFit)");
    expect(pane).toContain('window.cancelAnimationFrame(fitFrame)');
    expect(consoleSource).toContain(
      'active={panelState.console_open && session.terminal_id === activeSessionId}',
    );
  });

  it('reserves space for notices instead of covering the prompt', () => {
    const noticeIndex = pane.indexOf('<div class="terminal-notices">');
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(pane.indexOf('class="terminal-host"'));
    expect(styleRule(pane, '.terminal-notices')).toContain('flex: 0 0 auto;');
    expect(styleRule(pane, '.terminal-pane-error')).not.toContain('position: absolute');
    expect(styleRule(pane, '.terminal-pane-warning')).not.toContain('position: absolute');
    expect(styleRule(consoleSource, '.terminal-stage-error')).not.toContain('position: absolute');
  });

  it('keeps the new-tab action outside the horizontally scrolling tabs', () => {
    const stripStart = consoleSource.indexOf('<div class="terminal-tab-scroll"');
    const stripEnd = consoleSource.indexOf('\n    </div>', stripStart);
    const addButton = consoleSource.indexOf('class="terminal-tab-add"');
    expect(stripStart).toBeGreaterThanOrEqual(0);
    expect(stripEnd).toBeGreaterThan(stripStart);
    expect(addButton).toBeGreaterThan(stripEnd);
    expect(styleRule(consoleSource, '.terminal-tab-add')).toContain('flex: 0 0 28px;');
    expect(styleRule(consoleSource, '.terminal-tab')).toContain('flex: 0 0 auto;');
    expect(consoleSource).toContain('sessionsLoading || creatingSession');
  });

  it('reveals the active tab and retains keyboard-visible focus and full labels', () => {
    expect(consoleSource).toContain('revealActiveTab(activeSessionId, mode)');
    expect(consoleSource).toContain("scrollIntoView({ block: 'nearest', inline: 'nearest' })");
    expect(consoleSource).toContain('.terminal-tab-select:focus-visible');
    expect(consoleSource).toContain('.terminal-tab-close:focus-visible');
    expect(consoleSource).toContain('title={`${sessionLabel(session, index)}');
    expect(consoleSource).toContain('aria-label={locale');
  });
});
