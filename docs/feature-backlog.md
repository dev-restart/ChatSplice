# 추가 기능 등록부

등록일: 2026-10-11. 갱신일: 2026-10-12. 사용자가 요청한 Goal 기능과 개발 루프의 후속 보완 항목을 현재 코드에 대조해 등록한 뒤 runtime을 구현했다. CS-G01~CS-G06과 CS-X01의 기반은 source 구현·로컬 검증, CS-X02는 환경·readiness 부분 구현, CS-G07은 readiness 부분 구현이며 나머지는 계획/조사로 구분한다. 현재 계약은 [current-contract.md](current-contract.md)이며 MCP 24개 도구, control protocol 4, descriptor 0.0.13, execution contract `goal-security-2`이다. source 구현이 설치 앱·target-account 적용을 뜻하지 않는다.

## 현재 구현과 추가 범위

코드 읽기·SHA 보호 수정, 의존성 설치, Python 환경, background 서버, isolated browser, assertion·실패 이미지, cancellation, 실행 pool과 contract mismatch 감지는 이미 구현되어 있다. 이를 신규 기능으로 중복 등록하지 않는다. 최신 로컬 검증은 [검증 기록](developer-execution-verification.md), 실행 앱·실제 연결의 미확인 항목은 로컬 진행 기록(`docs/agent-progress.md`)을 따른다.

Goal은 프로젝트의 목표·합격 기준·진행·근거·다음 단계를 저장하는 기능으로 정의한다. 개별 job의 `succeeded`와 Goal 완료는 다르다. 현재 ChatGPT 대화가 도구 호출을 이어가는 동안 개발을 진행하고, 이후 사용자가 재개하면 저장된 checkpoint부터 이어간다. Goal 저장만으로 대화 종료 후 새 추론을 자동 시작할 수 있다고 표시하지 않는다.

현재 근거:

현재 source의 pnpm verify(unit 607개), 실제 Chromium/MCP 회귀 6개, 1180px/560px Goal·readiness·연결 관리 renderer fixture가 통과했다. 새 0.0.13 bundled daemon의 identity·환경/readiness·Goal 호출과 unsigned arm64 package/browser smoke도 현재 revision에서 통과했다. packaged daemon과 native workbench의 수동 입력은 별도 검증이다. 최신 로컬 진행 기록(`docs/agent-progress.md`)에 각 검증의 범위를 남겼다. native Electron 입력·실제 계정·새 DMG upgrade는 별도 gate이며 이 결과로 통과 처리하지 않는다.

- [Goal repository](../packages/core/src/goal/sqlite-repository.ts)와 [Goal schemas](../packages/protocol/src/goal.ts)는 목표·criteria·checkpoint·최소 receipt를 SQLite에 저장하며 revision guard와 개수/bytes cap을 적용한다.
- [Goal service](../packages/mcp-server/src/goal/service.ts)는 현재 root·tracked SHA·runtime identity와 연결된 실행 근거를 검증한다. [execution service](../packages/mcp-server/src/execution/service.ts)의 live job/output과 [apply proposal store](../packages/mcp-server/src/mutation/local-apply-proposal-store.ts)는 memory-only이며 Goal receipt가 이를 durable queue로 바꾸지 않는다.
- [workspace service](../packages/core/src/workspace/service.ts)는 폴더 변경 때 workspace ID를 유지한다. Goal은 별도 root identity를 pin하여 변경된 폴더로 재개하지 않는다.
- [GoalPane](../apps/desktop/src/renderer/GoalPane.svelte)는 criteria·checkpoint·수동 lifecycle을 제공하고 [ExecutionJobs](../apps/desktop/src/renderer/ExecutionJobs.svelte)는 개별 job을 표시한다. ChatGPT 메시지를 입력·전송하지 않는다.
- [runtime identity](../packages/mcp-server/src/runtime-identity.ts)의 build_id/run_id는 동일 execution contract 안의 다른 bundle과 재시작을 구분한다. desktop build와 local daemon schema 비교는 구현·로컬 검증했고 실제 target-account schema 비교는 남은 gate다.

## 등록 목록

P0는 Goal을 잘못된 대상·근거로 재개하거나 완료하지 않기 위한 기반, P1은 사용자 흐름, P2는 기반 구현 이후의 실행 편의다. 상태는 구현 상태이며 우선순위만으로 자동 실행·배포·외부 서비스 사용 권한이 생기지 않는다.

