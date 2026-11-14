# Goal 공개 스키마 호환성 보완 — 2026-10-21

## 요청과 확인 범위

사용자는 저장된 Goal의 max_executions가 0이고 누적 실행이 244회인데, resume에 0을 명시하면 공개 입력 스키마의 minimum:1·maximum:128 때문에 거절된다고 보고했다. pnpm dev로 재실행한 뒤에도 같은 오류가 발생했다. 이 작업은 연결이 검증된 ChatSplice 저장소의 도구 계약·앱 연결·검증 코드를 수정했다. 원래 작업 프로젝트의 binding은 이 대화에 제공되지 않았으므로 그 프로젝트의 Goal, checkpoint, 소스 또는 실행 상태를 변경하지 않았다.

보고된 Arguments do not match schema는 도구 입력 계약의 불일치다. 이것만으로 모델의 작업 거절이나 Rust 기능 실패를 의미하지 않는다. 사용자 보고와 별도로 현재 소스, 기존 checkout의 빌드 산출물, 실제 공개 MCP 응답, 이 대화에 노출된 도구 설명을 대조했다.

## 발견한 차이

- 수정 전 소스와 기존 dist의 create/resume는 이미 nonnegative 정수로 0을 받았다. create 기본값은 0이고 resume의 선택 필드를 생략하면 service가 기존 값을 보존했다.
- 기존 checkout의 descriptor는 0.0.15, 실행 계약은 development-runtime-3이었다.
- 공개 project.goal 응답에 새 pagination의 total/has_more/next_offset이 존재했다.
- 공개 project.exec 진단은 기존 compiled resume(0) 파싱 성공과 짧은 private runtime cs-e- 경로 사용을 반환했다. 따라서 이전 runtime 보완이 전혀 적용되지 않은 상태라고 볼 수 없다.
- 그런데 이 대화에 노출된 project.exec 설명은 workspace-folders-1이고 Goal 설명은 128회 제한·옛 입력 shape를 유지했다. 현재 서버 기능과 원격에 노출된 도구 정의가 불일치한다.
- 정확히 어느 원격 캐시 계층이 이전 정의를 유지하는지는 여기서 직접 관측하지 못했다. 로컬 서버 수정이나 재시작으로 ChatGPT 연결 갱신 완료를 주장하지 않는다.

초기 공개 실행 근거는 exec_9aa383ce-73fb-489e-8cba-f9943a3efd85이며 exit 0이다. 기존 compiled resume_zero와 private_runtime_short가 true였고 당시 expected daemon build는 e3301c92fe289cbbae1e6b907b5c28e62365c6c6b40df46eca4ec5833f86066b였다.

## 구현

### 실행 예산 계약 공유

packages/protocol/src/goal.ts에 GoalExecutionBudgetSchema를 두고 durable record, create, resume와 owner/public 입력이 같은 정의를 사용하도록 했다. 0은 실행 횟수 제한 없음이며 양수는 명시적 예산이다. create는 0을 기본값으로 사용한다. resume에서 필드를 생략하면 저장된 값을 보존한다.

따라서 저장값이 이미 0인 Goal은 누적 실행이 244회여도 필드를 생략한 resume로 0을 유지할 수 있다. 양수 예산을 해제하려면 명시적 0이 필요하다. 생략을 양수 예산 해제 수단으로 안내하지 않는다. 현재 root·추적 파일·최신 revision·소유 실행 종료·기한 검증은 그대로 적용된다.

### 현재 서버 계약 진단

packages/mcp-server/src/mcp/tools-goal.ts의 project.goal은 기존 structuredContent를 그대로 유지하면서 두 번째 text content에 goal_tool_contract를 반환한다.

진단에는 현재 execution contract, descriptor, registered tool count/schema digest, 0의 의미, optional resume 필드 보존 동작과 연결 갱신 안내를 담는다. client_tool_schema_status는 not_observable로 고정해 원격 정의가 최신인지 관측하지 못한다는 사실을 표시한다. binding·token·절대 root·Goal 본문은 진단에 넣지 않는다.

