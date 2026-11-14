# 개발 실행 환경과 Goal 저장 보완 — 2026-10-21

## 상태

소스 구현, 아래 범위의 검사, 별도 실행본 빌드를 완료했다. **현재 실행 중인 앱/daemon에는 적용하지 않았다.** 기존 앱의 실행 정책과 새 소스의 검사 결과를 구분한다. 실제 별도 테스트 프로젝트·별도 음성 프로젝트의 실패 명령은 새 실행본 적용 뒤 다시 확인해야 한다.

현재 계약은 execution `development-runtime-3`, MCP descriptor `0.0.15`, control protocol `4`, 공개 도구 `24`개다. Pi SDK의 모델 없는 로컬 실행 구조는 유지했다. 이번 오류를 모델의 거절이나 Pi SDK 자체 결함으로 확인한 것은 아니다.

## 확인한 문제와 변경

| 영역           | 관찰 또는 원인                                                                        | 구현                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal 저장      | 실행 횟수 예산이 남아 있어도 누적 receipt가 작은 SQLite 문서 한도를 소진할 수 있었다. | 기존 64 KiB 문서를 원본·revision·rowid 보존 방식으로 1 MiB 한도로 이관하고 receipt를 압축한다.                                                      |
| Goal 실행·등록 | lifetime 128회와 프로젝트 32개·전체 256개 제한이 장기 작업을 차단했다.                | 새 Goal은 실행 예산 0, 즉 횟수 제한 없음이 기본이다. 기존 양수 예산은 명시적 resume에서 0으로 해제한다. 등록 개수로 인한 admission 차단을 제거했다. |
| 자식 언어 실행 | Node/Cargo/root check와 shell의 runtime 읽기 범위·PATH·cache 설정이 달랐다.           | 설치된 Node/Python/Rust/Go/Elixir와 manager shim/library root, 프로젝트별 dependency cache 구성을 공유한다.                                         |
| Python 선택    | Node가 선택한 Homebrew bin이 프로젝트 가상환경의 Python보다 앞설 수 있었다.           | 구조화 검사와 root check는 프로젝트 .venv의 Python/pip 명령만 private wrapper로 우선한다. 선택된 Node/Rust는 유지한다.                              |
| Git 감지       | 구조화 검사의 .git 본문 일괄 차단이 저장소 인식을 방해했다.                           | Git metadata 읽기를 허용하고 Git 쓰기·hook/credential 읽기 보호를 모든 runtime/folder 허용 뒤에 적용한다.                                           |
| 로컬 IPC       | local 네트워크 정책이 개발용 Unix socket도 차단했다.                                  | WORKSPACE/RUNTIME 내부 Unix socket bind/connect와 AF_UNIX 생성을 허용한다. host daemon socket은 추가하지 않는다.                                    |
| 임시 경로      | macOS의 긴 TMPDIR 아래 실행 경로가 Unix socket 경로 한도와 충돌했다.                  | 검증된 /private/tmp 아래 짧은 cs-e-/cs-r- 작업 디렉터리를 사용한다. 생성한 작업 폴더만 0700으로 쓰고 전역 tmp 쓰기는 추가하지 않는다.               |

위 원인 중 소스 경로·저장 설계는 직접 확인했다. Python 공유 라이브러리 오류와 별도 테스트 프로젝트 개별 실패가 모두 이 변경만으로 해결되는지는 새 native 실행으로 확인해야 한다.

## 언어·의존성 실행

### 공통 환경

주요 구현은 다음 파일에 있다.

- `packages/core/src/project/development-tools.ts`
- `packages/core/src/project/development-sandbox.ts`
- `packages/core/src/project/project-python-shims.ts`
- `packages/core/src/project/runtime-directory.ts`
- `packages/core/src/project/pi-sandbox.ts`
- `packages/core/src/project/pi-execution.ts`
- `packages/core/src/project/run-task.ts`

