<script lang="ts">
  import { onMount, tick } from 'svelte';

  import type {
    DirectMcpActivity,
    DesktopStatus,
    PanelState,
    WorkspaceDetail,
    TerminalSessionSummary,
  } from '@chatsplice/protocol';

  import type { ChatSpliceBridge } from '../preload/index.js';
  import ExecutionJobs from './ExecutionJobs.svelte';
  import GoalPane from './GoalPane.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import { snapshotToSummary, terminalSessionLabel } from './terminal-session.js';
  import { uiText, type UiLocale, type UiTextKey } from './i18n.js';

  export let locale: UiLocale;

  type ConsoleMode = 'terminal' | 'history' | 'goals';
  const bridge: ChatSpliceBridge = window.chatsplice;
  const PANEL_POLL_INTERVAL_MS = 700;
  const HISTORY_POLL_INTERVAL_MS = 2_000;

  function localized(en: string, ko: string): string {
    return locale === 'ko' ? ko : en;
  }

  let panelState: PanelState = {
    workspace_id: null,
    console_open: true,
    files_open: false,
    files_width: 340,
    console_height: 260,
  };
  let workspaces: WorkspaceDetail[] = [];
  let status: DesktopStatus | null = null;
  let mode: ConsoleMode = 'terminal';
  let historyTab: 'executions' | 'activity' = 'executions';
  let sessionsByWorkspace: Record<string, TerminalSessionSummary[]> = {};
  let activeSessionByWorkspace: Record<string, string> = {};
  let selectedWorkspaceId = '';
  let activeSessionId = '';
  let loading = true;
  let sessionsLoading = false;
  let creatingSession = false;
  let tabStrip: HTMLDivElement | undefined;
  let errorMessage = '';
  let terminalError = '';
  let destroyed = false;
  let previousConsoleOpen = false;
  let panelRequestSerial = 0;
  let workspaceGenerations: Record<string, number> = {};
  let sessionIntentByWorkspace: Record<string, number> = {};
  let historyRequestSerial = 0;
  let panelTimer: number | undefined;
  let historyTimer: number | undefined;
  const initialOpenHandled = new Set<string>();
  let closingTerminalIds = new Set<string>();

  $: selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspace_id === selectedWorkspaceId,
  );
  $: selectedSessions =
    selectedWorkspaceId === '' ? [] : (sessionsByWorkspace[selectedWorkspaceId] ?? []);
  $: jobs = (status?.daemon.execution_jobs ?? [])
    .filter((job) => job.workspace_id === selectedWorkspaceId)
    .slice()
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  $: activeSessionId = activeSessionByWorkspace[selectedWorkspaceId] ?? '';
  $: void revealActiveTab(activeSessionId, mode);
  $: activities = (status?.daemon.latest_mcp_activities ?? [])
    .filter((activity) => activity.workspace_id === selectedWorkspaceId)
    .slice()
    .sort((left, right) => activityTimestamp(right).localeCompare(activityTimestamp(left)));

  function text(key: UiTextKey, values: Record<string, string | number> = {}): string {
    return uiText(locale, key, values);
  }

  function activityTimestamp(activity: DirectMcpActivity): string {
    return activity.completed_at ?? activity.started_at;
  }

  function formatActivityTime(value: string): string {
    return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  }

  function activityStateLabel(activity: DirectMcpActivity): string {
    if (activity.state === 'running') return text('consoleRunning');
    if (activity.state === 'failed') return text('consoleFailed');
    return text('consoleSucceeded');
  }

  function activitySourceLabel(activity: DirectMcpActivity): string {
    return activity.source === 'local_apply'
      ? text('consoleSourceApply')
      : text('consoleSourceMcp');
  }

  function activityKindLabel(activity: DirectMcpActivity): string {
    if (activity.tool === 'project.run' || activity.tool === 'project.git') {
      return text('consoleCommandActivity');
    }
    if (activity.tool.startsWith('fs.')) return text('consoleFileActivity');
    return text('consoleActivity');
  }

  function workspaceName(workspace: WorkspaceDetail | undefined): string {
    if (workspace === undefined) return '';
    const rootName = workspace.root_path.split('/').filter(Boolean).at(-1);
    return rootName || workspace.display_name;
  }

  function sessionLabel(session: TerminalSessionSummary, index: number): string {
    return terminalSessionLabel(session, workspaceName(selectedWorkspace), index);
  }

  function setWorkspaceSessions(workspaceId: string, sessions: TerminalSessionSummary[]): void {
    sessionsByWorkspace = {
      ...sessionsByWorkspace,
      [workspaceId]: sessions,
    };
    const remembered = activeSessionByWorkspace[workspaceId] ?? '';
    const nextActive = sessions.some((session) => session.terminal_id === remembered)
      ? remembered
      : (sessions[0]?.terminal_id ?? '');
    if (nextActive !== remembered) {
      activeSessionByWorkspace = {
        ...activeSessionByWorkspace,
        [workspaceId]: nextActive,
      };
    }
  }

  function workspaceGeneration(workspaceId: string): number {
    return workspaceGenerations[workspaceId] ?? 0;
  }

  function nextWorkspaceGeneration(workspaceId: string): number {
    const next = workspaceGeneration(workspaceId) + 1;
    workspaceGenerations = {
      ...workspaceGenerations,
      [workspaceId]: next,
    };
    return next;
  }

  function nextSessionIntent(workspaceId: string): number {
    const next = (sessionIntentByWorkspace[workspaceId] ?? 0) + 1;
    sessionIntentByWorkspace = {
      ...sessionIntentByWorkspace,
      [workspaceId]: next,
    };
    return next;
  }

  function isLatestSessionIntent(workspaceId: string, intent: number): boolean {
    return sessionIntentByWorkspace[workspaceId] === intent;
  }

  function setActiveSession(workspaceId: string, terminalId: string): void {
    if (workspaceId === '') return;
    activeSessionByWorkspace = {
      ...activeSessionByWorkspace,
      [workspaceId]: terminalId,
    };
  }

  function setTerminalClosing(terminalId: string, closing: boolean): void {
    const next = new Set(closingTerminalIds);
    if (closing) next.add(terminalId);
    else next.delete(terminalId);
    closingTerminalIds = next;
  }

  function isCurrentWorkspace(workspaceId: string, generation: number): boolean {
    return (
      !destroyed &&
      workspaceGeneration(workspaceId) === generation &&
      workspaceId === selectedWorkspaceId &&
      panelState.workspace_id === workspaceId
    );
  }

  async function readSessions(workspaceId: string): Promise<TerminalSessionSummary[]> {
    const result = await bridge.listTerminalSessions(workspaceId);
    return result.filter((session) => session.workspace_id === workspaceId);
  }

  async function createSession(
    workspaceId: string,
    generation: number,
    focusWhenCurrent: boolean,
  ): Promise<void> {
    const intent = nextSessionIntent(workspaceId);
    try {
      const created = snapshotToSummary(
        await bridge.createTerminalSession({ workspace_id: workspaceId, cols: 120, rows: 30 }),
      );
      if (destroyed) return;
      const current = sessionsByWorkspace[workspaceId] ?? [];
      if (!current.some((session) => session.terminal_id === created.terminal_id)) {
        setWorkspaceSessions(workspaceId, [...current, created]);
      }
      if (
        focusWhenCurrent &&
        isLatestSessionIntent(workspaceId, intent) &&
        isCurrentWorkspace(workspaceId, generation)
      ) {
        setActiveSession(workspaceId, created.terminal_id);
      }
      if (
        isLatestSessionIntent(workspaceId, intent) &&
        isCurrentWorkspace(workspaceId, generation)
      ) {
        terminalError = '';
      }
    } catch {
      if (
        isLatestSessionIntent(workspaceId, intent) &&
        isCurrentWorkspace(workspaceId, generation)
      ) {
        terminalError = localized(
          'Terminal could not be started.',
          'Terminal을 시작하지 못했습니다.',
        );
      }
    }
  }

  async function loadSessions(workspaceId: string, generation: number): Promise<void> {
    if (workspaceId === '') return;
    sessionsLoading = true;
    terminalError = '';
    try {
      const listed = await readSessions(workspaceId);
      if (!isCurrentWorkspace(workspaceId, generation)) return;
      setWorkspaceSessions(workspaceId, listed);

      // A terminal is created only on the first visible open for this
      // workspace. Hiding the native surface keeps existing PTYs alive and
      // never causes a new one to appear in the background.
      if (panelState.console_open && !initialOpenHandled.has(workspaceId)) {
        initialOpenHandled.add(workspaceId);
        if (listed.length === 0) await createSession(workspaceId, generation, true);
      }
    } catch {
      if (isCurrentWorkspace(workspaceId, generation))
        terminalError = localized(
          'Terminal sessions could not be loaded.',
          'Terminal session을 불러오지 못했습니다.',
        );
    } finally {
      if (isCurrentWorkspace(workspaceId, generation)) sessionsLoading = false;
    }
  }

  async function refreshPanel(): Promise<void> {
    const requestId = ++panelRequestSerial;
    try {
      const [nextPanelState, listedWorkspaces] = await Promise.all([
        bridge.getPanelState(),
        bridge.listWorkspaces(),
      ]);
      if (destroyed || requestId !== panelRequestSerial) return;
      const nextWorkspaces = listedWorkspaces.workspaces.filter(
        (workspace) => workspace.kind === 'user',
      );
      const nextWorkspaceId =
        nextPanelState.workspace_id !== null &&
        nextWorkspaces.some((workspace) => workspace.workspace_id === nextPanelState.workspace_id)
          ? nextPanelState.workspace_id
          : '';
      const previousWorkspaceId = selectedWorkspaceId;
      const workspaceChanged = nextWorkspaceId !== selectedWorkspaceId;
      const openedNow = nextPanelState.console_open && !previousConsoleOpen;
      workspaces = nextWorkspaces;
      panelState = nextPanelState;
      selectedWorkspaceId = nextWorkspaceId;
      previousConsoleOpen = nextPanelState.console_open;
      errorMessage = '';

      if (workspaceChanged || openedNow) {
        terminalError = '';
        if (workspaceChanged && previousWorkspaceId !== '') {
          nextWorkspaceGeneration(previousWorkspaceId);
        }
        const generation = nextWorkspaceId === '' ? 0 : nextWorkspaceGeneration(nextWorkspaceId);
        if (nextWorkspaceId !== '') await loadSessions(nextWorkspaceId, generation);
        else sessionsLoading = false;
      }
    } catch {
      if (!destroyed && requestId === panelRequestSerial)
        errorMessage = localized(
          'Terminal panel could not be loaded.',
          'Terminal 패널을 불러오지 못했습니다.',
        );
    } finally {
      if (!destroyed && requestId === panelRequestSerial) loading = false;
    }
  }

  async function refreshHistory(): Promise<void> {
    const requestId = ++historyRequestSerial;
    try {
      const nextStatus = await bridge.getStatus();
      if (!destroyed && requestId === historyRequestSerial) status = nextStatus;
    } catch {
      // History is secondary to the terminal surface. Keep the last snapshot
      // when the daemon is briefly unavailable.
    }
  }

  async function revealActiveTab(sessionId: string, consoleMode: ConsoleMode): Promise<void> {
    if (sessionId === '' || consoleMode !== 'terminal') return;
    await tick();
    if (destroyed) return;
    tabStrip
      ?.querySelector<HTMLElement>('.terminal-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function addSession(): Promise<void> {
    if (selectedWorkspaceId === '' || sessionsLoading || creatingSession) return;
    creatingSession = true;
    mode = 'terminal';
    try {
      await createSession(selectedWorkspaceId, workspaceGeneration(selectedWorkspaceId), true);
    } finally {
      if (!destroyed) creatingSession = false;
    }
  }

  async function closeSession(session: TerminalSessionSummary): Promise<void> {
    if (session.terminal_id === '' || closingTerminalIds.has(session.terminal_id)) return;
    const workspaceId = session.workspace_id;
    const generation = workspaceGeneration(workspaceId);
    const intent = nextSessionIntent(workspaceId);
    setTerminalClosing(session.terminal_id, true);
    try {
      await bridge.closeTerminalSession({
        workspace_id: workspaceId,
        terminal_id: session.terminal_id,
      });
      if (destroyed) return;
      const remaining = (sessionsByWorkspace[workspaceId] ?? []).filter(
        (item) => item.terminal_id !== session.terminal_id,
      );
      setWorkspaceSessions(workspaceId, remaining);
      if (
        isLatestSessionIntent(workspaceId, intent) &&
        isCurrentWorkspace(workspaceId, generation) &&
        activeSessionId === session.terminal_id
      ) {
        setActiveSession(workspaceId, remaining[0]?.terminal_id ?? '');
      }
      if (
        isLatestSessionIntent(workspaceId, intent) &&
        isCurrentWorkspace(workspaceId, generation)
      ) {
        terminalError = '';
      }
    } catch {
      try {
        const listed = await readSessions(workspaceId);
        if (!destroyed && isLatestSessionIntent(workspaceId, intent)) {
          setWorkspaceSessions(workspaceId, listed);
        }
      } catch {
        // Keep the session visible when a failed close cannot be re-listed.
      }
      if (isLatestSessionIntent(workspaceId, intent) && isCurrentWorkspace(workspaceId, generation))
        terminalError = localized(
          'Terminal could not be closed.',
          'Terminal을 종료하지 못했습니다.',
        );
    } finally {
      if (!destroyed) setTerminalClosing(session.terminal_id, false);
    }
  }

  function selectSession(sessionId: string): void {
    if (selectedSessions.some((session) => session.terminal_id === sessionId)) {
      setActiveSession(selectedWorkspaceId, sessionId);
      mode = 'terminal';
    }
  }

  onMount(() => {
    void refreshPanel();
    void refreshHistory();
    panelTimer = window.setInterval(() => void refreshPanel(), PANEL_POLL_INTERVAL_MS);
    historyTimer = window.setInterval(() => void refreshHistory(), HISTORY_POLL_INTERVAL_MS);
    return () => {
      destroyed = true;
      panelRequestSerial += 1;
      historyRequestSerial += 1;
      if (panelTimer !== undefined) window.clearInterval(panelTimer);
      if (historyTimer !== undefined) window.clearInterval(historyTimer);
    };
  });
</script>

<main class="native-surface terminal-console" aria-labelledby="terminal-console-title">
  <h1 id="terminal-console-title" class="sr-only">
    {#if selectedWorkspace !== undefined}{selectedWorkspace.display_name}{:else}Terminal{/if}
  </h1>
  <nav
    class="terminal-tabbar"
    aria-label={locale === 'ko' ? '터미널 탭 및 작업기록' : 'Terminal tabs and history'}
  >
    <div class="terminal-tab-scroll" bind:this={tabStrip}>
      {#each selectedSessions as session, index (session.terminal_id)}
        <div
          class="terminal-tab"
          class:active={mode === 'terminal' && session.terminal_id === activeSessionId}
          class:closing={closingTerminalIds.has(session.terminal_id)}
        >
          <button
            type="button"
            class="terminal-tab-select"
            title={`${sessionLabel(session, index)} — ${selectedWorkspace?.root_path ?? ''}`}
            aria-current={mode === 'terminal' && session.terminal_id === activeSessionId
              ? 'page'
              : undefined}
            disabled={closingTerminalIds.has(session.terminal_id)}
            onclick={() => selectSession(session.terminal_id)}
          >
            <svg class="terminal-tab-glyph" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m4 5 5 5-5 5m8 0h5" />
            </svg>
            <span class="terminal-tab-label">{sessionLabel(session, index)}</span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            aria-label={`${locale === 'ko' ? '닫기' : 'Close'} ${sessionLabel(session, index)}`}
            title={locale === 'ko' ? '프로세스 종료 및 탭 닫기' : 'Stop process and close tab'}
            disabled={closingTerminalIds.has(session.terminal_id)}
            onclick={(event) => {
              event.stopPropagation();
              void closeSession(session);
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
    <button
      type="button"
      class="terminal-tab-add"
      aria-label={locale === 'ko' ? '새 터미널 탭' : 'New terminal tab'}
      title={locale === 'ko' ? '새 터미널 탭' : 'New terminal tab'}
      aria-busy={creatingSession}
      onclick={() => void addSession()}
      disabled={selectedWorkspaceId === '' || sessionsLoading || creatingSession}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v12M4 10h12" />
      </svg>
    </button>
    <button
      type="button"
      class="terminal-history-toggle"
      class:active={mode === 'history'}
      aria-pressed={mode === 'history'}
      onclick={() => (mode = mode === 'history' ? 'terminal' : 'history')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" />
        <path d="M10 6v4l3 2" />
      </svg>
      <span>{locale === 'ko' ? '작업기록' : 'History'}</span>
    </button>
    <button
      type="button"
      class="terminal-history-toggle"
      class:active={mode === 'goals'}
      aria-pressed={mode === 'goals'}
      onclick={() => (mode = mode === 'goals' ? 'terminal' : 'goals')}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 17V3m0 1h10l-2 4 2 4H5" /></svg>
      <span>Goal</span>
    </button>
  </nav>

  {#if mode === 'goals'}
    {#if selectedWorkspaceId === ''}
      <p class="terminal-empty">
        {locale === 'ko' ? '선택된 Project가 없습니다.' : 'No project is selected.'}
      </p>
    {:else}
      {#key selectedWorkspaceId}<GoalPane workspaceId={selectedWorkspaceId} {locale} />{/key}
    {/if}
  {:else if mode === 'terminal'}
    {#if loading}
      <p class="terminal-empty" role="status">
        {locale === 'ko' ? 'Terminal을 준비하는 중…' : 'Preparing Terminal…'}
      </p>
    {:else if errorMessage !== ''}
      <p class="terminal-error" role="alert">{errorMessage}</p>
    {:else if selectedWorkspace === undefined}
      <p class="terminal-empty">
        {locale === 'ko' ? '선택된 Project가 없습니다.' : 'No project is selected.'}
      </p>
    {:else if sessionsLoading && selectedSessions.length === 0}
      <p class="terminal-empty" role="status">
        {locale === 'ko' ? 'Terminal session을 여는 중…' : 'Opening a terminal session…'}
      </p>
    {:else if selectedSessions.length === 0}
      <p class="terminal-empty">
        {locale === 'ko' ? ' + 로 Terminal 탭을 열 수 있습니다.' : 'Use + to open a terminal tab.'}
      </p>
    {:else}
      <section
        class="terminal-stage"
        aria-label={locale === 'ko' ? 'Terminal 내용' : 'Terminal content'}
      >
        {#each selectedSessions as session (session.terminal_id)}
          {#if !closingTerminalIds.has(session.terminal_id)}
            <TerminalPane
              {bridge}
              workspaceId={selectedWorkspaceId}
              {session}
              {locale}
              active={panelState.console_open && session.terminal_id === activeSessionId}
            />
          {/if}
        {/each}
        {#if terminalError !== ''}
          <p class="terminal-stage-error" role="alert">{terminalError}</p>
        {/if}
      </section>
    {/if}
  {:else}
    <nav class="history-tabs" aria-label={text('consoleTabs')}>
      <button
        type="button"
        class:active={historyTab === 'executions'}
        aria-current={historyTab === 'executions' ? 'page' : undefined}
        onclick={() => (historyTab = 'executions')}
      >
        {text('consoleExecutions')}
        <span>{jobs.length}</span>
      </button>
      <button
        type="button"
        class:active={historyTab === 'activity'}
        aria-current={historyTab === 'activity' ? 'page' : undefined}
        onclick={() => (historyTab = 'activity')}
      >
        {text('consoleActivityTab')}
        <span>{activities.length}</span>
      </button>
    </nav>
    <section
      class="history-stage"
      aria-label={historyTab === 'executions'
        ? text('consoleExecutions')
        : text('consoleActivityTab')}
    >
      {#if selectedWorkspaceId === ''}
        <p class="terminal-empty">
          {locale === 'ko' ? '선택된 Project가 없습니다.' : 'No project is selected.'}
        </p>
      {:else if historyTab === 'executions'}
        <ExecutionJobs workspaceId={selectedWorkspaceId} {locale} {jobs} compact={true} />
      {:else if activities.length === 0}
        <p class="terminal-empty">{text('consoleNoActivity')}</p>
      {:else}
        <div class="activity-console" aria-live="polite">
          <div class="activity-console-list" role="list" aria-label={text('consoleActivityTab')}>
            {#each activities as activity (activity.activity_id)}
              <article class="activity-console-item {activity.state}" role="listitem">
                <div class="activity-console-icon" aria-hidden="true">
                  {#if activity.state === 'succeeded'}✓{:else if activity.state === 'failed'}!{:else}…{/if}
                </div>
                <div class="activity-console-copy">
                  <div class="activity-console-title">
                    <strong>{activity.tool}</strong>
                    <span class="activity-console-kind">{activityKindLabel(activity)}</span>
                    <span class="activity-console-state {activity.state}">
                      {activityStateLabel(activity)}
                    </span>
                  </div>
                  <p>{activity.summary}</p>
                  <div class="activity-console-meta">
                    <time datetime={activityTimestamp(activity)}
                      >{formatActivityTime(activityTimestamp(activity))}</time
                    >
                    <span>{activitySourceLabel(activity)}</span>
                  </div>
                  <div class="activity-console-paths">
                    {#each activity.paths as path}
                      <code title={path}>{path}</code>
                    {/each}
                  </div>
                </div>
              </article>
            {/each}
          </div>
        </div>
      {/if}
    </section>
  {/if}
</main>

<style>
  .terminal-console {
    min-width: 0;
    min-height: 0;
    background: var(--color-surface, #fff);
    color: var(--color-text, #111827);
  }

  .terminal-tabbar {
    display: flex;
    min-width: 0;
    min-height: 40px;
    flex: 0 0 40px;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    background: var(--color-surface-muted, #f6f6f6);
    padding: 5px 8px;
  }

  .terminal-tabbar svg {
    display: block;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .terminal-tab-scroll {
    display: flex;
    min-width: 0;
    height: 100%;
    flex: 0 1 auto;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .terminal-tab-scroll::-webkit-scrollbar {
    display: none;
  }

  .terminal-tab {
    display: flex;
    min-width: 88px;
    max-width: min(220px, 40vw);
    height: 28px;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    padding-right: 3px;
  }

  .terminal-tab:hover {
    background: var(--color-hover, #ececec);
  }

  .terminal-tab.active {
    border-color: var(--color-border-strong, #d5d5d5);
    background: var(--color-surface, #fff);
  }

  .terminal-tab.closing {
    opacity: 0.55;
  }

  .terminal-tab-select,
  .terminal-tab-close,
  .terminal-tab-add,
  .terminal-history-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-muted, #6b7280);
    cursor: pointer;
  }

  .terminal-tab-select {
    min-width: 0;
    height: 100%;
    flex: 1 1 auto;
    justify-content: flex-start;
    gap: 7px;
    padding: 0 6px 0 8px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
  }

  .terminal-tab-glyph {
    color: var(--color-text-subtle, #9ca3af);
  }

  .terminal-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-tab-close {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    padding: 0;
    opacity: 0.7;
  }

  .terminal-tab-close svg {
    width: 12px;
    height: 12px;
  }

  .terminal-tab-add {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    padding: 0;
  }

  .terminal-history-toggle {
    height: 28px;
    flex: 0 0 auto;
    gap: 6px;
    margin-left: auto;
    padding: 0 8px;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
  }

  .terminal-tab-close:hover,
  .terminal-tab-add:hover:not(:disabled),
  .terminal-history-toggle:hover,
  .terminal-history-toggle.active {
    background: var(--color-hover, #ececec);
    color: var(--color-text, #111827);
  }

  .terminal-tab.active .terminal-tab-select,
  .terminal-tab.active .terminal-tab-glyph,
  .terminal-tab-select:hover {
    color: var(--color-text, #111827);
  }

  .terminal-tab.active .terminal-tab-close,
  .terminal-tab:hover .terminal-tab-close,
  .terminal-tab:focus-within .terminal-tab-close {
    opacity: 1;
  }

  .terminal-tab-select:focus-visible,
  .terminal-tab-close:focus-visible,
  .terminal-tab-add:focus-visible,
  .terminal-history-toggle:focus-visible {
    outline: 2px solid var(--color-focus, #2563eb);
    outline-offset: -2px;
  }

  .terminal-tab-select:disabled,
  .terminal-tab-close:disabled {
    cursor: wait;
    opacity: 0.7;
  }

  .terminal-tab-add:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .terminal-stage {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-terminal-stage);
  }

  .history-stage {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
    padding: 8px 10px;
  }

  .history-tabs {
    display: flex;
    min-height: 32px;
    flex: 0 0 32px;
    gap: 2px;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    background: var(--color-surface-muted, #f6f6f6);
    padding: 0 8px;
  }

  .history-tabs button {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    gap: 5px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    padding: 0 7px;
    color: var(--color-text-muted, #6b7280);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
  }

  .history-tabs button:hover,
  .history-tabs button.active {
    border-bottom-color: var(--color-focus, #2563eb);
    color: var(--color-text, #111827);
  }

  .history-tabs button span {
    min-width: 18px;
    border-radius: 999px;
    background: var(--color-bg, #fff);
    padding: 2px 5px;
    text-align: center;
    font-size: 10px;
  }

  .activity-console {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow: auto;
  }

  .history-stage :global(.execution-jobs) {
    width: 100%;
  }

  .terminal-empty,
  .terminal-error {
    display: grid;
    min-height: 0;
    flex: 1;
    margin: 0;
    place-items: center;
    padding: 20px;
    color: var(--color-text-muted, #6b7280);
    font-size: 12px;
    text-align: center;
  }

  .terminal-error {
    color: var(--color-error-fg, #b91c1c);
  }

  .terminal-stage-error {
    flex: 0 0 auto;
    margin: 0 10px 8px;
    border: 1px solid var(--color-border);
    border-radius: 5px;
    background: var(--color-error-bg);
    padding: 4px 8px;
    color: var(--color-error-fg);
    font-size: 11px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  @media (max-width: 560px) {
    .terminal-tabbar {
      gap: 6px;
    }

    .terminal-tab {
      max-width: 180px;
    }

    .terminal-history-toggle {
      gap: 4px;
      padding: 0 6px;
      font-size: 11px;
    }
  }
</style>