| ID     | 우선순위 | 기능                                       | 상태                     | 선행 항목                           |
| ------ | -------- | ------------------------------------------ | ------------------------ | ----------------------------------- |
| CS-G01 | P0       | 프로젝트별 Goal 영속 저장과 접근 계약      | source 구현 · 로컬 검증  | 없음                                |
| CS-G02 | P0       | 합격 기준·evidence·완료 판정               | source 구현 · 로컬 검증  | CS-G01, CS-X01                      |
| CS-G03 | P0       | Checkpoint와 명시적 재개                   | source 구현 · 로컬 검증  | CS-G01, CS-G02                      |
| CS-G04 | P0       | 중단 복구와 bounded 실행 receipt           | source 구현 · 로컬 검증  | CS-G01, CS-G03                      |
| CS-G05 | P1       | Pause·cancel·실행 예산과 소유권            | source 구현 · 로컬 검증  | CS-G01, CS-G04                      |
| CS-G06 | P1       | Goal workbench와 재개 안내                 | source 구현 · 로컬 검증  | CS-G02, CS-G03, CS-G05              |
| CS-G07 | P2       | 안전한 검사·readiness의 bounded 재시도     | readiness 부분 구현      | CS-G02, CS-G04, CS-G05, CS-X02      |
| CS-X01 | P0       | 앱·daemon·tool schema의 build 식별         | source 구현 · 로컬 검증  | 없음                                |
| CS-X02 | P1       | 실행 환경 점검과 구조화된 server readiness | 환경·readiness 부분 구현 | 없음                                |
| CS-R01 | 조사     | 대화 종료 후 자동 추론 재개 경로           | 지원 경로 미확인         | CS-G01~CS-G07, 지원 capability 확인 |

### CS-G01 — 프로젝트별 Goal 영속 저장과 접근 계약

목표, 요청 범위, 합격 기준, 현재 상태, 다음 단계, 생성·갱신 시각을 app-private SQLite에 저장한다. 프로젝트 표시명 변경은 identity를 바꾸지 않는다. Goal은 immutable workspace ID와 canonical root identity에 묶고 모든 MCP 접근은 현재 workspace binding으로 검증한다. credential·token·cookie·binding은 저장하지 않는다. 사용자가 등록한 Goal 텍스트를 저장하며 대화 본문·전체 prompt를 자동 수집하지 않는다. 범위의 제외 사항은 scope에 함께 명시한다.

연결 지점은 [runtime](../packages/mcp-server/src/runtime.ts), [Goal schemas](../packages/protocol/src/goal.ts), core Goal SQLite repository다. MCP read/list와 write mutation을 별도 도구로 선언하며 owner UI는 private IPC/control API를 사용한다. 도구 목록/version 변경과 저장 cap은 current contract의 Goal amendment에 반영했다. schema version 1과 validated record를 사용하며 현재 설치 앱/계정에 새 API가 노출되었는지는 별도 확인한다.

완료 기준: 생성·조회·checkpoint/state 갱신·재시작 복원, 다른 프로젝트 접근 거부, 표시명 변경, root 변경·삭제, schema version 호환·손상 record의 명시적 오류를 검증한다. 개수·텍스트·criteria·receipt의 구체 상한과 보존 정책을 schema에서 정의하고 경계 테스트를 둔다. objective/scope/criteria 수정은 새 Goal을 명시적으로 만드는 흐름이다. 별도 model이나 `AgentSession`을 만들지 않는다.

### CS-G02 — 합격 기준·evidence·완료 판정

각 criterion을 파일 재읽기의 현재 SHA, 정확히 선언한 node_script/Cargo check 결과, browser assertion receipt 같은 실제 근거와 연결한다. 근거에는 pinned workspace/root identity, tracked-file digest, 실행 build/run, 검사 시각과 결과를 넣는다. 검사에 영향을 주는 경로는 tracked set에 명시해야 한다. 코드 완료, 로컬 검증, 설치 앱 적용, target-account 호출을 같은 결과로 보고하지 않는다. 제품 의미에 대한 무제한 추론을 daemon에 맡기지 않는다.

연결 지점은 [execution protocol](../packages/protocol/src/execution.ts), [browser service](../packages/mcp-server/src/browser/service.ts), [MCP project tools](../packages/mcp-server/src/mcp/tools-project.ts), 신규 Goal service다.