Homebrew, Xcode/Command Line Tools, Frameworks, nvm, uv, rustup, pyenv, asdf, mise, Volta 등 설치된 도구의 실행 파일·라이브러리·shim 읽기 root를 공통으로 구성했다. PATH는 검증된 선택 runtime, 프로젝트 환경, 프로젝트 cache bin, 설치된 PATH와 system 경로를 조합하고 상대 경로·제어 문자가 있는 항목과 중복을 제외한다.

명령의 HOME은 작업별 private 디렉터리다. manager root는 필요한 설치 위치를 명시하고 npm/pnpm, pip/uv, Go, Mix/Hex/Rebar, Clang/Swift cache는 검증된 프로젝트 cache 아래에 둔다. 프로젝트 cache는 영구 데이터 저장소가 아니며 OS 임시 영역 정리의 영향을 받을 수 있다.

Python wrapper는 .venv/bin/python, python3, pip, pip3 중 실제로 실행 가능한 항목만 만들고 원래 가상환경 경로를 유지한다. 공백·apostrophe·shell 문자를 포함한 경로와 인자도 그대로 전달한다. Node/Rust wrapper는 만들지 않는다. 따라서 선택된 Node/Rust pin을 변경하지 않고 Node에서 Python 자식을 실행할 수 있다.

일반 shell은 Python/uv/pip, Go, Elixir/Mix, sh/bash 등의 개발·설치 명령을 실행하는 경로다. HTML/CSS/JS는 프로젝트 dev server와 관리형 browser로 확인한다. 전용 install의 구조화 입력은 기존 Node/Rust 범위이며 다른 생태계의 명령은 shell을 사용한다. 패키지 다운로드에는 network enabled 실행을 사용하고 전용 Cargo 검사의 offline/locked 동작은 유지한다.

환경 점검은 Go/Elixir manifest를 포함한 고정 파일 19개와 runtime/manager 17종을 확인한다. 실행 파일 존재 확인은 버전·실행·설치 성공의 근거가 아니다. 없는 runtime을 이번 작업에서 모두 설치한 것은 아니며, 사용자 정의 설치 경로와 실제 dependency 설치는 해당 프로젝트에서 별도로 실행해 확인해야 한다.

### 경로와 Git

허용된 runtime root의 상위 디렉터리는 descriptor 기반 탐색에 필요한 정확한 ancestor 읽기를 제공한다. 이로써 형제 디렉터리 전체의 본문·쓰기를 허용하지 않는다. /private/etc/hosts 읽기, private runtime PTY/link fixture 지원과 Rust toolchain 선택은 이전 development-runtime-2의 보완을 포함한다.

구조화 검사의 Git 보호는 main workspace와 함께 사용하는 폴더의 허용 규칙 뒤에 모아서 적용한다. 겹치는 상위 폴더나 공통 runtime root의 허용이 다른 폴더의 .git/secret 보호를 다시 풀지 않도록 순서를 검증했다. 일반 개발 shell의 기존 Git 동작은 유지한다.

짧은 macOS 임시 폴더는 canonical parent, parent 소유권·sticky 조건, child UID·0700·유형·symlink·inode를 확인한다. 검증 실패 시 같은 inode/UID의 검증된 빈 폴더만 rmdir하며 미확인 경로를 재귀 삭제하지 않는다.

## Goal 동작

### 실행 횟수와 저장

새 Goal의 max_executions 기본값은 0이다. 0은 실행 횟수 예산이 없다는 뜻이다. 기존 Goal에 저장된 양수 예산은 보존하며 사용자가 같은 Goal을 재개하면서 0을 지정하면 해제된다. executions_used는 누적 기록으로 유지한다.

최근 32개 receipt와 실행 중 receipt, 현재 criterion/evidence에 필요한 receipt 및 criterion별 최신 기록을 보존한다. 오래된 상세 receipt를 정리해도 별도 SQLite request-hash ledger가 같은 요청의 중복 실행을 막는다. 문서와 ledger 교체는 동일 transaction에서 처리하며 재시작 뒤에도 중복 방지가 유지된다. 오래된 receipt가 늦게 끝나더라도 더 최근 criterion 실패를 덮어써서 통과로 만들지 않는 회귀 검사를 추가했다.

