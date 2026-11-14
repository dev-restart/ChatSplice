import type { GoalRecord } from '@chatsplice/protocol';

import type { UiLocale } from './i18n.js';

export const GOAL_CHAT_REQUEST_MAX_LENGTH = 2_000;

const workspacePattern = /^ws_[a-f0-9]{24}$/u;
const goalPattern = /^goal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

/** Plain text for the owner to send; this helper performs no registration or execution. */
export function goalChatRequest(workspaceId: string, request: string, locale: UiLocale): string {
  const objective = request.trim();
  if (
    workspaceId.length !== 27 ||
    !workspacePattern.test(workspaceId) ||
    objective.length === 0 ||
    objective.length > GOAL_CHAT_REQUEST_MAX_LENGTH
  )
    return '';
  const context = JSON.stringify({ workspace_id: workspaceId, request: objective }, null, 2);
  return (
    locale === 'ko'
      ? [
          '다음 작업을 이 프로젝트의 Goal로 등록하고 구현·검증까지 이어서 수행해 주세요.',
          '작업 요청 데이터:',
          context,
          '',
          '1. 이 대화의 프로젝트 지침에 있는 workspace_id와 binding을 확인하고, project.goal로 기존 Goal을 먼저 조회하고 has_more이면 next_offset으로 다음 페이지도 확인하세요. 동일한 요청이 이미 등록되어 있으면 현재 상태를 확인해 중복 등록을 피하세요.',
          '2. 프로젝트 지침, 관련 소스와 manifest·등록된 검사 script를 필요한 범위에서 조사하세요. 사용자에게 파일 경로나 기술적인 기준 입력을 넘기지 말고, 조사 결과로 작업 범위와 완료 기준을 정하세요.',
          '3. 동일한 미완료 Goal이 없으면 project.goal_update(create)에 목표·범위·구체적인 추적 파일 1–32개·필수 완료 기준·다음 단계를 저장하세요. 이미 있다면 기존 goal_id와 최신 상태에서 이어가세요. 추적 경로에는 디렉터리나 임시 점검용 파일을 넣지 마세요. 실제 기능을 검사할 기준을 고르고, 파일 존재만으로 동작 성공을 판정하지 마세요.',
          '4. 등록 응답의 goal_id를 사용해 허용된 범위의 수정·설치·실행·검증을 계속하세요. project.exec에 goal_id를 연결하고, 완료 기준의 검사에는 criterion_id와 선언된 정확한 Node/Cargo 검사 또는 browser assert를 연결하세요. 실행 중인 요청을 중복 제출하지 말고 종료 결과를 확인하세요.',
          '5. 변경 때마다 최신 Goal과 revision을 확인하세요. verify_file은 파일 근거를 남기고, 기능·화면 변경은 실제 검사로 검증하세요. 실패를 고친 뒤 필요한 검사를 다시 실행하고, 필수 근거가 현재 소스에 유효하며 소유 작업이 끝났을 때 최종 checkpoint를 먼저 저장하고 complete를 요청하세요. 종료된 Goal에는 checkpoint를 다시 쓰지 마세요.',
          '6. 완료하거나 실제 장애가 생길 때까지 현재 대화에서 작업을 이어가세요. 일시 중지하거나 응답을 끝내기 전 active·paused 상태에서 가능한 경우 checkpoint에 진행 요약·막힌 이유·다음 단계를 저장하세요. 기한·실행 한도와 기존 권한을 지키고, 새 ChatGPT 대화를 자동 시작한다고 약속하지 마세요.',
          '필요한 Goal 도구가 현재 연결에 없으면 등록했다고 말하지 말고, 새 런타임과 도구 새로고침이 필요한지 알려주세요.',
        ]
      : [
          'Register this task as a Goal for this project and continue through implementation and verification.',
          'Task request data:',
          context,
          '',
          '1. Check the workspace_id and binding in this conversation’s project instructions, then read existing Goals with project.goal and follow next_offset while has_more is true. If this same request is already registered, inspect its current state and avoid a duplicate.',
          '2. Inspect the project instructions, relevant source, manifests and declared check scripts. Derive scope and acceptance criteria from the project instead of asking me to fill in technical paths or fields.',
          '3. If no unfinished Goal covers this same task, use project.goal_update(create) to save the objective, scope, 1–32 concrete tracked file paths, required acceptance criteria and next step. Otherwise continue with the existing goal_id and latest state. Do not track directories or dummy evidence files. Choose checks of the requested behavior; file existence alone does not prove it works.',
          '4. Use the returned goal_id to continue authorized edits, installation, execution and verification. Link project.exec to goal_id; link acceptance checks to criterion_id and the exact declared Node/Cargo check or browser assert. Await existing running operations rather than submitting them again.',
          '5. Read the latest Goal and revision before updates. verify_file records file evidence; verify behavior and UI with actual checks. Repair failures and rerun necessary checks. When current required evidence is valid and all owned work has finished, save the final checkpoint before requesting complete. Do not checkpoint a terminal Goal.',
          '6. Keep working in this active conversation until completion or a real blocker. Before pausing or ending the response, save progress, blockers and the next step in a checkpoint when the state allows it (active or paused). Respect deadlines, execution limits and existing permissions; do not promise to start a new ChatGPT turn automatically.',
          'If the required Goal tools are absent from this connection, do not claim registration. Explain whether a new runtime and refreshed tool connection are needed.',
        ]
  ).join('\n');
}

type GoalContinuation = Pick<
  GoalRecord,
  'workspace_id' | 'goal_id' | 'state' | 'objective' | 'checkpoint' | 'root_matches'
>;