완료 기준: 실패·timeout·interrupted·미실행·stale evidence가 있는 required criterion으로 complete할 수 없다. 검사 후 tracked file·root·runtime이 바뀌면 근거를 재확인한다. 오래된 screenshot이나 다른 프로젝트의 receipt를 거부한다. 완료는 공유 root reservation에서 현재 근거와 owned job terminal 상태를 확인한다. Goal이 소유한 서버는 완료 전 cleanup하며 계속 유지할 별도 서버를 근거 없이 완료된 것으로 표시하지 않는다. 미연결 proposal의 의미·사용자 판단은 현재 ChatGPT 대화가 재읽기와 실제 근거로 확인한다.

### CS-G03 — Checkpoint와 명시적 재개

진행 summary, tracked path·SHA, 검사 근거, linked job receipt와 다음 한 단계를 저장한다. blocker와 미확인 사항은 summary에 명시한다. 복원 시 현재 파일·root·tracked manifest/lockfile·runtime과 실행 상태를 재확인한 뒤 다음 단계를 결정한다. raw command/stdin/output/image는 저장 대상이 아니다. proposal 전체 상태를 영속화하지 않는다.

연결 지점은 Goal repository/service, [project instructions](../packages/protocol/src/project-instructions.ts), [agent workflow](agent-workflow.md), execution lifecycle hook이다.

완료 기준: 다른 대화·앱 재시작에서도 명시적으로 Goal을 선택해 checkpoint를 읽을 수 있다. stale SHA·다른 root·사라진 job은 재검증 대상으로 표시하고 성공으로 복원하지 않는다. 재개 안내는 수동 복사나 지원되는 도구 결과로 제공하며 ChatGPT 입력창에 자동 입력·전송하지 않는다. 기록을 접근 권한 또는 현재 실행 사실로 취급하지 않는다.

### CS-G04 — 중단 복구와 bounded 실행 receipt

Goal record 안의 durable receipt에는 job identity, request fingerprint, criterion, 생성·시작·종료 시각, build/run, 상태·exit code만 제한적으로 보존한다. Goal·checkpoint와 receipt 저장은 transaction 및 revision guard로 보호한다. 기존 memory-only job이나 proposal을 durable queue로 바꾸지 않는다.

연결 지점은 core Goal repository, [execution service](../packages/mcp-server/src/execution/service.ts), [runtime](../packages/mcp-server/src/runtime.ts)이다. apply proposal의 durable 복구는 현재 구현 범위에 포함하지 않는다.

완료 기준: crash/restart 당시 진행 중이거나 완료 여부가 불명확했던 단계는 `interrupted` 또는 재확인 필요 상태로 복원한다. 설치·파일 변경·Git·일반 shell을 자동 replay하지 않는다. PID나 HTTP 응답만으로 process 소유권을 단정하거나 프로세스를 종료하지 않는다. root가 바뀌면 기존 checkpoint로 mutation을 재개하지 않고 대상 확인을 요구한다. 저장 실패, partial apply, 완료 직전 crash, 중복 resume, bounded 보존 cap/TTL과 프로젝트 제거를 검증한다. 취소는 이미 완료된 변경의 rollback이 아니다.

### CS-G05 — Pause·cancel·실행 예산과 소유권

Goal에 연결된 execution job의 소유권과 원자적 상태 전이를 정의한다. Pause는 신규/queued 시작을 막으며 running 작업은 종료할 수 있다. Cancel은 그 Goal이 소유한 실행만 정리하고 cleanup 완료를 확인한다. deadline과 실행 개수 budget을 둔다. proposal 연결과 retry budget은 이 구현에 포함하지 않는다.

연결 지점은 신규 Goal service, [execution service](../packages/mcp-server/src/execution/service.ts), [control server](../packages/mcp-server/src/control/server.ts), desktop [daemon client](../apps/desktop/src/main/daemon-client.ts)·private preload다.

완료 기준: pause/resume/cancel·완료 경합, deadline 초과, 중복 요청, cleanup 대기 상태를 검증한다. 다른 Goal·프로젝트·사용자 PTY와 editor draft는 영향받지 않는다. pause/cancel이 completed writes를 되돌리지 않음을 표시한다. elapsed/retry 제한을 ChatGPT 사용량·비용 제한 보장으로 표현하지 않는다.

### CS-G06 — Goal workbench와 재개 안내

프로젝트별 Goal 목록·목표·남은 기준·근거·실패·다음 단계를 한 흐름에서 표시한다. 생성 때 criterion을 선언하며 생성 뒤 기준 변경은 새 Goal로 처리한다. checkpoint·verify_file·pause·resume·cancel·complete와 interrupted/검증 대기·실패·stale/통과 상태를 제공한다.

