<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from '@xterm/xterm';
  import type { ITheme } from '@xterm/xterm';
  import '@xterm/xterm/css/xterm.css';

  import type {
    ReadTerminalSessionInput,
    TerminalSessionSnapshot,
    TerminalSessionSummary,
    WriteTerminalSessionInput,
  } from '@chatsplice/protocol';
  import type { ChatSpliceBridge } from '../preload/index.js';
  import type { UiLocale } from './i18n.js';
  import { TERMINAL_POLL_INTERVAL_MS } from './terminal-session.js';

  const ACTIVE_TERMINAL_POLL_INTERVAL_MS = 50;

  export let bridge: ChatSpliceBridge;
  export let workspaceId: string;
  export let session: TerminalSessionSummary;
  export let active = false;
  export let locale: UiLocale = 'en';

  let host: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let themeObserver: MutationObserver | undefined;
  let systemThemeQuery: MediaQueryList | undefined;
  let pollTimer: number | undefined;
  let resizeRetryTimer: number | undefined;
  let outputSequence: number | undefined;
  let pollSerial = 0;
  let resizeSerial = 0;
  let exitedReplayRead = false;
  let readInFlight = false;
  let destroyed = false;
  let lastSize = '';
  let pendingSize = '';
  let replayTruncated = false;
  let errorMessage = '';
  let inputQueue: Promise<void> = Promise.resolve();

  function localized(en: string, ko: string): string {
    return locale === 'ko' ? ko : en;
  }

  function isDarkTheme(): boolean {
    const rootTheme = document.documentElement.dataset.theme;
    if (rootTheme === 'dark') return true;
    if (rootTheme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function cssColor(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function terminalTheme(): ITheme {
    const dark = isDarkTheme();
    const background = cssColor('--color-surface', dark ? '#171717' : '#fbfbfc');
    const foreground = cssColor('--color-text', dark ? '#e7ebef' : '#1f2937');
    const selectionBackground = cssColor('--color-selected', dark ? '#2f2f2f' : '#cbd5e1');
    return dark
      ? {
          background,
          foreground,
          cursor: foreground,
          cursorAccent: background,
          selectionBackground,
          black: '#111827',
          brightBlack: '#6b7280',
          red: '#fb7185',
          brightRed: '#fda4af',
          green: '#4ade80',
          brightGreen: '#86efac',
          yellow: '#facc15',
          brightYellow: '#fde68a',
          blue: '#60a5fa',
          brightBlue: '#93c5fd',
          magenta: '#c084fc',
          brightMagenta: '#d8b4fe',
          cyan: '#22d3ee',
          brightCyan: '#67e8f9',
          white: '#d1d5db',
          brightWhite: '#f9fafb',
        }
      : {
          background,
          foreground,
          cursor: foreground,
          cursorAccent: background,
          selectionBackground,
        };
  }

  function updateTerminalTheme(): void {
    if (destroyed || terminal === undefined) return;
    terminal.options.theme = terminalTheme();
    fitAndResize();
  }

  function fitAndResize(): void {
    if (destroyed || !terminal || !fitAddon || !active) return;
    if (host === undefined || host.clientWidth < 2 || host.clientHeight < 2) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = terminal;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return;
    const size = `${cols}x${rows}`;
    if (size === lastSize || size === pendingSize) return;
    pendingSize = size;
    const requestId = ++resizeSerial;
    void bridge
      .resizeTerminalSession({
        workspace_id: workspaceId,
        terminal_id: session.terminal_id,
        cols,
        rows,
      })
      .then(() => {
        if (requestId === resizeSerial) {
          lastSize = size;
          pendingSize = '';
        }
      })
      .catch(() => {
        if (!destroyed && requestId === resizeSerial) {
          pendingSize = '';
          lastSize = '';
          errorMessage = localized(
            'Terminal size could not be updated.',
            'Terminal 크기를 업데이트하지 못했습니다.',
          );
          if (resizeRetryTimer === undefined) {
            resizeRetryTimer = window.setTimeout(() => {
              resizeRetryTimer = undefined;
              fitAndResize();
            }, TERMINAL_POLL_INTERVAL_MS);
          }
        }
      });
  }

  async function pollOutput(): Promise<void> {
    if (destroyed || readInFlight || exitedReplayRead) return;
    const requestId = ++pollSerial;
    readInFlight = true;
    try {
      const input: ReadTerminalSessionInput = {
        workspace_id: workspaceId,
        terminal_id: session.terminal_id,
        ...(outputSequence === undefined ? {} : { after_sequence: outputSequence }),
      };
      const result: TerminalSessionSnapshot = await bridge.readTerminalSession(input);
      if (destroyed || requestId !== pollSerial) return;
      if (result.output !== '' && terminal !== undefined) {
        terminal.write(result.output);
      }
      if (result.replay_truncated && !replayTruncated && terminal !== undefined) {
        terminal.write(
          `\r\n[${localized('Earlier output was truncated.', '이전 출력이 일부 생략되었습니다.')}]\r\n`,
        );
        replayTruncated = true;
      }
      outputSequence = result.sequence;
      session = {
        terminal_id: result.terminal_id,
        label: result.label,
        workspace_id: result.workspace_id,
        state: result.state,
        cols: result.cols,
        rows: result.rows,
        sequence: result.sequence,
      };
      if (result.state === 'exited') exitedReplayRead = true;
      errorMessage = '';
    } catch {
      if (!destroyed && requestId === pollSerial) {
        errorMessage = localized(
          'Terminal output could not be read.',
          'Terminal 출력을 읽지 못했습니다.',
        );
      }
    } finally {
      if (requestId === pollSerial) readInFlight = false;
    }
  }

  function schedulePoll(
    delay = active ? ACTIVE_TERMINAL_POLL_INTERVAL_MS : TERMINAL_POLL_INTERVAL_MS,
  ): void {
    if (destroyed || exitedReplayRead) return;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => {
      pollTimer = undefined;
      void pollOutput().finally(() => schedulePoll());
    }, delay);
  }

  function handleData(data: string): void {
    if (destroyed || !active || session.state === 'exited' || data === '') return;
    const input: WriteTerminalSessionInput = {
      workspace_id: workspaceId,
      terminal_id: session.terminal_id,
      data,
    };
    inputQueue = inputQueue
      .then(() => bridge.writeTerminalSession(input))
      .catch(() => {
        if (!destroyed) {
          errorMessage = localized(
            'Terminal input could not be sent.',
            'Terminal 입력을 보내지 못했습니다.',
          );
        }
      });
  }

  function focusTerminal(): void {
    terminal?.focus();
  }

  function handleTerminalMouseDown(event: MouseEvent): void {
    if (event.button === 0 && active && !destroyed) focusTerminal();
  }

  function updateVisibility(): void {
    if (active) {
      window.requestAnimationFrame(() => {
        if (active && !destroyed) {
          fitAndResize();
          focusTerminal();
        }
      });
    }
  }

  $: if (terminal !== undefined) {
    if (active) updateVisibility();
    schedulePoll(active ? 0 : TERMINAL_POLL_INTERVAL_MS);
  }

  onMount(() => {
    if (host === undefined) return;
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'block',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      scrollback: 4_096,
      theme: terminalTheme(),
    });
    if (session.state === 'exited') exitedReplayRead = false;
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminal.onData(handleData);
    terminal.onBinary(handleData);
    resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(host);
    themeObserver = new MutationObserver(() => updateTerminalTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeQuery.addEventListener('change', updateTerminalTheme);
    schedulePoll(0);
    updateVisibility();
  });

  onDestroy(() => {
    destroyed = true;
    pollSerial += 1;
    resizeSerial += 1;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    if (resizeRetryTimer !== undefined) window.clearTimeout(resizeRetryTimer);
    resizeObserver?.disconnect();
    themeObserver?.disconnect();
    systemThemeQuery?.removeEventListener('change', updateTerminalTheme);
    terminal?.dispose();
    terminal = undefined;
    fitAddon = undefined;
  });
</script>

<div class="terminal-pane" class:terminal-pane-hidden={!active} aria-hidden={!active}>
  <div
    class="terminal-host"
    bind:this={host}
    role="textbox"
    aria-label={locale === 'ko' ? 'Terminal 입력' : 'Terminal input'}
    aria-multiline="true"
    tabindex="0"
    onfocus={focusTerminal}
    onmousedown={handleTerminalMouseDown}
  ></div>
  {#if errorMessage !== ''}
    <p class="terminal-pane-error" role="status">{errorMessage}</p>
  {/if}
  {#if replayTruncated}
    <p class="terminal-pane-warning" role="status">
      {localized('Earlier output was truncated.', '이전 출력이 일부 생략되었습니다.')}
    </p>
  {/if}
</div>

<style>
  .terminal-pane {
    position: relative;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
    background: var(--color-surface, #fbfbfc);
  }

  .terminal-pane-hidden {
    display: none;
  }

  .terminal-host {
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 8px 10px;
  }

  .terminal-host :global(.xterm) {
    width: 100%;
    height: 100%;
    padding: 0;
  }

  .terminal-host :global(.xterm-viewport) {
    background: transparent !important;
    scrollbar-color: var(--color-border-strong, #374151) transparent;
    scrollbar-width: thin;
  }

  .terminal-host :global(.xterm-screen) {
    padding: 0;
  }

  .terminal-pane-error {
    position: absolute;
    right: 10px;
    bottom: 8px;
    max-width: min(360px, calc(100% - 20px));
    margin: 0;
    border: 1px solid rgb(248 113 113 / 35%);
    border-radius: 5px;
    background: rgb(127 29 29 / 80%);
    padding: 4px 7px;
    color: #fecaca;
    font-size: 10px;
  }

  .terminal-pane-warning {
    position: absolute;
    right: 10px;
    top: 8px;
    margin: 0;
    border: 1px solid rgb(250 204 21 / 35%);
    border-radius: 5px;
    background: rgb(113 63 18 / 80%);
    padding: 4px 7px;
    color: #fde68a;
    font-size: 10px;
  }
</style>