catalog provider는 실제 handler에서 지연 호출한다. metadata discovery의 도구 등록 과정에서 호출하지 않아 재귀를 피한다. provider가 실패하면 unavailable/null만 표시하고 정상 Goal 조회를 유지하며 내부 오류를 노출하지 않는다. source binding이 잘못되면 provider도 호출하지 않는다. server factory와 좁은 GoalToolContext 타입으로 의존성을 연결했다.

### 기존 daemon의 다른 스키마 재사용 감지

apps/desktop/src/main/daemon-client.ts의 status는 검증된 desktop identity의 expected tool-schema digest와 daemon의 advertised digest를 비교한다. 다르면 기존 IncompatibleDaemonError로 재사용을 중단하고 예상/실제 값과 정상 종료·재실행 안내를 제공한다.

build ID만 다르고 schema digest가 같으면 이 이유로 차단하지 않는다. 검증되지 않았거나 없는 metadata에서는 기존 동작을 유지한다. 기존 프로세스를 자동 종료하거나 control socket 소유권을 가져오지 않는다. 이미 실행 중인 앱에서 외부 daemon 교체 후 나타나는 일부 일반 offline 표시는 이번 변경 범위 밖이다.

### 이어하기와 버전

apps/desktop/src/renderer/goal-chat-request.ts의 한국어·영어 이어하기 요청은 저장값이 이미 0이면 선택 필드를 생략해 보존하도록 안내한다. 양수에서 무제한으로 바꿀 때는 명시적 0이 필요하다고 구분하며, 오래된 minimum:1·maximum:128이면 연결 Refresh와 새 대화의 정의 확인을 안내한다.

MCP descriptor를 0.0.16으로 올렸다. 실행 계약 development-runtime-3, control protocol 4, 도구 24개는 유지한다. 이 변경으로 새로운 모델 호출·도구·권한 우회 경로를 추가하지 않는다.

## 검사 결과

다음은 실제 공개 MCP shell의 network:local로 수행한 결과다. 단위 검사의 fixture Goal과 임시 데이터베이스를 사용했으며 사용자의 실제 Goal은 수정하지 않았다.

- Protocol: src/goal.test.ts, 9개 통과. 공개 create/resume의 0·129·244·10000 허용과 음수·소수·안전하지 않은 정수 거절을 검사한다.
- MCP: src/mcp/tool-catalog.test.ts와 src/mcp/goal-chat-transport.test.ts, 7개 통과. 인증된 실제 HTTP tools/list의 create/resume minimum:0, 선택 필드와 create 기본값을 확인한다. 누적 244회·최근 receipt 32개 fixture에서 명시적 0 및 필드 생략 resume가 같은 Goal·누적 값·receipt를 보존한다. 추가 진단과 실패 격리도 검사한다.
- Desktop: daemon-client, daemon-identity-error, goal-chat-request, 28개 통과. schema mismatch 거절·정상 schema 재사용·종료 요청 없음·한국어/영어 안내를 확인한다.
- 합계는 서로 다른 44개 테스트다. 전체 저장소 테스트를 실행했다고 의미하지 않는다.
- 전체 protocol/core/mcp/desktop TypeScript와 renderer Svelte 검사 통과, Svelte 오류 0·경고 0.
- 변경 TypeScript 13개 파일의 Prettier와 ESLint 최종 통과.
- 별도 snapshot의 protocol/core/mcp/desktop main·preload·renderer 빌드 통과.
- 빌드된 실제 protocol의 resume(0) 파싱 성공, 실제 compiled catalog의 24개·descriptor 0.0.16·schema digest가 desktop identity와 일치함을 확인했다.

처음 타입 검사에서 테스트 context의 과도한 전체 타입 변환 오류를 발견해 실제 사용하는 의존성만 받는 Pick 타입으로 수정했다. ESLint의 사용되지 않은 pause 결과 대입도 제거했으며 pause 호출과 후속 최신 조회는 유지했다. 실패 결과를 숨기거나 검증 조건을 약화하지 않았다. 빌드의 기존 renderer chunk 크기 경고는 남지만 빌드 종료 코드는 0이다.

실행 근거:

- Protocol: (로컬 실행 ID 생략).
- MCP: (로컬 실행 ID 생략).
- Desktop: (로컬 실행 ID 생략).
- 최종 types: (로컬 실행 ID 생략).
- 최종 ESLint: (로컬 실행 ID 생략).
- source Prettier: (로컬 실행 ID 생략).
- staged build: (로컬 실행 ID 생략).
- compiled candidate: (로컬 실행 ID 생략).