기존 문서의 64 KiB 제약을 1 MiB로 이관하고 등록 개수 32/256 admission cap을 제거했다. 저장 용량 자체를 무제한으로 만든 것은 아니다. 목록은 최대 32개·약 2 MiB 단위이며 total/has_more/next_offset으로 이어서 조회한다. 시작 시 복구도 페이지 단위다.

### UI와 정리

Goal 화면에서 무제한 기본값·양수 예산·재개 시 해제를 표시한다. 서버 갱신은 사용자가 수정하지 않은 재개 예산만 업데이트하고 사용 중인 입력은 보존한다.

완료(completed)·취소(cancelled)된 기록을 개별 삭제하거나 모아서 정리할 수 있다. 확인 후 매번 최신 revision과 소유 작업 종료를 검증한다. active·paused·interrupted는 보존한다. 프로젝트 변경이나 오류가 생기면 중단하고 결과가 불확실한 삭제를 자동 재시도하지 않는다. 삭제 대상은 Goal metadata와 해당 hash ledger이며 프로젝트 소스 파일은 삭제하지 않는다.

실제 사용자의 기존 Goal을 이번에 삭제·재개하거나 실행 예산을 바꾸지 않았다. 활성 daemon의 실제 데이터베이스에도 이번 migration을 적용하지 않았다. migration은 테스트용 SQLite 데이터베이스로 검증했다.

기한, 명령별 timeout, 동시 실행 수, 파일 접근 권한, 완료 근거 검증은 유지된다. Goal을 저장하거나 재개하는 것만으로 새 ChatGPT turn을 만들거나 메시지를 전송하지 않는다. 0 예산은 무기한 자동 실행을 뜻하지 않는다.

## 검증 결과

중복 재실행한 테스트 수를 합산해 전체 수치처럼 제시하지 않는다. 전체 저장소의 모든 검사를 이번 변경 후 재실행한 것은 아니다.

| 범위                                                       | 최종 확인                                                        | 실행 근거           |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ------------------- |
| 공통 runtime/PATH/cache/Python wrapper/짧은 경로/보호 정책 | 6개 파일, 43개 통과                                              | (로컬 실행 ID 생략) |
| 전체 package 타입·renderer Svelte                          | 모두 통과, Svelte 오류 0·경고 0                                  | (로컬 실행 ID 생략) |
| Goal SQLite migration·ledger·등록·삭제                     | 8개 통과                                                         | (로컬 실행 ID 생략) |
| Goal service·예산·압축·늦은 receipt                        | 16개 통과                                                        | (로컬 실행 ID 생략) |
| Goal review/lifecycle/ownership/chat transport             | 선택한 4개 파일 12개 통과                                        | (로컬 실행 ID 생략) |
| Protocol Goal/workflow/environment                         | 선택한 12개 통과                                                 | (로컬 실행 ID 생략) |
| Environment service                                        | 7개 통과                                                         | (로컬 실행 ID 생략) |
| Desktop Goal chat/client/IPC                               | 14개 통과                                                        | (로컬 실행 ID 생략) |
| 인증된 owner/MCP pagination·ownership와 catalog            | 선택한 5개 통과, 나머지 3개 제외                                 | (로컬 실행 ID 생략) |
| 마지막 tool catalog                                        | 3개 통과, network enabled 실행                                   | (로컬 실행 ID 생략) |
| 변경 코드 Prettier/ESLint                                  | 통과                                                             | (로컬 실행 ID 생략) |
| 실제 Chromium Goal UI fixture                              | 통과, pageErrors 없음                                            | (로컬 실행 ID 생략) |
| 별도 runtime 빌드                                          | 통과, manifest·compiled code·desktop/daemon identity 재읽기 일치 | (로컬 실행 ID 생략) |

