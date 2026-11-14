# Rust·Python 개발 실행 환경 보완 — 2026-10-20

## 결과와 적용 범위

ChatSplice의 관리 실행 정책에서 Cargo loopback 통신, PTY, descriptor 기반 경로 탐색과 임시 hardlink fixture를 막던 차이를 수정했다. 실행 계약은 `development-runtime-1`, control protocol은 4, MCP descriptor는 0.0.14, 도구 수는 24개다. 별도 모델이나 Codex CLI를 호출하는 기능은 추가하지 않았다.

소스 구현, 관련 단위 검사, 실제 generic shell 서버, 격리된 renderer 검사와 별도 runtime 빌드는 완료했다. 새 정책의 native macOS 검사와 실제 실행 앱 교체는 남아 있다. 현재 MCP는 새 정책을 다시 적용하는 중첩 sandbox 초기화를 허용하지 않았으므로 이를 기능 통과로 기록하지 않았다.

이번에 직접 읽고 수정한 대상은 현재 연결된 ChatSplice 저장소다. 승인된 추가 폴더 목록은 비어 있었으며 별도 테스트 프로젝트의 111개 검사, AC-019와 investigation_frontier.rs는 직접 수정하거나 재실행하지 않았다. 아래 확인 결과로 그 111개를 모두 같은 원인으로 분류할 수 없다.

## 확인한 원인과 변경

| 보고된 장애                             | 현재 소스·실행에서 확인한 내용                                                                     | 변경 및 남은 검증                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 로컬 TCP listener EPERM                 | 일반 shell의 loopback HTTP는 성공하지만 기존 전용 Cargo profile은 모든 network 작업을 거부했다.    | Cargo와 legacy root check에 loopback 정책을 적용했다. Cargo 의존성 해석은 offline을 유지한다.                                                                                  |
| openpty 실패                            | 명령 profile에 PTY 장치 쓰기와 PTY capability 허용이 없었다.                                       | pseudo-tty, ptmx, sandbox PTY extension으로 범위를 제한한 slave 접근을 최종 명령에 추가했다. 새 profile의 실제 할당·입출력은 native suite로 확인해야 한다.                     |
| secure_open 실패                        | 실제 descriptor walk는 `/`에서 private 성분을 여는 단계에서 EPERM으로 실패했다.                    | 검증한 workspace/runtime/cache/추가 폴더의 정확한 상위 디렉터리 읽기를 추가했다. 형제 파일 본문이나 쓰기 권한은 추가하지 않았다.                                               |
| hardlink fixture 실패                   | 기존 profile은 모든 신규 file-link를 거부했고 private runtime의 양성 fixture도 EPERM으로 실패했다. | private job RUNTIME의 예외를 추가하고 보호 경로 deny에 file-link를 명시했다. 실제 소스·대상·symlink 경유 경계는 native positive/negative 검사 전까지 미검증이다.               |
| browser_process_inspect_failed·ps EPERM | `/bin/ps`는 거부됐지만 공개 libproc API의 자기 PID·유효 UID·parent·path 확인은 성공했다.           | ps 실패를 선택적 진단과 필수 소유권 검증으로 구분한다. 별도 테스트 프로젝트의 기존 ps 호출 자체를 이 정책이 고치지는 않으므로 호출부에 지원되는 프로세스 조회 구현이 필요하다. |

공통 helper는 최종 실행 profile에만 추가 권한을 합성하고 모든 보호 경로 deny보다 앞에 배치한다. Rustup의 읽기 전용 toolchain 선택 profile에는 PTY·link·loopback 권한을 추가하지 않았다. Cargo와 rustc 선택, 폴더별 읽기/쓰기, execution preflight, 파일 도구의 single-link·SHA 조건은 유지했다.

`TMPDIR`, `TMP`, `TEMP`는 모두 작업별 private runtime을 가리킨다. link fixture는 이 위치에 만든다. workspace/cache/reference/외부 source의 신규 hardlink는 허용 범위에 포함하지 않는다. 별도 테스트 프로젝트이 workspace 자체에 fixture를 만든다면 해당 테스트 경로도 함께 점검해야 한다.