## 검증된 실행본

빌드 시각: 2026-10-21 07:41:12 UTC, 한국 시간 16:41:12.

Candidate: node_modules/.cache/chatsplice-runtime-Eb8HRI

- source SHA-256: 8a143dd0bed92b9144918b06f85758d84fd73c7852cafb81ba3f069530b796e0
- desktop build: 4938353d2bd9db1d1c2710020e4f06e914610043028f1f18ac5967d36d0ea703
- daemon build: dd94799a15de870f41242eebf451dab3a8543aa94a6e76f7f674577cbdb9f6df
- tool-schema digest: 2467baf3ac0552b7b96fe35d68ad77b3da9517e09c5e265fcec27cf0e8ab5a38
- snapshot: 388개 입력, 9552528 bytes.
- descriptor: 0.0.16, execution: development-runtime-3, control: 4, tools: 24.

runtime-candidate.json과 desktop runtime-identity.json을 public fs.read로 재확인했다. source snapshot과 compiled identity를 확인했지만 이 candidate로 현재 실행 앱을 교체하지는 않았다. 설치된 dependency는 원 checkout과 연결되어 있으며 이 폴더는 로컬 실행본이다.

## 적용과 복구 확인 순서

1. 진행 중인 사용자 작업을 마무리하고 미저장 내용을 저장한 뒤 기존 ChatSplice 앱과 그 daemon을 정상 종료한다. 새 pnpm dev를 실행해도 기존 single-instance 앱이 남아 있으면 이전 앱으로 돌아갈 수 있으므로 먼저 종료 여부를 확인한다.
2. 아래 별도 실행본을 시작한다. 원 checkout에서 정상 종료 후 pnpm dev로 다시 빌드해도 되지만 원격 도구 정의 갱신 단계는 별도로 필요하다.

별도로 만든 실행본을 사용하려면 `pnpm build:staged`가 출력한 폴더에서 `pnpm start`를 실행합니다.

3. ChatGPT Plugins에서 직접 연결한 로컬 MCP 연결을 열어 Refresh를 수행한다. 현재 이 대화의 관리 도구에는 이 Refresh를 강제로 실행하는 API가 없다. 연결 해제·권한 변경·private endpoint 호출을 대신 수행하지 않는다.
4. 새 대화에 해당 프로젝트의 기존 MCP 연결을 사용하고 도구 정의를 확인한다. 새 서버 project.goal 진단의 descriptor는 0.0.16이고 위 digest와 일치해야 한다. 원격 create/resume 입력의 minimum:0도 직접 확인한다.
5. 원래 프로젝트에서 같은 Goal의 최신 상태·root·파일·revision·소유 작업을 읽고 재개한다. 이미 저장된 max_executions가 0이면 이 필드를 생략해도 유지된다. 명시적 0까지 호출 성공해야 원격 입력 계약 복구가 확인된다. 오래된 revision을 복사해 사용하지 않는다.
6. 환경 적용 근거를 확인한 뒤 해당 프로젝트의 원래 기능 검사를 진행한다. 이번 통과를 별도 테스트 프로젝트 전체 Cargo 또는 별도 음성 프로젝트 기능 성공으로 계산하지 않는다.

OpenAI의 직접 연결 MCP 갱신 절차는 서버 변경 적용, 연결 Refresh, 새 대화에서 변경된 도구 테스트를 구분한다: https://developers.openai.com/plugins/deploy/connect-chatgpt

## 남은 범위

실제 별도 테스트 프로젝트 Goal에서의 명시적 resume(0)과 원격 connector 갱신은 이 대화에서 실행하지 않았다. /bin/ps의 기존 OS 권한 거절, 실제 별도 테스트 프로젝트의 Cargo·hostname 검사와 AC-019는 별도 검증 대상이다. 이번 보완을 모든 OS 권한·기능 오류 해소로 보고하지 않는다. 동일 환경에서 근거 없이 전체 Cargo 검사를 반복하거나 Goal 기록을 지우는 방식으로 오류를 덮지 않는다.