Chromium 검사는 실제 renderer의 생성·checkpoint·파일 기준·완료·일시정지·재개, 자연어 요청문/이어하기, 복사 실패, 한국어/영어, 무제한 예산, 페이지 이동, 삭제 확인을 검증했다. 37개 fixture에서 14개 완료/취소 기록만 정리하고 8개 active·8개 paused·7개 interrupted를 보존했다. 재개 예산은 서버의 200을 반영하고 사용자가 80을 입력한 뒤 서버가 250으로 바뀌어도 입력 80을 보존했다. owner bridge는 fixture이며 실제 Electron 계정에서 수동 확인한 결과로 표시하지 않는다. 실제 owner HTTP/MCP의 별도 검사는 위 표에 구분했다.

### 실패·미검증을 남기는 항목

- 최종 catalog 검사를 기존 앱의 network local에서 실행했을 때 2개 통과·1개 실패였다. 실패는 인증/목록 assertion 이전의 Unix control socket listen EPERM이다. 실행 근거는 exec_5989ef7c-1236-4c9a-93e7-db7817f9e9cb다. 동일 검사를 공개 shell의 network enabled로 실행해 3개가 통과했다. 이것은 새 local profile이 실제로 적용됐다는 근거가 아니다.
- Goal service 16개를 실행한 당시의 넓은 묶음에는 긴 TMPDIR/Unix socket 문제로 transport fixture 실패도 있었다. 짧은 fixture 경로와 실행 정책을 분리해 desktop/owner/MCP 항목을 다시 검증했다. 당시 전체 묶음을 통과로 기록하지 않는다.
- 실제 native profile의 Node→Python 자식 실행, Git metadata 읽기와 Git 쓰기/hook 차단, scoped Unix socket, 기존 HTTP·PTY·descriptor·symlink/hardlink fixture를 추가·보존했다. 현재 MCP의 중첩 sandbox 초기화 거부 때문에 새 profile의 native 전체 검사는 실행하지 못했다. 짧은 경로 unit의 macOS 선택은 mock으로 검증했고 실제 생성은 기존 허용 TMPDIR에서 검증했다.
- 기존 전용 Cargo fixture는 숫자 loopback HTTP 1개 통과, .nvm ancestor와 hosts/localhost 2개 실패였다. 실행 근거는 exec_341e56ca-2ae7-48b8-b962-2b1c83170ba6이다. 새 daemon을 적용하기 전 같은 별도 테스트 프로젝트 전체 검사를 반복하지 않는다.
- /bin/ps의 자식 실행은 계속 EPERM으로 확인됐다. root 소유 setuid 실행 파일인 점은 확인했지만 정확한 OS 거부 원인을 확정하지 않았다. PATH/read root 보완으로 해결했다고 주장하지 않는다. 필수 process ownership 검증에 대한 별도 지원과 실제 별도 테스트 프로젝트 재검증이 남아 있다.
- xcrun --find clang은 cache 생성 EPERM 경고를 냈지만 exit 0과 실제 clang 경로를 반환했다. cache 경고와 도구 선택 실패를 구분한다. 새로운 cache 환경 변수만으로 경고가 해결된 것으로 기록하지 않는다.
- 진단 중 request_id runtime-xcrun-20261021-probe의 MCP 제출 응답이 장시간 반환되지 않았고 job_id를 받지 못했다. 실행·종료 상태는 미확인이다. 새 request_id로 재제출하지 않았다. 따라서 모든 소유 작업이 0개라고 단정하지 않는다.
- 이번 workspace에는 승인된 두 개의 별도 프로젝트 참조 폴더가 없었다. 두 프로젝트 파일·Goal을 직접 변경하지 않았고 AC-019나 전체 계약 완료를 확인하지 않았다.
- 이전 기록에 남은 protocol schema 안내문 기대값 5개 실패는 이번에 해결/전체 재검증한 항목으로 합치지 않는다. project-instructions.ts의 6000자 계약을 유지했으며 이번 동작 설명을 추가했다가 초과한 변경은 원래 소스로 복원했다.

