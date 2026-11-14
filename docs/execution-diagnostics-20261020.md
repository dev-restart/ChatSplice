# 실행 검사·적용 대기 진단 — 2026-10-20

## 결과와 확인 범위

소스 구현, 집중 회귀 검사, 전체 런타임 빌드와 Chromium 화면 검사를 완료했다. 현재 사용자 앱/daemon은 재시작하지 않았다. 별도 테스트 프로젝트 실제 프로젝트의 재실행 성공과 ChatGPT 메시지 스트림 오류 해결은 확인하지 않았다.

별도 테스트 프로젝트 화면의 `execution link inspection` / `BAD_REQUEST`는 명령 실행 전 ChatSplice 파일 검사 실패다. 여기서 link는 파일 연결을 뜻하며 네트워크 연결 검사나 모델 거절을 뜻하지 않는다. 기존 일반 오류만으로는 항목 수와 시간 중 어느 상한을 넘었는지 확정할 수 없다.

## 구현한 동작

- 전체 승인 폴더의 검사 예산을 항목 1,000,000개·깊이 64·60초로 변경했다. 이전 200,000개·10초를 넘는 정상 트리를 검사할 수 있다. 무제한 실행, 폴더 생략, 검사 승인 캐시는 추가하지 않았다.
- metadata 동시 조회 8개와 진행 중 조회 정리를 유지한다. 모든 승인 root의 내부 hard-link 수와 실제 nlink, 디렉터리/파일 identity, 읽기/쓰기 범위를 계속 검사한다.
- 실행 기록의 기존 message에서 폴더 대기, 실행 슬롯 대기, 준비, 파일 검사, alias 재확인, 명령 실행을 구분한다. 검사 시작/단계 전환과 그 외 최대 500ms당 한 번 숫자 진행 정보를 전달한다. 검사 완료는 명령 성공으로 표시하지 않는다.
- 직접 파일 변경의 폴더 예약 대기는 최대 15초다. 시작하지 못하면 `[WORKSPACE_OPERATION_WAIT_TIMEOUT]`과 함께 대기열에서 제거한다. 이미 시작한 변경의 결과를 중간에 버리지 않으며 만료된 변경이 뒤늦게 실행되지 않는다.
- 변경 제안은 `APPLY_WAITING_DISPATCHER`, `APPLY_CLAIMED`, `APPLY_IN_PROGRESS`와 경과 시간을 제공한다. 같은 proposal 상태를 계속 확인하도록 안내하며 자동 중복 제출은 하지 않는다.
- 작업 화면에서 한국어/영어 단계, 실제 관측 경과 시간, 검사 수치/상한, job ID, 원래 오류/출력을 보여 준다. 취소를 실패로 세지 않고, 프로젝트 전환과 기록 만료 시 선택/필터를 정리한다. 실패 집계는 현재 daemon 메모리에 보관된 기록만 대상으로 하며 영구 장애 이력 DB는 아니다.
- 인증된 `/mcp` 요청마다 익명 요청 ID와 `x-chatsplice-request-id` 응답 헤더를 추가했다. 접수, 최초 전송 오류, 정상 응답 종료 또는 조기 연결 종료를 같은 ID와 경과 시간/HTTP 상태로 기록한다. SDK handler/adapter는 async context로 연결된다. URL/query/headers/body/command/token/예외 원문은 로그에 넣지 않는다. Node의 finish는 클라이언트 수신 완료나 도구 성공의 증명이 아니다. 관측 코드가 요청을 종료하거나 재시도하지 않는다.
- 전체 빌드에서 드러난 Goal 저장 스키마의 TS2883 선언 오류를 공개 schema의 반환 타입을 명시하는 방식으로 수정했다. 스키마 검증 동작은 바꾸지 않았다.

주요 구현은 `packages/core/src/project/execution-links.ts`, `packages/core/src/fs/file-access.ts`, `packages/mcp-server/src/execution/service.ts`, `packages/mcp-server/src/http/request-observation.ts`, renderer의 `execution-progress-view.ts`와 `ExecutionProgressDetail.svelte`에 있다.

## 검증 결과

| 검사                                                 | 실제 결과                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 대규모 검사 경계/시간/깊이/진행/취소/alias 모형 회귀 | `execution-link-limits.test.ts` 17개 통과. 정확히 100만 개 통과, 100만 1개 차단, 이전 20만 개·10초 초과 정상 검사 통과                        |
| 화면의 실패 분류/진행 상태 해석                      | 2개 파일, 22개 통과                                                                                                                           |
| 실행 단계·HTTP 응답 관측                             | 2개 파일, 6개 통과                                                                                                                            |
| 기존 실행 서비스·동시성·실패 근거·변경 제안          | 4개 파일, 19개 통과                                                                                                                           |
| 파일 접근/폴더 잠금                                  | 파일 접근 14개와 폴더 잠금 4개 통과. 새 대기 만료/시작 후 완료 테스트 2개 포함. 기존 create/rename 테스트 1개는 하드 링크 생성 EPERM으로 실패 |
| Goal 저장소                                          | 6개 통과                                                                                                                                      |
| TypeScript / Svelte                                  | protocol/core/MCP/desktop/renderer 통과. Svelte 오류 0, 경고 0                                                                                |
| 형식 / 정적 검사                                     | 변경 파일 Prettier 통과. TS/MJS ESLint 오류·경고 0. Svelte는 별도 svelte-check로 검사                                                         |
| 전체 런타임 빌드                                     | protocol, core, MCP daemon, desktop main/preload/renderer와 runtime identity 생성 성공                                                        |
| 실제 Chromium 화면                                   | 새 빌드의 renderer로 KO/EN, 오류 원문, 원인 분류, 프로젝트 전환, 만료 기록, 진행 단계, 480px 배치 통과. pageErrors=[]                         |

