# 개발 작업 사용 안내

ChatSplice 0.0.2는 GPT Web이 파일을 수정하고, 개발 명령을 실행하고, 서버를 켜서 로컬 웹 화면을 확인하는 흐름을 제공합니다. ChatGPT가 다음 작업을 판단하고 MCP로 요청하면 앱의 daemon이 실행합니다. Pi SDK는 명령 실행에, Playwright는 browser 검증에 사용됩니다. 별도 모델 API key는 필요하지 않으며 ChatGPT 계정의 사용량과 도구 권한은 그대로 적용됩니다.

## 준비와 업그레이드

macOS 13 이상과 Apple Silicon을 지원합니다. [직접 빌드 안내](release-distribution.md)에서 소스 실행과 개인 unsigned packaging 방법을 확인하세요. 소스 실행은 Node 22.19 이상과 pnpm 10.33.2가 필요하며 `.nvmrc`는 Node 24를 선택합니다.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm dev
```

프로젝트 작업에 필요한 toolchain은 해당 언어에 맞게 준비합니다. Node 프로젝트는 Node와 npm/pnpm, Python 프로젝트는 Python 또는 uv, Rust 프로젝트는 Rust/Cargo와 SDK/linker가 필요합니다. Python·shell 명령은 별도 외부 Node가 없어도 실행됩니다. Finder에서 실행한 앱의 `PATH`가 terminal과 다르면 필요한 명령을 찾지 못할 수 있습니다. 소스 개발 중에는 toolchain이 준비된 terminal에서 `pnpm dev`로 실행하고, 명령 실패 시 작업 로그를 확인하세요.

기존 사용자는 진행 중인 작업을 마무리하고 미저장 파일을 저장한 뒤 앱을 종료·교체합니다. 기존 프로젝트를 다시 등록하거나 binding을 새로 만들 필요는 없습니다. ChatGPT에 등록한 MCP 앱의 도구 목록을 다시 검색해 descriptor `0.0.13`을 반영하고, Project 지침의 ChatSplice 블록을 갱신한 다음 새 Project 채팅에서 사용합니다. Control protocol은 `4`, 도구는 `24개`, 현재 execution contract는 `goal-security-2`입니다.

[계정·Tunnel 연결 안내](onboarding.md)를 마친 뒤 해당 메시지의 composer에 **ChatSplice MCP** pill이 보이는지 확인합니다. `Local MCP`로 등록한 기존 사용자는 그 이름을 유지할 수 있습니다. 계정에서 실제로 허용하는 도구만 호출할 수 있습니다.

## 작업 요청과 결과 확인

로컬 폴더를 등록하고 연결된 ChatGPT Project에서 목적과 확인 기준을 함께 요청합니다.

```text
이 프로젝트의 실행 방법과 AGENTS.md를 먼저 확인하세요.
필요한 프로젝트 의존성을 설치하고 개발 서버를 실행하세요.
요청한 화면을 수정한 뒤 기존 검사와 실제 browser 조작으로 확인하세요.
desktop과 mobile 화면, 실행 로그, 남은 문제를 근거로 보고하세요.
검증이 끝나면 이번에 실행한 서버를 종료하세요.
```

ChatGPT는 알려진 파일을 `fs.read`로 읽고 SHA를 확인한 뒤 수정·재읽기합니다. 실행은 `project.exec`가 즉시 반환한 `job_id`를 `project.await_exec`로 조회합니다. 일반 작업은 종료 상태와 exit code를 확인하고, 서버는 실행 로그와 실제 응답을 확인한 다음 계속 수정·검사합니다. `running` 상태의 서버를 완료된 검사로 보고하지 않습니다.

개발 명령인 `shell`은 프로젝트 `.env`, Python 환경과 설치 후처리를 사용합니다. `npm install`처럼 후처리가 필요한 설치에는 이 경로를 씁니다. `install`의 구조화된 Node/Rust 경로는 기존 lockfile 복원과 제한된 설치 정책을 유지합니다. `resolve`는 lockfile만 갱신하므로 그 뒤 별도 `locked` 설치가 필요합니다.

원격 DB와 프로젝트 `.env`가 필요한 개발 명령은 `project.exec`의 `shell`로 실행합니다. 외부 network가 필요하면 `network: "enabled"`를 사용합니다. `project.run`과 구조화된 Node/Cargo 검사는 network/secret 제한을 유지하므로 원격 DB 작업을 위한 대체 경로가 아닙니다. 실행 가능 여부와 별개로 DB 적용 대상·사용자 범위를 확인하고, 상태 조회 뒤 명시적으로 요청된 적용만 수행합니다.

`goal-security-2`에서는 esbuild처럼 모든 hard-link 경로가 등록 workspace 내부에 있는 설치 파일을 허용합니다. 외부 alias나 점검할 수 없는 link는 계속 거부하고 오류에 허용되는 상대 경로를 표시합니다. 이 변경은 앱/daemon의 실행 코드에 있으므로 진행 중 작업을 마무리하고 정상 종료한 뒤 새 빌드로 재시작해야 합니다. tool 목록 새로고침만으로 실행 중 코드가 바뀌지 않습니다.

Browser는 프로젝트마다 독립적인 context를 사용합니다. `setup`으로 pinned Chromium을 준비하고, 서버의 loopback HTTP(S) 주소를 `open`한 뒤 화면에 나타난 selector로 `fill`, `click`, `press`를 수행합니다. `snapshot`은 텍스트·selector·console과 screenshot을 반환합니다. SPA가 전환 중이거나 데이터를 불러오는 중이면 새 snapshot에서 필요한 화면 상태가 나타났는지 확인합니다. `open`의 width/height로 mobile viewport를 확인할 수 있습니다. Preview에서는 service worker와 다운로드·popup을 제한하므로 PWA/offline 검증은 별도로 수행합니다.

실행 콘솔의 작업기록에서 명령, 작업 폴더, 로그, 종료 코드와 취소 상태를 확인합니다. MCP 실행 기록과 사람이 사용하는 Terminal은 별개의 기능입니다. Terminal 입력·출력은 ChatGPT에 전달되지 않습니다.

## 여러 프로젝트를 함께 실행

한도는 앱 전체에 적용됩니다.

| 구분                      | 최대 | 동작                                                                 |
| ------------------------- | ---: | -------------------------------------------------------------------- |
| 일반 실행 및 browser 작업 |    8 | 서로 독립된 root에서 병렬 실행                                       |
| background 서버           |   12 | 일반 작업과 별도 실행 pool                                           |
| 열린 browser 세션         |   12 | 프로젝트별 cookie/storage 분리                                       |
| 대기·실행 중 job 합계     |   64 | 실행 슬롯이 없으면 대기, 전체 admission 한도에 도달하면 새 제출 거부 |

동일하거나 겹치는 root의 일반 명령·파일 변경은 순차 처리합니다. Background 서버를 실행한 상태에서는 파일 수정과 검사를 병행할 수 있습니다. 같은 저장소를 서로 독립적으로 수정하려면 사용자가 별도의 worktree를 준비해 등록합니다. ChatSplice는 worktree를 자동 생성하지 않습니다.

취소는 해당 프로젝트의 정확한 job만 대상으로 합니다. `cancelling` 이후 최종 cleanup 결과를 확인하세요. 이미 저장한 파일과 설치된 의존성은 취소로 되돌아가지 않습니다. 로그·job·browser 상태는 메모리에서 관리되며 앱 종료·재시작을 넘어서 복원되지 않습니다. 최대 timeout은 24시간입니다.

## 자동 작업의 범위

ChatGPT가 도구 호출을 이어가는 동안 수정 → 실행 → 오류 확인 → 수정 → 웹 확인을 반복할 수 있습니다. Background 작업은 채팅 응답이 끝나도 설정한 timeout까지 실행할 수 있습니다. 새로운 추론 턴은 ChatGPT 대화가 이어져야 합니다. 앱은 메시지를 자동 전송하거나 사용량 제한을 우회하지 않습니다.

현재 새 실행기의 로컬 통합 검증, 실제 프로젝트 검사와 패키지 검증 결과는 [검증 기록](developer-execution-verification.md)에 있습니다. 새로운 계정에서의 도구 discovery·write action·Tunnel 호출은 실제 계정에서 별도로 확인합니다.