## 빌드와 활성화

별도 실행본은 아래 위치에 있다.

```text
node_modules/.cache/chatsplice-runtime-…
```

| 항목               | 값                                                               |
| ------------------ | ---------------------------------------------------------------- |
| 빌드 시각          | 2026-10-21 03:47:26 UTC / 12:47:26 한국 시간                     |
| 입력               | 388개 파일, 9,533,328 bytes                                      |
| source SHA-256     | d0a80bc73f0564d55523aa411acd38dfecc805553adeb058723db86d5ed6f485 |
| desktop build ID   | 80e2d80d29197598c939569ae645ac2e26f72755bf77ad36fca4673d4cde4838 |
| daemon build ID    | e3301c92fe289cbbae1e6b907b5c28e62365c6c6b40df46eca4ec5833f86066b |
| tool schema digest | 092482e643c3a24c88964be7ae5b3883e4abb7b81223c704795cba6a806ac6f2 |
| execution contract | development-runtime-3                                            |
| MCP descriptor     | 0.0.15                                                           |

원본 dist와 실행 중인 앱은 교체하지 않았다. candidate의 runtime-candidate.json, desktop identity, compiled protocol, 공통 sandbox, root check를 재읽어 코드와 identity를 확인했다. 이 실행본은 원본 checkout의 설치된 dependencies를 연결하며 배포용 독립 패키지는 아니다. 이후 문서 갱신은 staged source 입력에 포함되지 않아 위 빌드의 코드 identity를 바꾸지 않는다.

진행 중 작업을 정리하고 기존 앱/daemon을 정상 종료한 뒤 일반 macOS 터미널에서 실행한다.

별도로 만든 실행본을 사용하려면 `pnpm build:staged`가 출력한 폴더에서 `pnpm start`를 실행합니다.

도구 목록 새로고침은 앱/daemon 재시작을 대신하지 않는다. 앱을 교체한 뒤 오래된 schema가 보이면 연결의 도구 정의도 갱신하고 실제 advertised descriptor와 execution contract를 확인한다.

### 적용 뒤 재검증 순서

1. 새 daemon의 development-runtime-3 / descriptor 0.0.15와 실행 identity를 확인한다.
2. 일반 macOS 터미널의 새 소스에서 development-capabilities.test.ts 및 관련 native 회귀를 실행한다. 이전 MCP sandbox 안에 다시 sandbox-exec를 중첩해 그 실패를 제품 기능 실패/통과로 대체하지 않는다.
3. 같은 public Cargo 경로에서 cwd scripts/cargo-runtime-smoke의 작은 3개 검사를 먼저 실행한다. .nvm descriptor 탐색, localhost, 숫자 loopback을 구분한다.
4. 별도 음성 프로젝트의 실제 Node→Python/libpython 명령과 별도 테스트 프로젝트의 원래 실패 명령을 해당 프로젝트 binding에서 실행한다. 설치가 필요하면 manifest/lockfile과 설치된 runtime을 확인한 뒤 프로젝트별 환경에 의존성을 설치한다.
5. 기존 Goal을 이어갈 때 같은 ID와 최신 revision/checkpoint를 사용하고 필요한 경우 max_executions=0으로 재개한다. 환경 통과 후 기능 검사를 갱신하며 실패/stale를 완료로 계산하지 않는다.

## 참고

Unix socket profile 구문은 [OpenAI Codex Seatbelt 구현](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs)을 참조했다. Pi를 다른 모델 호출기로 교체하거나 Codex CLI에 실행을 위임하지 않았다.

이전 원인·진단 및 연결된 계약은 다음 문서를 따른다.

- [현재 계약](current-contract.md)
- [MCP 도구](mcp-tools.md)
- [개발 실행 환경 보완](development-runtime-20261020.md)
- [Cargo 잔여 호환성](cargo-runtime-residual-20261020.md)
- [Rust 실행 호환성](rust-execution-compatibility-20261020.md)
- 로컬 진행 기록(`docs/agent-progress.md`)
