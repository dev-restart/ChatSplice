<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { GoalOwnerUpdateInputSchema } from '@chatsplice/protocol';
  import type {
    GoalCriterion,
    GoalCriterionDefinition,
    GoalOwnerUpdateInput,
    GoalRecord,
    GoalState,
  } from '@chatsplice/protocol';

  import {
    GOAL_CHAT_REQUEST_MAX_LENGTH,
    goalChatRequest,
    goalContinueRequest,
  } from './goal-chat-request.js';
  import type { UiLocale } from './i18n.js';

  export let workspaceId: string;
  export let locale: UiLocale;

  const bridge = window.chatsplice;
  const CHECK_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'build'];
  let goals: GoalRecord[] = [];
  let selectedId = '';
  let selected: GoalRecord | undefined;
  let pageOffset = 0;
  let previousOffsets: number[] = [];
  let nextOffset: number | null = null;
  let totalGoals = 0;
  let cleanupConfirmation = false;
  let deleteConfirmation = false;
  let resetTarget: { goalId: string; revision: number } | null = null;
  let loading = true;
  let busy = false;
  let error = '';
  let notice = '';
  let creating = false;
  let requestDescription = '';
  let createRequest = '';
  let continuationRequest = '';
  let continuing = false;
  let copying = false;
  let copySerial = 0;
  let copyMessage = '';
  let copyFailed = false;
  let createRequestField: HTMLTextAreaElement | undefined;
  let continueRequestField: HTMLTextAreaElement | undefined;
  let objective = '';
  let scope = '';
  let paths = '';
  let nextStep = '';
  let criteria: GoalCriterionDefinition[] = [];
  let criterionKind: 'file' | 'check' | 'browser' = 'file';
  let filePath = '';
  let checkScript = '';
  let scripts: string[] = [];
  let scriptMessage = '';
  let browserSelector = '';
  let browserText = '';
  let summary = '';
  let checkpointNextStep = '';
  let checkpointRevision = 0;
  let checkpointDirty = false;
  let checkpointConflict = false;
  let resumeBudget = 0;
  let resumeBudgetDirty = false;
  let lastWorkspaceId = '';
  let requestSerial = 0;
  let inFlight = false;
  let destroyed = false;
  let timer: number | undefined;

  $: selected = goals.find((goal) => goal.goal_id === selectedId);
  $: createRequest = goalChatRequest(workspaceId, requestDescription, locale);
  $: continuationRequest =
    selected === undefined ? '' : goalContinueRequest(workspaceId, selected, locale);
  $: checkpointConflict =
    selected !== undefined && checkpointDirty && selected.revision !== checkpointRevision;
  $: if (workspaceId !== lastWorkspaceId) {
    lastWorkspaceId = workspaceId;
    requestSerial += 1;
    goals = [];
    selectedId = '';
    pageOffset = 0;
    previousOffsets = [];
    nextOffset = null;
    totalGoals = 0;
    cleanupConfirmation = false;
    deleteConfirmation = false;
    resetTarget = null;
    error = '';
    notice = '';
    creating = false;
    requestDescription = '';
    continuing = false;
    clearCopyMessage();
    objective = '';
    scope = '';
    paths = '';
    nextStep = '';
    criteria = [];
    criterionKind = 'file';
    filePath = '';
    browserSelector = '';
    browserText = '';
    summary = '';
    checkpointNextStep = '';
    checkpointRevision = 0;
    checkpointDirty = false;
    scripts = [];
    checkScript = '';
    loading = true;
    void refresh(true);
    void loadScripts(workspaceId);
  }

  function text(en: string, ko: string): string {
    return locale === 'ko' ? ko : en;
  }

  function stateLabel(state: GoalState): string {
    const labels: Record<GoalState, [string, string]> = {
      active: ['Active', '진행 중'],
      paused: ['Paused', '일시 정지'],
      cancelling: ['Cancelling', '취소 중'],
      cancelled: ['Cancelled', '취소됨'],
      interrupted: ['Interrupted', '중단됨'],
      completed: ['Completed', '완료'],
    };
    return text(...labels[state]);
  }

  function criterionStatus(criterion: GoalCriterion): string {
    if (criterion.status === 'passed') return text('Passed', '통과');
    if (criterion.status === 'failed') return text('Failed', '실패');
    if (criterion.status === 'stale') return text('Recheck needed', '재검증 필요');
    return text('Pending', '검증 대기');
  }

  function describeCriterion(criterion: GoalCriterionDefinition): string {
    if (criterion.kind === 'file') return criterion.path;
    if (criterion.kind === 'check')
      return `${criterion.cwd} · ${criterion.operation.kind === 'node_script' ? criterion.operation.script : `cargo ${criterion.operation.task}`}`;
    const expected = criterion.expectation;
    if (expected.kind === 'url') return expected.url;
    if (expected.kind === 'text') return `${expected.selector} · ${expected.text}`;
    if (expected.kind === 'value') return `${expected.selector} · ${expected.value}`;
    return `${expected.kind} · ${expected.selector}`;
  }

  function loadCheckpointDraft(goal: GoalRecord): void {
    summary = goal.checkpoint?.summary ?? '';
    checkpointNextStep = goal.checkpoint?.next_step ?? '';
    checkpointRevision = goal.revision;
    checkpointDirty = false;
  }

  function selectGoal(goal: GoalRecord, preserveDraft = false): void {
    selectedId = goal.goal_id;
    creating = false;
    continuing = false;
    deleteConfirmation = false;
    resetTarget = null;
    clearCopyMessage();
    if (!preserveDraft) loadCheckpointDraft(goal);
    resumeBudget = goal.max_executions;
    resumeBudgetDirty = false;
    error = '';
    notice = '';
  }

  async function refresh(showLoading = false, navigating = false): Promise<void> {
    if (workspaceId === '' || destroyed || busy || inFlight) return;
    const targetWorkspace = workspaceId;
    const revision = requestSerial;
    inFlight = true;
    if (showLoading) loading = true;
    try {
      let result = await bridge.listGoals({
        workspace_id: targetWorkspace,
        offset: pageOffset,
        limit: 32,
      });
      if (destroyed || targetWorkspace !== workspaceId || revision !== requestSerial) return;
      if (pageOffset > 0 && result.goals.length === 0) {
        pageOffset = 0;
        previousOffsets = [];
        result = await bridge.listGoals({ workspace_id: targetWorkspace, offset: 0, limit: 32 });
        if (destroyed || targetWorkspace !== workspaceId || revision !== requestSerial) return;
      }
      const page = result.goals
        .filter((goal) => goal.workspace_id === targetWorkspace)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      // A concurrent update can move the selected Goal to a different page.
      // Keep its latest revision and draft without polling the entire history.
      if (!navigating && selectedId !== '' && !page.some((goal) => goal.goal_id === selectedId)) {
        const current = await readGoal(targetWorkspace, selectedId);
        if (destroyed || targetWorkspace !== workspaceId || revision !== requestSerial) return;
        if (current !== undefined) page.unshift(current);
      }
      goals = page;
      totalGoals = result.total ?? page.length;
      nextOffset = result.has_more === true ? (result.next_offset ?? null) : null;
      if (
        (navigating || selectedId === '' || !goals.some((goal) => goal.goal_id === selectedId)) &&
        goals[0] !== undefined &&
        !creating
      ) {
        const message = notice;
        const failure = error;
        selectGoal(goals[0]);
        notice = message;
        error = failure;
      }
      const current = goals.find((goal) => goal.goal_id === selectedId);
      if (current !== undefined && !checkpointDirty) loadCheckpointDraft(current);
      if (current !== undefined && !resumeBudgetDirty) resumeBudget = current.max_executions;
    } catch (cause) {
      if (!destroyed && targetWorkspace === workspaceId && revision === requestSerial)
        error = errorMessage(cause);
    } finally {
      inFlight = false;
      if (!destroyed && targetWorkspace === workspaceId && revision === requestSerial)
        loading = false;
      else if (!destroyed) void refresh(true);
    }
  }

  async function readGoal(
    targetWorkspace: string,
    goalId: string,
  ): Promise<GoalRecord | undefined> {
    try {
      const result = await bridge.listGoals({ workspace_id: targetWorkspace, goal_id: goalId });
      return result.goals.find(
        (goal) => goal.workspace_id === targetWorkspace && goal.goal_id === goalId,
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message.includes('Goal does not exist in the selected workspace.')
      )
        return undefined;
      throw cause;
    }
  }

  async function changePage(direction: 'next' | 'previous'): Promise<void> {
    if (busy || inFlight || checkpointDirty) return;
    if (direction === 'next') {
      if (nextOffset === null || nextOffset <= pageOffset) return;
      previousOffsets = [...previousOffsets, pageOffset];
      pageOffset = nextOffset;
    } else {
      const previous = previousOffsets.at(-1);
      if (previous === undefined) return;
      previousOffsets = previousOffsets.slice(0, -1);
      pageOffset = previous;
    }
    selectedId = '';
    cleanupConfirmation = false;
    deleteConfirmation = false;
    resetTarget = null;
    await refresh(true, true);
  }

  function isFinished(goal: GoalRecord): boolean {
    return goal.state === 'completed' || goal.state === 'cancelled';
  }

  function canReset(goal: GoalRecord): boolean {
    return (
      goal.root_matches &&
      goal.state !== 'cancelling' &&
      !goal.receipts.some((receipt) => receipt.state === 'queued' || receipt.state === 'running')
    );
  }

  async function resetHistory(): Promise<void> {
    if (busy || selected === undefined || resetTarget === null || !canReset(selected)) return;
    if (resetTarget.goalId !== selected.goal_id || resetTarget.revision !== selected.revision) {
      error = text(
        'This Goal changed. Review the latest record and choose Start fresh again.',
        'Goal이 갱신되었습니다. 최신 기록을 확인한 뒤 다시 점검을 선택하세요.',
      );
      resetTarget = null;
      return;
    }
    await update({
      workspace_id: workspaceId,
      goal_id: resetTarget.goalId,
      expected_revision: resetTarget.revision,
      action: 'reset',
    });
  }

  async function clearFinished(): Promise<void> {
    if (busy || destroyed || !cleanupConfirmation) return;
    const targetWorkspace = workspaceId;
    const revision = ++requestSerial;
    const isCurrent = () =>
      !destroyed && targetWorkspace === workspaceId && revision === requestSerial;
    busy = true;
    cleanupConfirmation = false;
    error = '';
    notice = '';
    let deleted = 0;
    let offset = 0;
    try {
      while (isCurrent()) {
        const result = await bridge.listGoals({
          workspace_id: targetWorkspace,
          offset,
          limit: 32,
        });
        if (!isCurrent()) return;
        let removedFromPage = 0;
        for (const candidate of result.goals) {
          if (candidate.workspace_id !== targetWorkspace || !isFinished(candidate)) continue;
          const goal = await readGoal(targetWorkspace, candidate.goal_id);
          if (!isCurrent()) return;
          if (goal === undefined) {
            removedFromPage += 1;
            continue;
          }
          if (!isFinished(goal)) continue;
          const removed = await bridge.updateGoal({
            workspace_id: targetWorkspace,
            goal_id: goal.goal_id,
            expected_revision: goal.revision,
            action: 'delete',
          });
          if (!isCurrent()) return;
          if (removed.deleted !== true)
            throw new Error(
              text('Goal deletion was not confirmed.', 'Goal 기록 삭제가 확인되지 않았습니다.'),
            );
          deleted += 1;
          removedFromPage += 1;
          goals = goals.filter((item) => item.goal_id !== goal.goal_id);
          if (selectedId === goal.goal_id) selectedId = '';
          notice = text(
            `Cleared ${deleted} finished Goal records.`,
            `완료·취소 기록 ${deleted}개를 정리했습니다.`,
          );
        }
        if (result.has_more !== true) break;
        const next = result.next_offset;
        if (next === undefined || next === null || next <= offset)
          throw new Error(
            text(
              'Goal pagination did not advance. Refresh and try again.',
              'Goal 목록의 다음 페이지를 확인하지 못했습니다. 새로고침 후 다시 시도하세요.',
            ),
          );
        // Deleting records shifts later offsets; retain active records in the scan.
        offset = Math.max(offset, next - removedFromPage);
      }
      if (isCurrent())
        notice = text(
          `Cleared ${deleted} finished Goal records.`,
          `완료·취소 기록 ${deleted}개를 정리했습니다.`,
        );
    } catch (cause) {
      if (isCurrent()) error = errorMessage(cause);
    } finally {
      busy = false;
      if (isCurrent()) {
        pageOffset = 0;
        previousOffsets = [];
        void refresh(true);
      } else if (!destroyed) void refresh(true);
    }
  }

  function errorMessage(cause: unknown): string {
    return cause instanceof Error
      ? cause.message
      : text('Goal request failed.', 'Goal 요청이 실패했습니다.');
  }

  function clearCopyMessage(): void {
    copySerial += 1;
    copying = false;
    copyMessage = '';
    copyFailed = false;
  }

  async function copyRequest(kind: 'create' | 'continue'): Promise<void> {
    const content = kind === 'create' ? createRequest : continuationRequest;
    if (content === '' || copying || destroyed) return;
    const serial = ++copySerial;
    const targetWorkspace = workspaceId;
    const targetGoal = selectedId;
    const targetLocale = locale;
    copying = true;
    copyMessage = '';
    copyFailed = false;
    const isCurrent = () =>
      !destroyed &&
      serial === copySerial &&
      targetWorkspace === workspaceId &&
      targetGoal === selectedId &&
      targetLocale === locale &&
      content === (kind === 'create' ? createRequest : continuationRequest);
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('Clipboard unavailable.');
      await navigator.clipboard.writeText(content);
      if (isCurrent())
        copyMessage = text(
          'Request copied. Paste and send it in this project’s ChatGPT conversation.',
          '요청을 복사했습니다. 이 프로젝트의 ChatGPT 대화에 붙여넣고 보내세요.',
        );
    } catch {
      if (isCurrent()) {
        copyFailed = true;
        copyMessage = text(
          'Copy was unavailable. Select the request below and copy it manually.',
          '복사하지 못했습니다. 아래 요청문을 선택해 직접 복사하세요.',
        );
      }
    } finally {
      if (!destroyed && serial === copySerial) copying = false;
    }
  }

  function selectRequest(field: HTMLTextAreaElement | undefined): void {
    field?.focus();
    field?.select();
  }

  function useExample(value: string): void {
    requestDescription = value;
    clearCopyMessage();
  }

  async function loadScripts(targetWorkspace: string): Promise<void> {
    if (targetWorkspace === '') return;
    scriptMessage = '';
    try {
      const file = await bridge.readWorkspaceFile({
        workspace_id: targetWorkspace,
        path: 'package.json',
        max_bytes: 51_200,
      });
      if (destroyed || targetWorkspace !== workspaceId) return;
      if (file.truncated)
        throw new Error(
          text(
            'package.json is too large to select checks.',
            'package.json이 커서 검사 목록을 읽을 수 없습니다.',
          ),
        );
      const manifest: unknown = JSON.parse(file.content);
      const declared =
        typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
          ? manifest.scripts
          : undefined;
      scripts = CHECK_SCRIPTS.filter(
        (script) =>
          typeof declared === 'object' &&
          declared !== null &&
          script in declared &&
          typeof (declared as Record<string, unknown>)[script] === 'string',
      );
      checkScript = scripts[0] ?? '';
      if (scripts.length === 0)
        scriptMessage = text(
          'No test/lint/typecheck/check/build script is declared at the project root.',
          '프로젝트 root에 test/lint/typecheck/check/build script가 없습니다.',
        );
    } catch {
      if (!destroyed && targetWorkspace === workspaceId)
        scriptMessage = text(
          'Root package.json checks could not be read. File and browser criteria remain available.',
          'Root package.json의 검사 목록을 읽지 못했습니다. 파일·브라우저 기준을 사용할 수 있습니다.',
        );
    }
  }

  function addCriterion(): void {
    error = '';
    if (criteria.length >= 16) return;
    const criterion_id = `criterion_${crypto.randomUUID().replaceAll('-', '')}`;
    let criterion: GoalCriterionDefinition;
    if (criterionKind === 'file') {
      criterion = {
        kind: 'file',
        criterion_id,
        description: text('Verify current file', '현재 파일 확인'),
        required: true,
        path: filePath.trim(),
      };
    } else if (criterionKind === 'check') {
      criterion = {
        kind: 'check',
        criterion_id,
        description: `${checkScript} ${text('passes', '통과')}`,
        required: true,
        cwd: '.',
        operation: { kind: 'node_script', script: checkScript },
      };
    } else {
      criterion = {
        kind: 'browser',
        criterion_id,
        description: text('Expected page text is visible', '페이지에서 기대한 문구 확인'),
        required: true,
        expectation: { kind: 'text', selector: browserSelector.trim(), text: browserText },
      };
    }
    // Validate the real create shape before retaining a criterion in the form.
    const validated = GoalOwnerUpdateInputSchema.safeParse({
      workspace_id: workspaceId,
      action: 'create',
      objective: 'criterion validation',
      tracked_paths: ['package.json'],
      criteria: [criterion],
    });
    if (!validated.success) {
      error = text(
        'Enter a valid relative file path, declared check, or browser selector.',
        '올바른 상대 파일 경로, 등록된 검사 또는 브라우저 selector를 입력하세요.',
      );
      return;
    }
    criteria = [...criteria, criterion];
    filePath = '';
    browserSelector = '';
    browserText = '';
  }

  async function update(input: GoalOwnerUpdateInput): Promise<void> {
    if (busy || destroyed) return;
    const targetWorkspace = workspaceId;
    const revision = ++requestSerial;
    busy = true;
    error = '';
    notice = '';
    try {
      const result = await bridge.updateGoal(input);
      if (destroyed || targetWorkspace !== workspaceId || revision !== requestSerial) return;
      if (result.deleted === true) {
        goals = goals.filter((goal) => goal.goal_id !== result.goal.goal_id);
        if (selectedId === result.goal.goal_id) selectedId = '';
        deleteConfirmation = false;
        resetTarget = null;
        pageOffset = 0;
        previousOffsets = [];
        totalGoals = Math.max(0, totalGoals - 1);
        notice = text('Finished Goal record deleted.', '종료된 Goal 기록을 삭제했습니다.');
        return;
      }
      pageOffset = 0;
      previousOffsets = [];
      goals = [result.goal, ...goals.filter((goal) => goal.goal_id !== result.goal.goal_id)];
      const preserveDraft =
        result.goal.goal_id === selectedId &&
        checkpointDirty &&
        input.action !== 'checkpoint' &&
        input.action !== 'reset';
      selectGoal(result.goal, preserveDraft);
      if (input.action === 'create') {
        requestDescription = '';
        objective = '';
        scope = '';
        paths = '';
        nextStep = '';
        criteria = [];
        criterionKind = 'file';
        filePath = '';
        checkScript = scripts[0] ?? '';
        browserSelector = '';
        browserText = '';
      }
      notice =
        input.action === 'create'
          ? text('Goal saved.', 'Goal을 저장했습니다.')
          : input.action === 'reset'
            ? text(
                'Verification history cleared. Continue in ChatGPT to recheck this Goal from the current files.',
                '검증 기록을 비웠습니다. ChatGPT에서 이어하기로 현재 파일부터 다시 점검하세요.',
              )
            : text('Goal updated.', 'Goal을 갱신했습니다.');
    } catch (cause) {
      if (!destroyed && targetWorkspace === workspaceId && revision === requestSerial)
        error = errorMessage(cause);
    } finally {
      busy = false;
      if (!destroyed) void refresh();
    }
  }

  async function createGoal(): Promise<void> {
    const tracked = [
      ...new Set([
        ...paths
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
        ...criteria
          .filter((criterion) => criterion.kind === 'file')
          .map((criterion) => criterion.path),
      ]),
    ];
    const result = GoalOwnerUpdateInputSchema.safeParse({
      workspace_id: workspaceId,
      action: 'create',
      objective: objective.trim(),
      scope: scope.trim(),
      tracked_paths: tracked,
      criteria,
      next_step: nextStep.trim(),
      max_executions: 0,
      deadline_ms: 3_600_000,
    });
    if (!result.success) {
      error = text(
        'Enter an objective, 1–32 tracked file paths, and at least one required criterion.',
        '목표, 추적할 파일 경로 1–32개, 필수 합격 기준을 하나 이상 입력하세요.',
      );
      return;
    }
    await update(result.data);
  }

  async function action(
    actionName: 'pause' | 'resume' | 'cancel' | 'complete' | 'checkpoint' | 'delete',
  ): Promise<void> {
    if (selected === undefined || (actionName === 'checkpoint' && checkpointConflict)) return;
    const base = {
      workspace_id: workspaceId,
      goal_id: selected.goal_id,
      expected_revision: actionName === 'checkpoint' ? checkpointRevision : selected.revision,
    };
    if (actionName === 'checkpoint')
      await update({ ...base, action: actionName, summary, next_step: checkpointNextStep });
    else if (actionName === 'resume')
      await update({
        ...base,
        action: actionName,
        deadline_ms: 3_600_000,
        max_executions: resumeBudget,
      });
    else await update({ ...base, action: actionName });
  }

  async function verify(criterion: GoalCriterion): Promise<void> {
    if (selected === undefined || busy) return;
    if (criterion.kind === 'file') {
      await update({
        workspace_id: workspaceId,
        goal_id: selected.goal_id,
        expected_revision: selected.revision,
        action: 'verify_file',
        criterion_id: criterion.criterion_id,
      });
      return;
    }
    const targetWorkspace = workspaceId;
    const goalId = selected.goal_id;
    busy = true;
    error = '';
    notice = '';
    try {
      await bridge.submitProjectExec({
        workspace_id: targetWorkspace,
        goal_id: goalId,
        criterion_id: criterion.criterion_id,
        request_id: `goal_${crypto.randomUUID()}`,
        cwd: criterion.kind === 'check' ? criterion.cwd : '.',
        operation:
          criterion.kind === 'check'
            ? criterion.operation
            : { kind: 'browser', action: { kind: 'assert', expectation: criterion.expectation } },
        timeout_ms: 600_000,
      });
      if (!destroyed && targetWorkspace === workspaceId && goalId === selectedId)
        notice = text(
          'Verification queued. Results appear after execution finishes.',
          '검사를 대기열에 넣었습니다. 실행 종료 후 결과를 확인합니다.',
        );
    } catch (cause) {
      if (!destroyed && targetWorkspace === workspaceId && goalId === selectedId)
        error = errorMessage(cause);
    } finally {
      busy = false;
      if (!destroyed) void refresh();
    }
  }

  onMount(() => {
    timer = window.setInterval(() => void refresh(), 2_000);
  });
  onDestroy(() => {
    destroyed = true;
    requestSerial += 1;
    copySerial += 1;
    if (timer !== undefined) window.clearInterval(timer);
  });
