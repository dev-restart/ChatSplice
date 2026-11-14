# Security boundaries

현재 보안 경계는 [current-contract.md](current-contract.md)와 [model-free-execution.md](model-free-execution.md)를 기준으로 합니다. 보안 문제는 [비공개 신고 안내](../SECURITY.md)를 따르세요.

## Data sent to ChatGPT

MCP 응답의 파일 내용·경로, 명령 출력, 로컬 웹 페이지의 텍스트·스크린샷이 요청 처리에 사용되도록 ChatGPT에 전달됩니다. ChatGPT 웹 세션과 로컬 브라우저 검증 세션은 분리되어 있습니다. ChatSplice는 ChatGPT 대화 본문이나 로그인 쿠키를 읽어 도구 응답에 넣지 않습니다. 연결하기 전에 폴더의 데이터 공유 권한을 확인하고, 회사 자격 증명이나 고객 데이터가 없는 연습용 폴더로 먼저 검증하세요.

## Active boundary

- ChatGPT remote view는 sandboxed `WebContentsView`이며 preload, Node, filesystem, Electron IPC, daemon control을 받지 않습니다. MCP HTTP는 loopback에만 bind하고 인증 token은 owner-only storage와 local transport에만 둡니다. ChatGPT DOM scraping과 private endpoint 사용은 금지합니다.
- 각 project-scoped call은 정확한 `workspace_id`와 immutable `workspace_binding`을 확인합니다. canonical path 아래의 regular UTF-8 파일만 다루며 traversal, absolute path, symlink/hard-link escape, secret/control path, overwrite, recursive delete를 거부합니다. `fs.edit`와 full replacement/rename/delete는 full-file SHA-256 read를 즉시 선행해야 합니다.
- `fs.list`/`fs.search`는 depth, entry, file, byte, result caps를 적용하고 symlink를 따라가지 않습니다. 잘린 discovery 결과는 scope를 좁혀 다시 요청하며, 모델의 설명이나 tool card만으로 완료를 판정하지 않습니다.
- `project.run`은 이미 존재하는 root package script(`test`, `lint`, `typecheck`, `check`, `build`)만 받고 macOS `sandbox-exec`, external-network deny와 local 개발 통신 허용, secret-free environment, canonical workspace/private runtime write confinement, timeout/output bound를 적용합니다. `project.git`은 fixed structured command만 사용하고 local 명령은 offline, `push`/`pull`/`fetch`만 검증된 network 경로를 사용합니다.
- `project.exec`의 shell은 Pi SDK `0.84.1` 실행 tooling으로 일반 개발 명령·Python 환경·dependency hook·project `.env` 사용을 허용합니다. 외부 network는 기본 허용하고 `network: local`은 loopback 및 canonical WORKSPACE/작업 전용 RUNTIME의 Unix socket만 허용합니다. 임의 host daemon socket은 허용하지 않습니다. 개인 HOME과 credential 환경을 상속하지 않으며 쓰기는 workspace/private runtime에 제한합니다. shell은 프로젝트 파일에 직접 영향을 줄 수 있고 fs 도구의 full-read/SHA 검사를 자동 적용하지 않습니다. 기존 Node/Cargo/locked install의 경계는 유지합니다. background server는 파일 수정과 병행하지만 root 변경·제거를 cleanup까지 막습니다. Pi/Codex model, provider, OAuth, `AgentSession`, worker dispatch는 없습니다.
- browser 작업은 pinned Playwright가 소유하는 isolated context에서 loopback HTTP(S) 앱만 탐색하고 screenshot·텍스트·selector·console을 반환합니다. ChatGPT browser profile, cookie, 대화에는 연결하지 않습니다. 관리형 Chromium 설치는 기존 공유 browser cache를 정리하지 않습니다. Page 내용은 신뢰할 수 없는 데이터이고 브라우저 결과가 다음 로컬 명령의 권한을 부여하지 않습니다. 이미지·페이지·로그는 개수/크기가 제한된 memory-only 상태이며 종료 시 browser와 background process를 정리합니다.
- `local.prepare_apply`는 `readOnlyHint: false`인 bounded proposal입니다. Electron owner가 private capability로 claim한 뒤 daemon이 canonical-root reservation, SHA/concurrency, partial-failure와 실제 결과를 관리합니다. read-only mode에서는 새 mutation/check/execution/install을 시작하지 않고 기존 결과 조회와 cancellation만 허용합니다. proposal/job/activity history는 memory-only입니다.
- 사용자가 직접 입력하는 xterm/node-pty 터미널은 일반 OS 사용자 권한을 갖는 main-owned session입니다. 프로젝트 root는 시작 위치이며 confinement가 아닙니다. 입력·출력·크기 변경 API는 trusted terminal renderer에만 허용하고 ChatGPT view나 MCP에는 노출하지 않습니다. 터미널 출력으로 링크·클립보드·명령을 자동 실행하지 않으며 앱 종료 시 PTY를 정리합니다. 파일 트리의 기존 비밀 파일·symlink 정책과 MCP 실행 sandbox는 유지합니다.
- terminal surface의 로컬 HTML에만 `style-src 'self' 'unsafe-inline'`을 적용합니다. xterm DOM renderer가 생성하는 글꼴·커서·셀 크기 스타일과 ANSI truecolor 속성에 필요합니다. `script-src 'self'`, `connect-src 'none'`과 다른 로컬 surface의 엄격한 CSP는 유지하며 ChatGPT remote view에는 적용하지 않습니다.

## Owner control and execution links