연결 지점은 [App](../apps/desktop/src/renderer/App.svelte), [ExecutionJobs](../apps/desktop/src/renderer/ExecutionJobs.svelte), [i18n](../apps/desktop/src/renderer/i18n.ts), 신규 Goal component/controller와 owner-only IPC다.

완료 기준: 프로젝트 전환·재시작 복원, keyboard/focus, 긴 목표, narrow layout, 실패·복구·취소를 실제 renderer에서 검증한다. 현재 실행 앱과 tool 정의의 갱신이 필요한 경우 구체적 상태와 정상 교체 안내를 표시한다. 재개 버튼 클릭을 ChatGPT 추론 시작 또는 작업 완료로 표시하지 않는다.

### CS-G07 — 안전한 검사·readiness의 bounded 재시도

명시적으로 허용한 비변경 검사와 readiness probe만 횟수·시간·backoff 제한 안에서 재시도한다. 일반 shell, install, mutation이나 Git의 안전성을 command 문자열만으로 추정하지 않는다. 오류 수정은 현재 ChatGPT 대화가 판단하며 로컬 retry runner가 새 모델을 호출하지 않는다.

연결 지점은 신규 Goal retry policy, execution observer, readiness service다.

완료 기준: 일시적 503 후 성공, 반복 실패·budget 소진, deadline, pause/cancel 중 retry 제거를 검증한다. permission denial·sandbox 실패·binding 오류는 자동 우회하거나 재시도하지 않는다. 결과 불명확한 mutation은 재검증 후 명시적 재개로만 처리한다. 기존 execution pool·root lock·queue cap을 우회하지 않는다.

### CS-X01 — 앱·daemon·tool schema의 build 식별

같은 protocol과 `execution_contract`를 가진 서로 다른 build를 구분한다. executing daemon의 build_id/run_id에 더해 실제 compiled desktop main/preload/renderer/protocol bytes를 검증한 build manifest와 daemon의 actual tools/list schema·annotation digest를 연결 관리에 표시한다. development/packaged daemon의 기대 identity를 따로 기록하고 현재 실행과 비교하며 metadata 누락·변경은 미확인으로 남긴다. uncommitted 소스가 있으므로 Git SHA만으로 실행 revision을 판정하지 않는다. target-account가 실제로 노출한 schema 비교는 별도 검증 gate이며 local daemon metadata만으로 account 검증을 통과시키지 않는다.

연결 지점은 [protocol status](../packages/protocol/src/schemas.ts), [runtime](../packages/mcp-server/src/runtime.ts), desktop [daemon supervisor](../apps/desktop/src/main/daemon-supervisor.ts)·client, [package-daemon](../apps/desktop/scripts/package-daemon.mjs), connection UI다.

완료 기준: 동일 계약의 다른 bundle, development/packaged 실행, stale connector schema를 구분한다. dirty editor·실행 job을 보존한 정상 교체 안내만 제공하고 기존 daemon을 강제 종료하지 않는다. schema 발견만으로 실제 호출 가능성을 통과 처리하지 않는다. identity metadata에 개인 경로·binding·token을 넣지 않는다.

### CS-X02 — 실행 환경 점검과 구조화된 server readiness

설치 전 manifest·lockfile·package manager/runtime/browser 설치 상태를 bounded 방식으로 확인해 누락과 권한 오류를 구분한다. 서버 `running`과 명시한 loopback HTTP(S) endpoint의 `ready`를 별도 상태로 제공하고 검사 시각·timeout·실패 이유를 반환한다. 설치가 필요하면 기존 승인 범위의 execution lifecycle을 사용한다.

연결 지점은 [execution protocol](../packages/protocol/src/execution.ts), [execution backend](../packages/mcp-server/src/execution/backend.ts)·service, [browser diagnostics](../packages/mcp-server/src/browser/diagnostics.ts), ExecutionJobs다.

완료 기준: 누락 browser/runtime, lockfile 없음, 설치 후 사용 가능 여부, bind 실패·포트 충돌·준비 전 종료, 503→200, cancellation에 따른 probe 종료를 검증한다. 외부 redirect·무제한 body/로그를 금지하며 endpoint 응답만으로 해당 job의 process 소유권을 단정하지 않는다. 기존 포트 점유 프로세스 종료, global install, sandbox 해제를 자동 해결책으로 사용하지 않는다.

