import { uiText, type UiLocale, type UiTextKey } from './i18n.js';

const ko = {
  executionNetworkCargoLocal: '로컬 통신 · Cargo 의존성 오프라인',
  executionProgressTitle: '로컬 작업 진행 상태',
  executionProgressWaitRoot: '같은 폴더의 작업을 기다리는 중',
  executionProgressWaitRootDetail: '먼저 시작한 파일 작업이 끝나면 이어서 진행합니다.',
  executionProgressWaitSlot: '실행 순서를 기다리는 중',
  executionProgressWaitSlotDetail: '현재 실행 중인 작업이 끝나면 실행 준비를 시작합니다.',
  executionProgressPreparing: '실행 준비 중',
  executionProgressPreparingDetail: '작업 폴더와 실행 환경을 확인하고 있습니다.',
  executionProgressInspecting: '실행 전 파일 검사 중',
  executionProgressInspectingDetail:
    '명령을 시작하기 전에 프로젝트와 함께 사용할 폴더의 파일 상태를 확인합니다.',
  executionProgressLinks: '파일 연결 확인 중',
  executionProgressLinksDetail: '검사한 파일의 연결 상태를 마지막으로 확인하고 있습니다.',
  executionProgressInspected: '파일 검사 완료',
  executionProgressInspectedDetail: '파일 검사를 마쳤으며 실행 준비를 이어가고 있습니다.',
  executionProgressRunning: '로컬 작업 진행 중',
  executionProgressRunningDetail:
    '로컬 실행기가 작업을 처리하고 있습니다. 결과가 도착하면 상태가 갱신됩니다.',
  executionProgressCancelling: '취소 처리 중',
  executionProgressCancellingDetail: '진행 중인 작업과 사용 중인 자원을 정리하고 있습니다.',
  executionPhaseElapsed: '현재 단계',
  executionQueueElapsed: '시작 전 대기',
  executionInspectedEntries: '검사한 항목',
  executionInspectedRoots: '검사 대상 폴더',
  executionEntryLimit: '항목 한도',
  executionInspectionDuration: '검사 시간',
  executionInspectionTimeLimit: '검사 제한 시간',
  executionProgressEvidence: '마지막으로 수신한 실행기 기록 기준',
  executionOriginalStatus: '상태 원문',
  executionJobId: '작업 ID',
  executionFailureWorkspaceBusy: '파일 작업 대기 시간 초과',
  executionFailureWorkspaceBusyDetail:
    '같은 폴더의 선행 작업을 기다리다 제한 시간이 끝났습니다. 이 변경은 시작되지 않았습니다.',
  executionFailureWorkspaceBusyNext:
    '진행 중인 파일 작업이 완료되었는지 확인하고 요청하세요. 기존 작업의 결과가 불확실하면 적용 상태부터 확인하세요.',
} as const;

export type ExecutionDiagnosticTextKey = keyof typeof ko;
export type ExecutionTextKey = UiTextKey | ExecutionDiagnosticTextKey;

const en: Record<ExecutionDiagnosticTextKey, string> = {
  executionNetworkCargoLocal: 'Local network · Cargo dependencies offline',
  executionProgressTitle: 'Local task progress',
  executionProgressWaitRoot: 'Waiting for work in the same folder',
  executionProgressWaitRootDetail: 'This task continues when the earlier file operation finishes.',
  executionProgressWaitSlot: 'Waiting for an execution slot',
  executionProgressWaitSlotDetail: 'Preparation starts when a running task releases a slot.',
  executionProgressPreparing: 'Preparing the task',
  executionProgressPreparingDetail: 'Checking the working folders and execution environment.',
  executionProgressInspecting: 'Inspecting files before execution',
  executionProgressInspectingDetail:
    'Checking files in the project and additional folders before starting the command.',
  executionProgressLinks: 'Verifying file links',
  executionProgressLinksDetail: 'Performing the final check of links between inspected files.',
  executionProgressInspected: 'File inspection complete',
  executionProgressInspectedDetail:
    'File inspection has finished. Execution preparation is continuing.',
  executionProgressRunning: 'Local task in progress',
  executionProgressRunningDetail:
    'The local runner is processing this task. Its status updates when a result arrives.',
  executionProgressCancelling: 'Cancelling the task',
  executionProgressCancellingDetail:
    'Finishing cancellation and releasing the resources used by this task.',
  executionPhaseElapsed: 'Current stage',
  executionQueueElapsed: 'Wait before preparation',
  executionInspectedEntries: 'Entries inspected',
  executionInspectedRoots: 'Folders in scope',
  executionEntryLimit: 'Entry limit',
  executionInspectionDuration: 'Inspection time',
  executionInspectionTimeLimit: 'Inspection time limit',
  executionProgressEvidence: 'Based on the latest record received from the runner',
  executionOriginalStatus: 'Original status',
  executionJobId: 'Job ID',
  executionFailureWorkspaceBusy: 'File operation wait timed out',
  executionFailureWorkspaceBusyDetail:
    'The wait for earlier work in the same folder reached its limit. This change did not start.',
  executionFailureWorkspaceBusyNext:
    'Check whether the active file operation has finished before requesting again. If its result is uncertain, inspect the applied changes first.',
};

export function executionText(
  locale: UiLocale,
  key: ExecutionTextKey,
  values: Record<string, string | number> = {},
): string {
  if (Object.hasOwn(ko, key)) {
    return (locale === 'ko' ? ko : en)[key as ExecutionDiagnosticTextKey];
  }
  return uiText(locale, key as UiTextKey, values);
}