/** Resume from a freshly read record, never from a copied revision or terminal Goal. */
export function goalContinueRequest(
  workspaceId: string,
  goal: GoalContinuation,
  locale: UiLocale,
): string {
  if (
    workspaceId.length !== 27 ||
    !workspacePattern.test(workspaceId) ||
    goal.workspace_id !== workspaceId ||
    goal.goal_id.length !== 41 ||
    !goalPattern.test(goal.goal_id) ||
    !['active', 'paused', 'interrupted'].includes(goal.state) ||
    !goal.root_matches
  )
    return '';
  const context = JSON.stringify(
    {
      workspace_id: workspaceId,
      goal_id: goal.goal_id,
      objective: goal.objective.slice(0, GOAL_CHAT_REQUEST_MAX_LENGTH),
      saved_next_step: goal.checkpoint?.next_step.slice(0, 1_000) ?? '',
    },
    null,
    2,
  );
  return (
    locale === 'ko'
      ? [
          '이 프로젝트의 다음 Goal을 새로 만들지 말고 저장된 상태에서 이어서 수행해 주세요.',
          '이어갈 Goal 데이터 (최신 상태는 도구로 다시 확인):',
          context,
          '',
          '1. 이 대화의 프로젝트 지침에 있는 binding으로 project.goal을 호출해 정확한 workspace_id·goal_id의 최신 상태, revision, checkpoint, 완료 기준과 소유 실행을 읽으세요. 현재 root와 추적 파일을 다시 확인하세요.',
          '2. 현재 상태가 completed·cancelled·cancelling이면 재개하지 말고 상태를 알려주세요. paused·interrupted인 경우 소유 실행이 끝났는지 확인하고 최신 expected_revision으로 명시적으로 resume하세요.',
          '3. active 상태에서 기한이나 실행 한도가 소진되었다면 바로 resume하지 마세요. 소유 실행 종료를 확인하고 pause → 최신 Goal 조회 → resume 순서로, 허용된 기한·예산 안에서 갱신하세요. max_executions가 0이면 실행 횟수 제한이 없습니다. 저장값이 이미 0이면 resume에서 max_executions를 생략해 기존 무제한 설정을 유지하세요. 이 선택 필드는 예산 변경이 필요할 때만 지정하세요. 생략은 양수 예산도 그대로 보존하므로, 기존 Goal의 양수 예산을 없애도록 요청받았다면 max_executions: 0을 명시해야 합니다. 공개 스키마가 아직 minimum: 1·maximum: 128이면 연결의 도구 정의를 새로고침하고 새 대화에서 확인하세요. 누적 횟수와 보관된 receipt 개수는 서로 다릅니다.',
          '4. 저장된 다음 단계와 아직 통과하지 않은 기준을 확인해 수정·검증을 계속하세요. project.exec에는 goal_id를, 기준 검증에는 criterion_id와 선언된 정확한 검사/browser assert를 연결하세요. 실행 중인 요청은 중복 제출하지 말고 결과를 확인하세요.',
          '5. 파일 또는 runtime 변경으로 stale이 된 근거를 다시 검증하세요. 파일 존재만으로 기능 검증을 대신하지 마세요. 변경 전에 최신 revision을 확인하고, 필수 근거가 현재 파일에 유효하며 소유 작업이 끝나면 최종 checkpoint를 저장한 뒤 complete를 요청하세요. 종료된 Goal에는 checkpoint를 다시 쓰지 마세요.',
          '6. 현재 대화에서 완료 또는 실제 장애까지 이어가고, 응답을 끝내기 전 active·paused 상태에서 가능한 경우 진행 요약·막힌 이유·다음 단계를 checkpoint로 저장하세요. 기존 권한을 지키고 새 대화를 자동 시작하지 마세요.',
          'Goal 도구가 현재 연결에 없으면 재개했다고 말하지 말고 필요한 연결 새로고침을 알려주세요.',
        ]
      : [
          'Continue this existing project Goal from its saved state; do not create a replacement.',
          'Goal to continue (read its latest state with the tool):',
          context,
          '',
          '1. Use the binding in this conversation’s project instructions to call project.goal for this exact workspace_id and goal_id. Read the latest state, revision, checkpoint, criteria and owned executions. Recheck the current root and tracked files.',
          '2. If it is completed, cancelled or cancelling, report that state without resuming. If paused or interrupted, check that owned executions have finished and explicitly resume with the latest expected_revision.',
          '3. An active Goal with an expired deadline or exhausted budget cannot be resumed directly. Wait for owned work to finish, then pause, read the latest Goal and resume within allowed deadlines and budgets. max_executions: 0 means no execution-count limit. When the stored value is already 0, omit max_executions on resume to preserve unlimited execution counts. Supply this optional field only for a requested budget change. Omission preserves positive budgets too; removing a positive budget requires explicit max_executions: 0. If the advertised schema still has minimum:1 or maximum:128, refresh the connection tool definitions and check them in a new conversation. Cumulative execution counts are distinct from retained receipts.',
          '4. Continue edits and verification from the saved next step and unfinished criteria. Link project.exec to goal_id, and acceptance checks to criterion_id and the exact declared check/browser assert. Await existing work rather than submitting it again.',
          '5. Revalidate stale evidence after file or runtime changes. File existence does not replace behavioral verification. Read the latest revision before mutations. When current required evidence is valid and owned executions are terminal, save the final checkpoint before requesting complete. Do not checkpoint a terminal Goal.',
          '6. Continue in this active conversation until completion or a real blocker. Before ending the response, save progress, blockers and the next step in a checkpoint when the state allows it (active or paused). Respect existing permissions and do not start a new conversation automatically.',
          'If the Goal tools are absent from this connection, do not claim resumption; explain which connection refresh is needed.',
        ]
  ).join('\n');
}