PTY 정책 참고: [OpenAI Codex의 공개 Seatbelt 기본 정책](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl). 해당 참고 자료가 이 빌드의 native 검증 결과를 대신하지 않는다.

## 구현 파일

- 공통 정책과 적용: `packages/core/src/project/development-sandbox.ts`, `pi-sandbox.ts`, `shell-sandbox.ts`, `run-task.ts`.
- 정책·기능 회귀: `packages/core/src/project/development-sandbox.test.ts`, `development-capabilities.test.ts`.
- 실제 기능 진단: `scripts/diagnose-development-runtime.py`.
- 계약·실행 지침: `packages/protocol/src/schemas.ts`, `project-instructions.ts`, `execution-continuity-instructions.test.ts`, `packages/mcp-server/src/mcp/tools-project.ts`.
- 작업 기록: `apps/desktop/src/renderer/execution-diagnostics-text.ts`, `execution-failure-view.ts`, `execution-failure-view.test.ts`, `apps/desktop/scripts/execution-failures-ui-smoke.mjs`.
- 개발 계약·재개 기록: `AGENTS.md`, `docs/current-contract.md`, `docs/agent-workflow.md`, `docs/agent-progress.md`, 이 문서.

Cargo의 화면 표시는 한국어 `로컬 통신 · Cargo 의존성 오프라인`, 영어 `Local network · Cargo dependencies offline`이다. 표시 내용은 요청된 정책이며 실제 traffic이나 실패 원인으로 해석하지 않는다.

## 검증 근거

| 검사                           | 결과          | 의미와 한계                                                                                                                                           |
| ------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 관련 core 단위 검사 51개       | 통과          | 공통 개발 정책 10개, Cargo config 12개, Rust toolchain 19개, Cargo cache 7개, Rust command environment 3개.                                           |
| protocol 지침 검사 8개         | 통과          | 기존 작업·Goal·폴더·문자 수 조건을 유지했다.                                                                                                          |
| renderer 진단 단위 검사 12개   | 통과          | 원인/상태·프로젝트 범위와 Cargo KO/EN 표시.                                                                                                           |
| 패키지 타입·Svelte 검사        | 통과          | protocol/core/MCP/desktop/main/renderer. Svelte 오류·경고 0개.                                                                                        |
| 최종 변경 코드 검사            | 통과          | TypeScript/MJS Prettier·ESLint와 Python AST 문법 검사.                                                                                                |
| isolated Chromium UI           | 통과          | Cargo KO/EN, 480px, 기존 실패 선택·필터·상태·프로젝트 격리 흐름. pageErrors는 비어 있다. bridge fixture이며 실제 Electron native 입력 검사는 아니다.  |
| 실제 Python·Rust HTTP 서버     | 통과          | 각각 background 실행, HEAD 상태와 GET의 정확한 본문, 취소 후 terminal 상태 및 listener 닫힘을 확인했다. 기존 generic shell 경로에서 실행했다.         |
| Rust fixture 컴파일 및 HTTP    | 통과          | HTTP·PTY·hardlink 3개가 포함된 Rust test binary를 컴파일했다. 정확한 이름으로 HTTP 1개만 실행하여 통과했고 나머지 2개는 실행하지 않았다.              |
| 현재 MCP 기능 진단             | 필수 3개 실패 | HTTP·symlink·libproc 자기 프로세스 검사는 통과했다. PTY·descriptor·hardlink는 EPERM으로 실패해 스크립트가 exit 1을 반환했다. 선택적 ps 실패는 별도다. |
| 새 profile의 native suite 일부 | 초기화 실패   | 선택한 Python PTY와 Cargo 2개 모두 sandbox_apply EPERM. -t로 제외한 7개를 통과나 unsupported-platform skip으로 합산하지 않는다.                       |
| staged runtime 빌드            | 통과          | 원본 dist를 교체하지 않고 4개 package와 desktop main/preload/renderer/daemon identity를 생성했다.                                                     |

