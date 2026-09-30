# Current security overview (2026-09-30)

현재 보안 경계는 [current-contract.md](current-contract.md)와 [model-free-execution.md](model-free-execution.md)를 기준으로 합니다. 과거 위협 모델과 worker/OAuth 설계는 공개 source archive에서 제외되는 `docs/historical/`에 보존합니다.

## Active boundary

- ChatGPT remote view는 sandboxed `WebContentsView`이며 preload, Node, filesystem, Electron IPC, daemon control을 받지 않습니다. MCP HTTP는 loopback에만 bind하고 인증 token은 owner-only storage와 local transport에만 둡니다. ChatGPT DOM scraping과 private endpoint 사용은 금지합니다.
- 각 project-scoped call은 정확한 `workspace_id`와 immutable `workspace_binding`을 확인합니다. canonical path 아래의 regular UTF-8 파일만 다루며 traversal, absolute path, symlink/hard-link escape, secret/control path, overwrite, recursive delete를 거부합니다. `fs.edit`와 full replacement/rename/delete는 full-file SHA-256 read를 즉시 선행해야 합니다.
- `fs.list`/`fs.search`는 depth, entry, file, byte, result caps를 적용하고 symlink를 따라가지 않습니다. 잘린 discovery 결과는 scope를 좁혀 다시 요청하며, 모델의 설명이나 tool card만으로 완료를 판정하지 않습니다.
- `project.run`은 이미 존재하는 root package script(`test`, `lint`, `typecheck`, `check`, `build`)만 받고 macOS `sandbox-exec`, network deny, secret-free environment, canonical workspace/private runtime write confinement, timeout/output bound를 적용합니다. `project.git`은 fixed structured command만 사용하고 local 명령은 offline, `push`/`pull`/`fetch`만 검증된 network 경로를 사용합니다.
- `project.exec`는 Pi SDK `0.84.1`의 model-free local execution tooling만 호출합니다. Pi/Codex model, provider, OAuth, `AgentSession`, worker dispatch, arbitrary shell/argv/env는 없습니다. Node script, Cargo task, locked dependency install만 구조화된 입력으로 받으며 install 외 작업은 외부 network를 사용하지 않습니다.
- `local.prepare_apply`는 `readOnlyHint: false`인 bounded proposal입니다. Electron owner가 private capability로 claim한 뒤 daemon이 canonical-root reservation, SHA/concurrency, partial-failure와 실제 결과를 관리합니다. read-only mode에서는 새 mutation/check/execution/install을 시작하지 않고 기존 결과 조회와 cancellation만 허용합니다. proposal/job/activity history는 memory-only입니다.
- 사용자가 직접 입력하는 xterm/node-pty 터미널은 일반 OS 사용자 권한을 갖는 main-owned session입니다. 프로젝트 root는 시작 위치이며 confinement가 아닙니다. 입력·출력·크기 변경 API는 trusted terminal renderer에만 허용하고 ChatGPT view나 MCP에는 노출하지 않습니다. 터미널 출력으로 링크·클립보드·명령을 자동 실행하지 않으며 앱 종료 시 PTY를 정리합니다. 파일 트리의 기존 비밀 파일·symlink 정책과 MCP 실행 sandbox는 유지합니다.
- terminal surface의 로컬 HTML에만 `style-src 'self' 'unsafe-inline'`을 적용합니다. xterm DOM renderer가 생성하는 글꼴·커서·셀 크기 스타일과 ANSI truecolor 속성에 필요합니다. `script-src 'self'`, `connect-src 'none'`과 다른 로컬 surface의 엄격한 CSP는 유지하며 ChatGPT remote view에는 적용하지 않습니다.

## Account and release gates

Developer Mode, Secure MCP Tunnel 권한, app 노출, mutation action은 OpenAI account/workspace와 plan에 따라 달라질 수 있습니다. 공식 문서의 plan 설명만으로 가능하다고 단정하지 않고, target account에서 실제 tool discovery와 bounded invocation을 별도로 확인합니다. local source tests/build는 이 account gate를 대신하지 않습니다.

## Project settings automation

Electron main의 고정된 UI script는 Project 생성·settings·instructions 필드와 composer 첨부 control에만 제한됩니다. remote view에 privileged API는 없지만 main은 이 고정 UI script를 실행할 수 있으므로 대화 열람이 구조적으로 불가능하다고 주장하지 않습니다. 대화 본문·기록·cookie 수집, private endpoint와 자동 메시지 전송은 구현하지 않습니다.

지침 갱신은 기존 block의 두 identity line과 유일한 marker를 확인합니다. Save가 없거나 비활성·저장 후 재확인 실패·context 변경이면 완료로 기록하지 않습니다. 작성 중인 composer와 다른 dialog, editor, 숨겨진 tab은 자동 갱신 대상이 아닙니다. repository 지침 파일에 private binding을 쓰지 않습니다.

## Distribution boundary

MIT 소스 공개와 개인 개발용 Secure MCP Tunnel 연결은 별개입니다. Secure MCP Tunnel은 공개 ChatGPT plugin 배포를 지원하지 않으며 공개 plugin에는 공식 제출 요건의 공개 HTTPS endpoint가 필요합니다. [공식 Tunnel 문서](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)를 따릅니다. packaged app은 root MIT, dependency notices와 Electron/Chromium license를 Resources/licenses에 포함합니다. Pi SDK의 provider 의존성은 설치되어도 runtime이 model을 호출한다는 뜻이 아닙니다.