### CS-R01 — 대화 종료 후 자동 추론 재개 경로

사용자가 원하는 무인 Goal의 마지막 부분은 현재 Goal 저장이나 background 실행만으로 충족되지 않는다. 현재 계약은 새 ChatGPT turn 자동 생성, 메시지 자동 전송, conversation DOM/private endpoint 사용과 별도 model/AgentSession을 허용하지 않는다.

조사 완료 기준: 현재 계정·호스트에서 지원되는 명시적 continuation capability와 실제 invocation을 확인하고 그 권한·사용량·종료·resume 경계를 기록한다. 사용할 수 있는 지원 경로가 없으면 이 항목은 미지원으로 남기고 CS-G01~CS-G07을 자동 추론 서비스라고 홍보하지 않는다. 새로운 실행 방식이 필요하면 별도 제품 계약으로 결정한다. 현재 금지된 경로를 구현 계획이나 fallback으로 등록하지 않는다.

## 구현 순서와 검증 gate

1. CS-G01과 CS-X01의 storage/access/build 계약을 먼저 확정한다. 기존 SQLite/profile 업그레이드와 MCP 호환성을 검토한다.
2. CS-G02~CS-G04의 evidence·checkpoint·중단 복구를 구현하고 crash/partial failure/root 변경을 먼저 검증한다.
3. CS-G05~CS-G06의 lifecycle·owner UI를 연결하고 실제 생성→실행→중단→재개→완료 여정을 검증한다.
4. CS-X02와 CS-G07을 연결한다. CS-R01은 지원 경로가 확인될 때 별도로 진행한다.

아래 항목은 **추가 기능과 별개의 검증 작업**이다. 기존 미확인 gate를 구현 완료로 바꾸지 않는다.

| ID     | 검증 작업                                  | 현재 상태               | 통과 근거                                                                                                                                                                                |
| ------ | ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-V01 | 새 실행 앱·daemon·target-account 연결 확인 | 미확인                  | disposable 프로젝트에서 현재 대화의 도구 발견, read→SHA edit→re-read→check→background readiness→browser assert 성공/실패 이미지→cancel cleanup을 실제 결과로 확인                        |
| CS-V02 | 설치·native desktop 검증 보강              | 부분 확인               | 새 Corepack manager 외부 download, desktop Goal/editor/terminal 실제 입력, 실패 복구와 비밀값 비노출. 기존 cached manager·pip/uv 로컬 설치 검증과 구분                                   |
| CS-V03 | 해당 source revision의 직접 빌드·소스 공개 | local package 부분 확인 | 이전 unsigned package/browser smoke와 현재 source archive 검증을 구분; 현재 revision의 hosted CI·실제 공개 파일·사용자 직접 빌드·profile upgrade 확인. 서명·공증·update 운영은 범위 제외 |

## 등록 완료 기준

각 항목의 ID·우선순위·상태·현재 근거·연결 지점·선행 항목·합격 기준이 기록되어 있다. 이 등록부는 repository backlog이며 GitHub Issue 생성이나 실행 앱 반영을 뜻하지 않는다. source 구현 상태와 실제 검사 결과는 최신 로컬 진행 기록(`docs/agent-progress.md`)과 함께 갱신한다. 등록 기준 중 현재 구현에서 제외한 proposal 복구·criterion 수정·target-account schema 비교는 위에 명시했다.

## 보안 보완과 남은 검증

보안 후속 보완으로 모든 owner control route의 capability guard, manifest actual-byte/strict UTF-8 검사, 실행 전 bounded hard-link 점검과 sandbox의 새 hard-link 금지를 구현했다. 현재 로컬 검증 결과는 로컬 진행 기록(`docs/agent-progress.md`)에 남긴다. 동시 외부 프로세스의 alias 변경에 대한 kernel 수준 보장, 실제 사용자 앱 교체·native 입력·target-account 권한·정책 전체 통과를 선언하지 않는다.

CS-X02는 구조화된 HEAD readiness와 bounded manifest/lockfile/tool/cache 점검을 구현했다. runtime version·dependency sufficiency·실제 browser launch는 점검 report의 존재만으로 통과시키지 않으며 실제 실행 검증과 구분한다. CS-G07은 명시적 readiness의 제한된 재시도만 구현했으며 arbitrary script retry나 독립 Goal retry policy는 추가하지 않았다.