모든 owner control API는 요청 처리 전에 별도의 private desktop token을 확인합니다. status·workspace 등록·binding·Goal·탭·Tunnel·shutdown도 동일합니다. MCP transport token은 이 owner 권한을 주지 않습니다. Desktop은 token 파일이 없거나 잘못되면 요청을 시작하지 않습니다. 사용자 권한으로 실행되는 로컬 프로세스도 socket 파일 권한만으로 owner UI와 구분되지 않으므로 이 검사를 생략하지 않습니다.

`project.run`과 command 기반 `project.exec`는 실행 전에 workspace regular file의 link count를 metadata로 확인합니다. symlink 대상은 따라가지 않으며 기본 상한은 1,000,000 entries·depth 64·60초입니다. 허용된 쓰기 root 안에서 확인한 실제 link만 셉니다. 외부 또는 미확인 alias·directory/file 변경·점검 오류·한도 초과 시 실행하지 않습니다. `node_modules`에 대한 일괄 예외는 없습니다. 개발 profile에서 job 전용 runtime 내부에만 file-link 예외가 있으며 workspace의 새 hard link는 금지합니다. manifest는 no-follow·inode 확인·실제 byte cap·strict UTF-8을 적용합니다. 다른 OS 프로세스가 점검 후 alias를 만드는 동시 변경까지 kernel 수준으로 보장하지는 않습니다.

## Account and source verification gates

커스텀 MCP 서버 등록, Secure MCP Tunnel, 앱 노출, 쓰기 작업 권한은 OpenAI 계정과 워크스페이스 정책에 따릅니다. 실제 사용할 계정에서 도구 목록을 조회하고 연습용 폴더로 호출을 확인합니다.

## Project settings automation

Electron main의 고정된 UI script는 Project 생성·settings·instructions 필드를 다룹니다. Remote view에는 privileged API를 노출하지 않습니다. 대화 본문·기록·cookie 수집, private endpoint와 자동 메시지 전송은 구현하지 않습니다. 도구가 필요한 메시지에서는 사용자가 입력창에서 MCP 앱을 선택합니다.

ChatGPT 웹 UI가 바뀌면 [사용 안내](onboarding.md#문제-해결)의 수동 연결 경로를 이용할 수 있습니다. 사용 중인 계정의 적용 약관과 워크스페이스 정책을 따르세요.

지침 갱신은 기존 block의 두 identity line과 유일한 marker를 확인합니다. Save가 없거나 비활성·저장 후 재확인 실패·context 변경이면 완료로 기록하지 않습니다. 작성 중인 composer와 다른 dialog, editor, 숨겨진 tab은 자동 갱신 대상이 아닙니다. repository 지침 파일에 private binding을 쓰지 않습니다.

## Distribution boundary

배포는 MIT 소스와 사용자 직접 빌드를 기준으로 하며 CI에서 서명·공증·binary Release·앱 update feed를 운영하지 않습니다. 로컬 unsigned packaging은 선택 사항입니다. [직접 빌드 안내](release-distribution.md)를 따릅니다. MIT 소스 공개와 개인 개발용 Secure MCP Tunnel 연결은 별개입니다. Secure MCP Tunnel은 공개 ChatGPT plugin 배포를 지원하지 않으며 공개 plugin에는 공식 제출 요건의 공개 HTTPS endpoint가 필요합니다. [공식 Tunnel 문서](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)를 따릅니다. packaged app은 root MIT, dependency notices와 Electron/Chromium license를 Resources/licenses에 포함합니다. Pi SDK의 provider 의존성은 설치되어도 runtime이 model을 호출한다는 뜻이 아닙니다.

## Goal storage and cleanup (2026-10-21)

Goal 등록 개수와 lifetime 실행 횟수의 고정 차단을 제거하지만 root/binding/revision·완료 근거·owned job 정리·deadline은 유지합니다. 새 Goal의 0 예산은 횟수 제한 없음을 뜻하며 기존 양수 예산은 명시적인 resume 갱신이 필요합니다. 1 MiB metadata와 최대 32개·약 2 MiB 페이지 응답, receipt 압축 및 요청 해시 ledger를 사용합니다. terminal delete는 완료·취소 기록만 제거하고 미완료 Goal과 프로젝트 파일은 보존합니다. 실제 기존 기록을 업그레이드 중 자동 삭제하지 않습니다.

## Shared development runtimes (2026-10-21)

일반 설치 runtime·library·shim root는 Node/Cargo/root check와 shell에서 읽을 수 있고, 가변 language cache는 검증된 프로젝트별 cache에 둡니다. installed runtime root의 host 쓰기를 추가하지 않습니다. HOME/config는 작업 전용이고 알려진 host credentials는 상속하거나 공개하지 않습니다. 구조화 명령의 Git metadata 읽기는 허용하며 Git write/map/link 및 hook/credential 읽기 제한을 모든 runtime/folder grant 뒤에 둡니다. 추가 폴더가 겹쳐도 뒤의 allow가 앞 폴더 보호를 덮지 않게 합니다.

macOS runtime은 canonical /private/tmp 아래 현재 사용자 소유 0700의 짧은 하위 디렉터리입니다. 생성·검증 실패 시 확인한 같은 빈 디렉터리만 정리하고 전역 tmp 쓰기 권한을 부여하지 않습니다. Python/pip 전용 wrapper는 job 안에서 원래 .venv 경로를 exec하며 Node/Rust 선택을 바꾸지 않습니다. 일반 앱에서의 native 권한 검증은 source test와 별도입니다.