기존 실제 hard-link/추가 폴더 통합 테스트는 17개 중 6개가 통과하고 11개가 현재 MCP 실행 환경에서 실패했다. 8개는 fixture의 신규 hard-link 생성 EPERM, 3개는 중첩 `sandbox-exec` 초기화 거부였다. 파일 접근의 create/rename 실패까지 합쳐 hard-link 생성 제한 사례는 9개다. 이 결과를 통과로 처리하거나 실행 보호를 해제하지 않았다.

기존 runtime HTTP 통합 테스트에서 선택한 3개는 임시 daemon 초기화의 `Another chatspliced instance is already using the control socket.` 오류로 검사 전에 중단됐다. 이 문구만으로 실제 사용자 daemon 충돌인지 환경 제한인지 확정하지 않았다. 해당 통합 범위는 검증 미완료이며, HTTP 관측 자체의 네 가지 회귀는 통과했다.

빌드의 큰 renderer chunk 경고는 남아 있다. 서명된 설치 패키지, native Electron 입력, 실제 사용자 계정의 새 runtime 연결은 이번 확인 범위에 포함하지 않았다.

주요 재검증 명령:

```bash
node scripts/check-workspace-folders.mjs types
node scripts/check-workspace-folders.mjs unit core src/project/execution-link-limits.test.ts
node scripts/check-workspace-folders.mjs unit mcp src/execution/stage-diagnostics.test.ts src/http/request-observation.test.ts src/execution/service.test.ts src/execution/concurrency.test.ts src/execution/failure-evidence.test.ts src/mutation/local-apply-proposal-store.test.ts
node scripts/check-workspace-folders.mjs unit desktop src/renderer/execution-failure-view.test.ts src/renderer/execution-progress-view.test.ts
pnpm build:staged
```

## 확인된 실행용 빌드

- 생성 시각: 2026-10-20T03:46:35.114Z (한국 시간 2026-10-20 12:46:35).
- 경로: `node_modules/.cache/chatsplice-runtime-…`.
- 소스 snapshot: 362개 파일, 9275756 bytes.
- source SHA-256: `fecaeb51c3a7f9587cb2b007becfa309b5eac01794b2981c65736550aef8c41f`.
- desktop build ID: `f13867157f4ad629ee20aad9b4fa5697f1031deb9ae718a21ac6e6f9ddc5e524`.
- daemon build ID: `57ce88248b451aad125f7d29a29b67eb7814539e819c2ad4af13124649a32bec`.
- MCP descriptor 0.0.14 / 24 tools. 별도 모델 호출은 추가하지 않았다.

새 `runtime-candidate.json`과 실제 compiled scanner의 1,000,000 / 60,000ms / concurrency 8 / progress 500ms 값을 다시 읽어 확인했다. 원래 checkout의 `packages/core/dist/project/execution-links.js`에는 여전히 200,000 / 10,000ms가 있다. 새 빌드 생성이나 MCP 정의 새로고침만으로 실행 중 프로세스가 새 코드를 읽는 것은 아니다.

진행 중인 작업과 미저장 편집을 마무리하고 현재 앱/daemon을 정상 종료한 뒤 아래 명령으로 새 빌드를 시작한다.

별도로 만든 실행본을 사용하려면 `pnpm build:staged`가 출력한 폴더에서 `pnpm start`를 실행합니다.

`pnpm build:staged`는 고정된 소스/설정/리소스만 새 경로에 복사해 정상 monorepo build를 실행한다. `@chatsplice/*`는 새 경로의 패키지를 참조하고, 설치된 외부 의존성은 원래 checkout에서 재사용한다. 빌드 중 source fingerprint가 바뀌면 준비 완료 manifest를 만들지 않는다. 이 디렉터리는 원래 의존성에 연결된 로컬 실행용 빌드이며 독립 배포 파일은 아니다.

## 작업 중 추가 관측

하위 에이전트의 MCP 읽기/변경 요청이 약 16–18분 동안 응답을 돌려주지 않는 현상을 관측했다. 파일을 다시 읽었을 때 해당 변경은 적용되지 않았고, 부모의 한 변경 흐름으로 전환한 후 같은 파일의 수정과 재확인은 정상 완료됐다. 이 현상의 지연 계층은 확정하지 않았다. 새 15초 폴더 대기 제한이 이 전송 지연까지 해결했다고 주장하지 않는다. 향후 익명 요청 수신/종료 기록을 이용해 로컬 서버 접수 이전과 이후를 구분할 수 있다.

앱 강제 종료, 사용자 작업 자동 재실행, commit/push는 하지 않았다. 별도 테스트 프로젝트에는 정확한 프로젝트 binding과 실제 새 runtime 실행 결과가 있어야 후속 성공 판정을 할 수 있다.