</script>

<section class="goal-pane" aria-label={text('Project Goals', '프로젝트 Goal')}>
  <header>
    <p>
      {text(
        'Describe the work in ChatGPT. Keep its goal, progress and verification here.',
        'ChatGPT에 할 일을 설명하고, 목표·진행 상황·검증 결과를 여기서 확인하세요.',
      )}
    </p>
    <button
      type="button"
      disabled={busy}
      onclick={() => {
        creating = !creating;
        continuing = false;
        clearCopyMessage();
        error = '';
        notice = '';
      }}>{text('New Goal', '새 Goal')}</button
    >
    {#if creating && goals.length > 0}
      <button
        type="button"
        disabled={busy}
        onclick={() => {
          const latest = goals[0];
          if (latest !== undefined) selectGoal(latest);
        }}>{text('View saved Goals', '저장된 Goal 보기')} ({totalGoals})</button
      >
    {/if}
    <button type="button" disabled={busy || loading} onclick={() => void refresh(true)}
      >{text('Refresh', '새로고침')}</button
    >
    {#if totalGoals > 0}<button
        type="button"
        disabled={busy || loading || checkpointDirty}
        onclick={() => {
          cleanupConfirmation = !cleanupConfirmation;
          deleteConfirmation = false;
          resetTarget = null;
        }}>{text('Clear finished records', '완료 기록 정리')}</button
      >{/if}
  </header>
  {#if cleanupConfirmation}
    <section
      class="cleanup-confirmation"
      aria-label={text('Confirm record cleanup', '기록 정리 확인')}
    >
      <p>
        {text(
          'Delete completed and cancelled Goal records for this project? Saved progress and verification history are removed. Active, paused and interrupted Goals and project files are kept.',
          '이 프로젝트의 완료·취소된 Goal 기록을 정리할까요? 저장된 진행 요약과 검증 기록이 삭제됩니다. 진행 중·일시 정지·중단된 Goal과 프로젝트 파일은 유지됩니다.',
        )}
      </p>
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => void clearFinished()}
          >{text('Clear completed and cancelled records', '완료·취소 기록 정리')}</button
        >
        <button type="button" disabled={busy} onclick={() => (cleanupConfirmation = false)}
          >{text('Keep records', '기록 유지')}</button
        >
      </div>
    </section>
  {/if}
  {#if error !== ''}<p class="error" role="alert">{error}</p>{/if}
  {#if notice !== ''}<p class="notice" role="status">{notice}</p>{/if}
  {#if creating || (!loading && goals.length === 0)}
    <section class="goal-start" aria-label={text('Start a Goal in ChatGPT', 'ChatGPT로 Goal 시작')}>
      <div class="start-heading">
        <span class="eyebrow">GOAL</span>
        <h2>{text('Start with what you want to do', '하고 싶은 작업부터 설명하세요')}</h2>
        <p>
          {text(
            'Tell ChatGPT what you want to build or fix. It can inspect this project, register the Goal and work through the checks.',
            '만들거나 고치고 싶은 내용을 ChatGPT에 말하면, 프로젝트를 조사하고 Goal을 등록한 뒤 수정과 검증을 이어갈 수 있습니다.',
          )}
        </p>
      </div>
      <ol class="goal-flow" aria-label={text('Goal workflow', 'Goal 진행 순서')}>
        <li><strong>1</strong><span>{text('Describe the work', '할 일 설명')}</span></li>
        <li>
          <strong>2</strong><span>{text('Inspect and register', '프로젝트 조사·Goal 등록')}</span>
        </li>
        <li>
          <strong>3</strong><span>{text('Implement and verify', '수정·검증·진행 저장')}</span>
        </li>
      </ol>
      {#if goals.length === 0}<p class="empty-goals">
          {text('No saved Goals for this project.', '이 프로젝트에 저장된 Goal이 없습니다.')}
        </p>{/if}
      <label class="request-label">
        <strong>{text('What would you like to work on?', '어떤 작업을 하고 싶나요?')}</strong>
        <textarea
          data-testid="goal-chat-request"
          bind:value={requestDescription}
          oninput={clearCopyMessage}
          maxlength={GOAL_CHAT_REQUEST_MAX_LENGTH}
          rows="3"
          placeholder={text(
            'For example: improve the settings page and verify that changes save correctly.',
            '예: 설정 화면을 쓰기 쉽게 바꾸고, 저장이 제대로 되는지 검증해 줘.',
          )}></textarea>
      </label>
      <div class="request-examples" aria-label={text('Request examples', '요청 예시')}>
        <span>{text('Try:', '예시:')}</span>
        <button
          type="button"
          onclick={() =>
            useExample(
              text(
                'Investigate repeated execution failures, fix their cause and verify the result. Register this as a Goal and continue.',
                '반복되는 실행 실패의 원인을 조사하고 수정한 뒤 검증해 줘. Goal로 등록하고 이어서 진행해 줘.',
              ),
            )}>{text('Fix repeated failures', '반복 오류 해결')}</button
        >
        <button
          type="button"
          onclick={() =>
            useExample(
              text(
                'Improve the settings page so it is easier to use, and verify that changes save correctly. Register this as a Goal and continue.',
                '설정 화면을 쓰기 쉽게 개선하고 변경 사항이 제대로 저장되는지 검증해 줘. Goal로 등록하고 이어서 진행해 줘.',
              ),
            )}>{text('Improve a screen', '화면 개선')}</button
        >
      </div>
      <p class="request-help">
        {text(
          'You can say this directly in this project’s ChatGPT conversation, or copy the prepared request below. ChatGPT will choose the files and acceptance criteria after inspecting the project.',
          '이 프로젝트의 ChatGPT 대화에 바로 말해도 되고, 아래 요청문을 복사해 보내도 됩니다. 파일 경로와 완료 기준은 ChatGPT가 프로젝트를 조사해 정합니다.',
        )}
      </p>
      <div class="request-actions">
        <button
          class="primary"
          type="button"
          disabled={createRequest === '' || copying}
          onclick={() => void copyRequest('create')}>{text('Copy request', '요청 복사')}</button
        >
        <span
          >{text(
            'Paste and send in ChatGPT to start.',
            'ChatGPT에 붙여넣고 보내면 시작합니다.',
          )}</span
        >
      </div>
      {#if createRequest !== ''}
        <div class="request-preview">
          <label
            >{text('ChatGPT request', 'ChatGPT 요청문')}<textarea
              data-testid="goal-chat-create-preview"
              bind:this={createRequestField}
              value={createRequest}
              readonly
              rows="5"></textarea></label
          >
          <button type="button" onclick={() => selectRequest(createRequestField)}
            >{text('Select request text', '요청문 선택')}</button
          >
        </div>
      {/if}
      {#if copyMessage !== ''}<p class="copy-message" class:copy-failed={copyFailed} role="status">
          {copyMessage}
        </p>{/if}
      <p class="request-boundary">
        {text(
          'Copying prepares text only. A Goal appears here after ChatGPT registers it through MCP. Work continues during the conversation; a saved Goal does not start another chat by itself.',
          '복사는 요청문을 준비하는 단계입니다. ChatGPT가 MCP로 등록하면 Goal이 여기에 나타납니다. 작업은 대화에서 이어가며, 저장된 Goal이 혼자 새 대화를 시작하지는 않습니다.',
        )}
      </p>
      <details class="goal-help">
        <summary
          >{text(
            'If ChatGPT cannot register a Goal',
            'ChatGPT가 Goal을 등록하지 못한다면',
          )}</summary
        >
        <p>
          {text(
            'Confirm that this project’s MCP is attached and that project.goal and project.goal_update are available. If the tools are missing after an update, start the new ChatSplice runtime and refresh the connection with Scan Tools.',
            '이 프로젝트의 MCP가 첨부되어 있고 project.goal·project.goal_update 도구가 있는지 확인하세요. 업데이트 후 도구가 없다면 새 ChatSplice 실행 버전을 시작하고 Scan Tools로 연결을 새로고침하세요.',
          )}
        </p>
      </details>
    </section>
    <details class="manual-create">
      <summary>{text('Enter details manually (advanced)', '직접 입력 (고급)')}</summary>
      <p>
        {text(
          'Use this form when you already know the files and checks. The Goal is saved here; ask ChatGPT to continue it when you are ready.',
          '파일과 검사를 이미 알고 있다면 직접 등록할 수 있습니다. 저장한 뒤 ChatGPT에 이어서 진행해 달라고 요청하세요.',
        )}
      </p>
      <form
        class="goal-create"
        onsubmit={(event) => {
          event.preventDefault();
          void createGoal();
        }}
      >
        <label
          >{text('Objective', '목표')}<textarea
            bind:value={objective}
            maxlength="2000"
            required
            rows="2"></textarea></label
        >
        <label>{text('Scope', '작업 범위')}<input bind:value={scope} maxlength="2000" /></label>
        <label
          >{text('Tracked file paths, one per line', '추적할 파일 경로, 한 줄에 하나')}<textarea
            bind:value={paths}
            maxlength="16384"
            rows="2"
            placeholder="src/app.ts&#10;package.json"></textarea></label
        >
        <div class="criterion-form">
          <label
            >{text('Acceptance criterion', '합격 기준')}<select
              bind:value={criterionKind}
              aria-label={text('Acceptance criterion', '합격 기준')}
              ><option value="file">{text('Current file', '현재 파일')}</option><option
                value="check">{text('Project check', '프로젝트 검사')}</option
              ><option value="browser">{text('Browser text', '브라우저 문구')}</option></select
            ></label
          >
          {#if criterionKind === 'file'}<label
              >{text('Relative file path', '상대 파일 경로')}<input
                bind:value={filePath}
                maxlength="512"
                placeholder="src/app.ts"
              /></label
            >
          {:else if criterionKind === 'check'}<label
              >{text('Declared root script', 'Root에 등록된 script')}<select
                bind:value={checkScript}
                aria-label={text('Declared root script', 'Root에 등록된 script')}
                disabled={scripts.length === 0}
                >{#each scripts as script}<option value={script}>{script}</option>{/each}</select
              ></label
            >{#if scriptMessage !== ''}<p>{scriptMessage}</p>{/if}
          {:else}<label
              >Selector<input
                bind:value={browserSelector}
                maxlength="1000"
                placeholder="[data-testid=result]"
              /></label
            ><label
              >{text('Expected text', '기대 문구')}<input
                bind:value={browserText}
                maxlength="4000"
              /></label
            >{/if}
          <button type="button" disabled={criteria.length >= 16 || busy} onclick={addCriterion}
            >{text('Add required criterion', '필수 기준 추가')}</button
          >
        </div>
        {#each criteria as criterion (criterion.criterion_id)}<div class="draft-criterion">
            <span>{describeCriterion(criterion)}</span><button
              type="button"
              aria-label={text('Remove criterion', '기준 삭제')}
              onclick={() =>
                (criteria = criteria.filter(
                  (item) => item.criterion_id !== criterion.criterion_id,
                ))}>×</button
            >
          </div>{/each}
        <label
          >{text('Next step', '다음 단계')}<input bind:value={nextStep} maxlength="1000" /></label
        >
        <button type="submit" disabled={busy}>{text('Save Goal', 'Goal 저장')}</button>
      </form>
    </details>
  {:else if loading && goals.length === 0}<p role="status">
      {text('Loading Goals…', 'Goal을 불러오는 중…')}
    </p>
  {:else if goals.length === 0}<p>
      {text('No saved Goals for this project.', '이 프로젝트에 저장된 Goal이 없습니다.')}
    </p>
  {:else}
    <div class="goal-layout">
      <nav class="goal-list" aria-label={text('Saved Goals', '저장된 Goal')}>
        {#each goals as goal (goal.goal_id)}<button
            type="button"
            class:active={goal.goal_id === selectedId}
            aria-current={goal.goal_id === selectedId ? 'page' : undefined}
            onclick={() => selectGoal(goal)}
            ><span>{goal.objective}</span><small>{stateLabel(goal.state)}</small></button
          >{/each}
        <div class="pagination">
          <small>{text(`${totalGoals} saved Goals`, `저장된 Goal ${totalGoals}개`)}</small>
          <div class="actions">
            <button
              type="button"
              disabled={busy || loading || checkpointDirty || previousOffsets.length === 0}
              onclick={() => void changePage('previous')}
              >{text('Previous page', '이전 페이지')}</button
            >
            <button
              type="button"
              disabled={busy || loading || checkpointDirty || nextOffset === null}
              onclick={() => void changePage('next')}>{text('Next page', '다음 페이지')}</button
            >
          </div>
          {#if checkpointDirty}<small
              >{text(
                'Save or reload the checkpoint before changing pages.',
                '페이지를 바꾸기 전에 체크포인트를 저장하거나 최신 기록을 불러오세요.',
              )}</small
            >{/if}
        </div>
      </nav>
      {#if selected !== undefined}
        <article class="goal-detail">
          <div class="goal-heading">
            <h2>{selected.objective}</h2>
            <span class="state">{stateLabel(selected.state)}</span>
          </div>
          {#if selected.scope !== ''}<p>{selected.scope}</p>{/if}
          <p class="goal-progress" role="status">
            {text(
              `${selected.criteria.filter((criterion) => criterion.status === 'passed').length} of ${selected.criteria.length} criteria passed`,
              `완료 기준 ${selected.criteria.length}개 중 ${selected.criteria.filter((criterion) => criterion.status === 'passed').length}개 통과`,
            )}
          </p>
          {#if continuationRequest !== ''}
            <section
              class="goal-continue"
              aria-label={text('Continue in ChatGPT', 'ChatGPT에서 이어가기')}
            >
              <div class="continue-heading">
                <div>
                  <h3>{text('Continue this Goal', '이 목표로 계속 작업')}</h3>
                  <p>
                    {selected.checkpoint?.next_step ||
                      text(
                        'Continue with the unfinished acceptance criteria.',
                        '아직 통과하지 않은 완료 기준부터 이어가세요.',
                      )}
                  </p>
                </div>
                <button
                  class="primary"
                  type="button"
                  data-testid="goal-chat-continue"
                  onclick={() => {
                    continuing = !continuing;
                    clearCopyMessage();
                  }}>{text('Continue in ChatGPT', 'ChatGPT에서 이어하기')}</button
                >
              </div>
              <p class="request-help">
                {text(
                  'Prepare a request with this Goal and its next step, then send it in ChatGPT. ChatGPT rechecks the latest state before continuing.',
                  '이 Goal과 다음 단계가 담긴 요청문을 준비해 ChatGPT에 보내세요. ChatGPT가 최신 상태를 확인하고 작업을 이어갑니다.',
                )}
              </p>
              {#if continuing}
                <div class="request-preview">
                  <label
                    >{text('Continuation request', '이어하기 요청문')}<textarea
                      data-testid="goal-chat-continue-preview"
                      bind:this={continueRequestField}
                      value={continuationRequest}
                      readonly
                      rows="5"></textarea></label
                  >
                  <div class="request-actions">
                    <button
                      type="button"
                      disabled={copying}
                      onclick={() => void copyRequest('continue')}
                      >{text('Copy continuation request', '이어하기 요청 복사')}</button
                    >
                    <button type="button" onclick={() => selectRequest(continueRequestField)}
                      >{text('Select request text', '요청문 선택')}</button
                    >
                  </div>
                </div>
                {#if copyMessage !== ''}<p
                    class="copy-message"
                    class:copy-failed={copyFailed}
                    role="status"
                  >
                    {copyMessage}
                  </p>{/if}
                <p class="request-boundary">
                  {text(
                    'Copying does not send a message or resume this Goal by itself.',
                    '복사만으로 메시지를 보내거나 Goal을 재개하지 않습니다.',
                  )}
                </p>
              {/if}
            </section>
          {/if}
          {#if !selected.root_matches}<p class="error" role="alert">
              {text(
                'The project root changed. This Goal cannot resume here.',
                '프로젝트 root가 달라져 이 Goal을 재개할 수 없습니다.',
              )}
            </p>{/if}
          {#if selected.message !== ''}<p>{selected.message}</p>{/if}
          <details class="goal-details" data-testid="goal-criteria-details">
            <summary>{text('View acceptance criteria', '완료 기준 자세히 보기')}</summary>
            <ul class="criteria">
              {#each selected.criteria as criterion (criterion.criterion_id)}<li>
                  <div>
                    <strong>{criterion.description}</strong><span
                      class="criterion-status {criterion.status}">{criterionStatus(criterion)}</span
                    ><small>{describeCriterion(criterion)}</small
                    >{#if criterion.evidence !== null}<small
                        >{text('Verified', '검증')}: {new Date(
                          criterion.evidence.verified_at,
                        ).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US')}</small
                      >{/if}
                  </div>
                  <button
                    type="button"
                    disabled={busy || selected.state !== 'active' || !selected.root_matches}
                    onclick={() => void verify(criterion)}>{text('Verify', '검증')}</button
                  >
                </li>{/each}
            </ul>
          </details>
          <div class="actions">
            {#if selected.state === 'active'}<button
                type="button"
                disabled={busy}
                onclick={() => void action('pause')}>{text('Pause', '일시 정지')}</button
              ><button
                type="button"
                disabled={busy || !selected.root_matches}
                onclick={() => void action('complete')}
                >{text('Check completion', '완료 판정')}</button
              >{/if}
            {#if selected.state === 'paused' || selected.state === 'interrupted'}<button
                type="button"
                disabled={busy ||
                  !selected.root_matches ||
                  !Number.isSafeInteger(resumeBudget) ||
                  resumeBudget < 0 ||
                  (resumeBudget !== 0 && resumeBudget <= selected.executions_used)}
                onclick={() => void action('resume')}
                >{text('Resume for 1 hour', '1시간 재개')}</button
              >{/if}
            {#if selected.state !== 'completed' && selected.state !== 'cancelled'}<button
                type="button"
                disabled={busy || selected.state === 'cancelling'}
                onclick={() => void action('cancel')}>{text('Cancel Goal', 'Goal 취소')}</button
              >{/if}
            <button
              type="button"
              data-testid="goal-reset-start"
              disabled={busy || !canReset(selected)}
              onclick={() => {
                resetTarget = { goalId: selected.goal_id, revision: selected.revision };
                deleteConfirmation = false;
                cleanupConfirmation = false;
              }}>{text('Start fresh', '기록 비우고 다시 점검')}</button
            >
            {#if isFinished(selected)}
              <button
                type="button"
                disabled={busy}
                onclick={() => (deleteConfirmation = !deleteConfirmation)}
                >{text('Delete this record', '이 기록 삭제')}</button
              >
            {/if}
          </div>
          {#if resetTarget !== null && resetTarget.goalId === selected.goal_id}
            <section
              class="cleanup-confirmation"
              data-testid="goal-reset-confirmation"
              aria-label={text('Confirm fresh verification', '다시 점검 확인')}
            >
              <p>
                {text(
                  'Clear this Goal’s saved progress, verification results and execution receipts? The objective, acceptance criteria and project files stay. The Goal pauses until you resume it.',
                  '진행 요약·검증 결과·Goal 실행 기록을 비울까요? 목표와 완료 기준, 프로젝트 파일은 유지하고 재개 전까지 일시 정지합니다.',
                )}
              </p>
              <small
                >{text(
                  'Lifetime execution counts and duplicate-request protection are retained. ChatGPT chats and the separate work log are unchanged.',
                  '누적 실행 수와 중복 실행 방지 정보는 유지합니다. ChatGPT 대화와 별도 작업기록은 삭제하지 않습니다.',
                )}</small
              >
              {#if checkpointDirty}<p>
                  {text(
                    'Your unsaved progress draft will also be cleared.',
                    '아직 저장하지 않은 진행 요약 입력도 비웁니다.',
                  )}
                </p>{/if}
              {#if resetTarget.revision !== selected.revision}<p role="status">
                  {text(
                    'The record changed. Close this confirmation and review it again.',
                    '기록이 갱신되었습니다. 닫은 뒤 최신 기록을 확인해 주세요.',
                  )}
                </p>{/if}
              <div class="actions">
                <button
                  type="button"
                  data-testid="goal-reset-confirm"
                  disabled={busy ||
                    !canReset(selected) ||
                    resetTarget.revision !== selected.revision}
                  onclick={() => void resetHistory()}
                  >{text('Clear verification history', '검증 기록 초기화')}</button
                >
                <button type="button" disabled={busy} onclick={() => (resetTarget = null)}
                  >{text('Keep records', '기록 유지')}</button
                >
              </div>
            </section>
          {/if}
          {#if deleteConfirmation && isFinished(selected)}
            <section
              class="cleanup-confirmation"
              aria-label={text('Confirm record deletion', '기록 삭제 확인')}
            >
              <p>
                {text(
                  'Delete this Goal’s saved progress and verification history? Project files are kept.',
                  '이 Goal의 진행 요약과 검증 기록을 삭제할까요? 프로젝트 파일은 유지됩니다.',
                )}
              </p>
              <div class="actions">
                <button type="button" disabled={busy} onclick={() => void action('delete')}
                  >{text('Delete Goal record', 'Goal 기록 삭제')}</button
                >
                <button type="button" disabled={busy} onclick={() => (deleteConfirmation = false)}
                  >{text('Keep record', '기록 유지')}</button
                >
              </div>
            </section>
          {/if}
          <details class="goal-details" data-testid="goal-advanced-details">
            <summary>{text('Execution settings and saved progress', '실행 설정·저장 기록')}</summary
            >
            <p class="meta">
              {selected.max_executions === 0
                ? text(
                    `${selected.executions_used} executions total · No execution limit`,
                    `누적 ${selected.executions_used}회 · 실행 제한 없음`,
                  )
                : text(
                    `${selected.executions_used}/${selected.max_executions} executions`,
                    `${selected.executions_used}/${selected.max_executions}회 실행`,
                  )}
              · {text('Deadline', '기한')}: {new Date(selected.deadline_at).toLocaleString(
                locale === 'ko' ? 'ko-KR' : 'en-US',
              )}
            </p>
            <p class="tracked">
              <span>{text('Tracked files', '추적 파일')}: </span>{selected.tracked_paths.join(', ')}
            </p>

            {#if selected.state === 'paused' || selected.state === 'interrupted'}
              <label class="budget">
                {text('Execution budget', '실행 한도')}
                <input
                  type="number"
                  aria-label={text('Execution budget', '실행 한도')}
                  bind:value={resumeBudget}
                  oninput={() => (resumeBudgetDirty = true)}
                  min="0"
                  step="1"
                />
                <small>{text('0 = no limit', '0 = 제한 없음')}</small>
              </label>
            {/if}
            {#if selected.state !== 'completed' && selected.state !== 'cancelled' && selected.state !== 'cancelling'}
              <form
                class="checkpoint"
                onsubmit={(event) => {
                  event.preventDefault();
                  void action('checkpoint');
                }}
              >
                <label
                  >{text('Progress summary', '진행 요약')}<textarea
                    bind:value={summary}
                    oninput={() => {
                      checkpointDirty = true;
                    }}
                    maxlength="1000"
                    rows="2"></textarea></label
                ><label
                  >{text('Manual next step', '직접 이어갈 다음 단계')}<textarea
                    bind:value={checkpointNextStep}
                    oninput={() => {
                      checkpointDirty = true;
                    }}
                    maxlength="1000"
                    rows="2"></textarea></label
                >{#if checkpointConflict}
                  <div class="checkpoint-conflict" role="status">
                    <p>
                      {text(
                        'This Goal changed while you were editing. Your draft is preserved. Load the latest checkpoint to replace this draft before saving.',
                        '입력하는 동안 Goal이 갱신되었습니다. 내 입력은 유지했습니다. 저장하려면 최신 체크포인트를 불러와 현재 입력을 바꾸세요.',
                      )}
                    </p>
                    <button
                      type="button"
                      onclick={() => {
                        if (selected !== undefined) loadCheckpointDraft(selected);
                      }}>{text('Load latest checkpoint', '최신 체크포인트 불러오기')}</button
                    >
                  </div>
                {/if}
                <button
                  type="submit"
                  disabled={busy ||
                    checkpointConflict ||
                    !selected.root_matches ||
                    (selected.state !== 'active' && selected.state !== 'paused')}
                  >{text('Save checkpoint', 'Checkpoint 저장')}</button
                >
              </form>
            {:else if selected.checkpoint !== null && selected.checkpoint.next_step !== ''}<p>
                {text('Next step', '다음 단계')}: {selected.checkpoint.next_step}
              </p>{/if}
          </details>
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
  .goal-progress {
    margin: 8px 0 12px;
    color: var(--color-text-muted, #6b7280);
  }

  .goal-details {
    margin: 12px 0;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    padding: 10px 12px;
  }

  .goal-details > summary {
    cursor: pointer;
    font-weight: 600;
  }

  .goal-details[open] > summary {
    margin-bottom: 12px;
  }

  .goal-details > summary:focus-visible {
    outline: 2px solid var(--color-focus, #2563eb);
    outline-offset: 3px;
  }

  .goal-pane {
    height: 100%;
    overflow: auto;
    padding: 12px;
    color: var(--color-text, #111827);
    font-size: 12px;
  }
  header,
  .goal-heading,
  .actions,
  .draft-criterion {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  header {
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  header p {
    flex: 1;
    margin: 0;
    min-width: 220px;
    color: var(--color-text-muted, #6b7280);
  }
  button,
  input,
  textarea,
  select {
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 5px;
    background: var(--color-surface, #fff);
    color: inherit;
    font: inherit;
    padding: 5px 8px;
  }
  button {
    cursor: pointer;
    white-space: nowrap;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:hover:not(:disabled) {
    background: var(--color-hover, #f3f4f6);
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  textarea {
    resize: vertical;
    min-height: 45px;
  }
  input,
  textarea,
  select {
    min-width: 0;
  }
  .error {
    color: #b91c1c;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .notice {
    color: #166534;
  }
  .goal-create,
  .checkpoint {
    display: grid;
    gap: 8px;
  }
  .criterion-form {
    display: flex;
    align-items: end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .criterion-form label {
    min-width: 160px;
    flex: 1;
  }
  .criterion-form p {
    width: 100%;
    margin: 0;
  }
  .draft-criterion {
    justify-content: space-between;
    padding: 4px 8px;
    background: var(--color-surface-muted, #f6f6f6);
  }
  .draft-criterion span {
    overflow-wrap: anywhere;
  }
  .goal-layout {
    display: grid;
    grid-template-columns: minmax(140px, 24%) minmax(0, 1fr);
    gap: 16px;
  }
  .goal-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-self: start;
  }
  .goal-list button {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .goal-list button.active {
    border-color: #2563eb;
    background: var(--color-surface-muted, #f6f6f6);
  }
  .goal-detail {
    min-width: 0;
  }
  h2 {
    flex: 1;
    font-size: 14px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .state,
  .meta,
  small {
    color: var(--color-text-muted, #6b7280);
  }
  .meta {
    font-size: 11px;
  }
  .criteria {
    list-style: none;
    padding: 0;
    margin: 8px 0;
  }
  .criteria li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
  }
  .criteria li div {
    flex: 1;
    min-width: 0;
  }
  .criteria small {
    display: block;
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .criterion-status {
    margin-left: 8px;
  }
  .passed {
    color: #166534;
  }
  .failed,
  .stale {
    color: #b91c1c;
  }
  .tracked {
    overflow-wrap: anywhere;
    color: var(--color-text-muted, #6b7280);
  }
  .actions {
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .budget {
    flex-direction: row;
    align-items: center;
  }
  .budget input {
    width: 90px;
  }
  .pagination {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border, #d1d5db);
  }
  .pagination .actions {
    gap: 5px;
  }
  .cleanup-confirmation {
    padding: 10px;
    margin: 10px 0;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 6px;
    line-height: 1.6;
  }
  .cleanup-confirmation p {
    margin: 0;
  }
  .checkpoint {
    margin-top: 12px;
  }
  .goal-start,
  .goal-continue {
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 10px;
    padding: 16px;
    background: var(--color-surface-muted, #f6f6f6);
  }
  .start-heading h2 {
    margin: 5px 0 8px;
    font-size: 17px;
  }
  .start-heading p,
  .request-help,
  .request-boundary,
  .goal-help p,
  .manual-create > p,
  .continue-heading p,
  .checkpoint-conflict p {
    line-height: 1.6;
    margin: 8px 0;
    overflow-wrap: anywhere;
  }
  .eyebrow {
    color: var(--color-text-muted, #6b7280);
    font-size: 10px;
    letter-spacing: 0.1em;
  }
  .goal-flow {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    padding: 12px 0;
    margin: 4px 0 12px;
    list-style: none;
    border-bottom: 1px solid var(--color-border, #d1d5db);
  }
  .goal-flow li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .goal-flow strong {
    display: grid;
    place-items: center;
    flex: 0 0 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #d1d5db);
    font-size: 11px;
  }
  .request-label {
    gap: 8px;
  }
  .request-label textarea,
  .request-preview textarea {
    width: 100%;
    box-sizing: border-box;
    line-height: 1.6;
  }
  .request-examples,
  .request-actions,
  .continue-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .request-examples {
    margin-top: 8px;
  }
  .request-examples button {
    border-radius: 20px;
    padding: 4px 10px;
    white-space: normal;
  }
  .request-help,
  .request-boundary,
  .request-actions span,
  .empty-goals,
  .request-examples > span,
  .goal-help,
  .manual-create > p {
    color: var(--color-text-muted, #6b7280);
  }
  .request-actions {
    margin: 12px 0 8px;
  }
  button.primary {
    color: #fff;
    border-color: #2563eb;
    background: #2563eb;
    padding: 7px 12px;
  }
  button.primary:hover:not(:disabled) {
    background: #1d4ed8;
  }
  .request-preview {
    display: grid;
    gap: 6px;
    margin-top: 12px;
  }
  .request-preview > button {
    justify-self: start;
  }
  .request-boundary {
    font-size: 11px;
  }
  .copy-message {
    color: var(--color-text, #111827);
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .copy-failed,
  .checkpoint-conflict {
    border-left: 3px solid #d97706;
    padding-left: 10px;
  }
  .goal-help {
    margin-top: 12px;
  }
  summary {
    cursor: pointer;
    line-height: 1.6;
  }
  summary:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  .manual-create {
    margin-top: 14px;
    padding: 12px;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 8px;
  }
  .manual-create .goal-create {
    margin-top: 12px;
  }
  .goal-continue {
    margin: 14px 0;
    padding: 12px;
  }
  .continue-heading > div {
    flex: 1;
    min-width: 160px;
  }
  .continue-heading h3 {
    margin: 0;
    font-size: 13px;
  }
  .continue-heading p {
    margin-bottom: 0;
  }
  @media (max-width: 650px) {
    .goal-start {
      padding: 12px;
    }
    .goal-flow {
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .continue-heading > .primary {
      width: 100%;
    }
    .goal-layout {
      grid-template-columns: 1fr;
    }
    .goal-list {
      flex-direction: row;
      overflow-x: auto;
    }
    .goal-list button {
      min-width: 140px;
      max-width: 220px;
    }
  }
</style>