단위 검사 합계는 71개다. native suite는 9개 Vitest case이며 그중 Cargo case가 별도의 Rust 검사 3개를 실행한다. 위에 남긴 초기화 실패 때문에 전체 native 기능이나 별도 테스트 프로젝트 111개를 통과했다고 선언할 수 없다. 실패한 중간 실행은 이후 통과 결과와 구분했다.

Rust 컴파일에는 xcrun의 OS 임시 cache 생성 EPERM 경고가 남았지만 컴파일·HTTP 실행은 성공했다. 문서화된 no-cache 환경변수로도 경고가 사라지지 않아 그 변수를 해결책으로 추가하거나 OS 임시 영역 전체 쓰기를 허용하지 않았다. Vite의 기존 큰 chunk 경고도 남아 있다.

## 새 실행본

빌드 입력 377개를 고정해 별도 runtime을 생성했고, 완료 뒤 원본 source fingerprint가 동일함을 확인했다. manifest를 다시 읽어 빌드 결과와 비교하고 compiled protocol의 `development-runtime-1`도 확인했다. 이 결과는 해당 실행본을 현재 앱이 사용하고 있다는 증거가 아니다.

```text
candidate: node_modules/.cache/chatsplice-runtime-hc8uoS
built_at: 2026-10-20T12:25:23.299Z
source_sha256: 715c4ffdcf8d928f4c8512eb2f490d3a459210eade723d7d6eba2a57d4ccc523
desktop_build_id: 5c4b515064a242167ade7547219b7f67b8d7700dd120eeed8456343f656ce24b
daemon_build_id: b00fe0fcef885c53e588c6cbd72dcff4370f1228627fe675146950d4aaff0ffb
tool_schema_digest: 7dd159e73f98e5388807c45b24be4fd36de1315b441c18655fbc954e75ce4bbe
descriptor: 0.0.14
tools: 24
```

이 runtime은 원본 checkout의 설치된 의존성을 공유하는 로컬 실행본이다. 독립 배포 패키지나 설치된 앱 업데이트를 생성한 것은 아니다.

## 남은 재검증과 정상 적용

1. 지원되는 Node·Python·Rust가 있는 일반 macOS 터미널의 원본 저장소에서 아래 native suite를 실행한다. 현재 관리 MCP shell 안에서 재실행하면 중첩 sandbox 초기화 제한을 다시 만날 수 있다. 9개 case가 실제로 실행됐는지 확인하고, 초기화·PTY·link 경계 실패를 통과로 처리하지 않는다.

   ```sh
   node scripts/check-workspace-folders.mjs unit core src/project/development-capabilities.test.ts
   ```

2. native 결과를 확인한 뒤 진행 중 작업과 미저장 편집을 마무리하고 기존 앱/daemon을 정상 종료한다. 원본 저장소에서 새 실행본을 시작한다.

   ```sh
   pnpm --dir node_modules/.cache/chatsplice-runtime-hc8uoS start
   ```

3. 연결 관리에서 새 desktop/daemon identity와 execution contract를 확인한다. 도구 정의가 오래된 경우 갱신하되, 정의 새로고침만으로 실행 코드를 교체했다고 가정하지 않는다. 현재 public job/environment 도구에는 active build/run identity가 노출되지 않는다.

4. 새 앱의 같은 관리 실행 경로에서 실제 기능 진단을 실행한다. 해당 경로에 파일이 있는 ChatSplice 프로젝트에서는 다음 명령을 사용할 수 있다.

   ```sh
   python3 scripts/diagnose-development-runtime.py --include-system-ps
   ```

5. 정확히 연결된 별도 테스트 프로젝트에서 기존 111개 검사를 같은 기준으로 다시 실행한다. HTTP/PTY/descriptor/link fixture가 시작되는지 먼저 확인하고, 남은 assertion·코드 결함과 필수 프로세스 소유권 검증 오류를 분리한다. 다른 경로의 shell 성공으로 전용 Cargo나 별도 테스트 프로젝트 기능 검사를 대체하지 않는다.

소유한 Python/Rust 테스트 서버는 모두 취소하고 port 닫힘을 확인했다. 사용자 앱/daemon은 강제로 종료하지 않았고 commit/push도 수행하지 않았다.
