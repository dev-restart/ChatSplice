# Current architecture overview (2026-09-30)

이 문서의 현재 구현 기준은 [current-contract.md](current-contract.md)와 [model-free-execution.md](model-free-execution.md)입니다. Desktop/daemon control protocol은 4, MCP descriptor는 0.0.9이며 현재 tool은 22개입니다. 과거 설계는 공개 소스 archive에서 제외되는 `docs/historical/`에 보존합니다.

## Active runtime

ChatGPT Chat이 reasoning과 iteration을 수행하고, ChatSplice의 loopback MCP가 명시적으로 bound된 workspace 안에서 제한된 작업을 실행합니다. MCP server는 `workspace.list`, reference/read 계열, `fs.list`/`fs.search`/`fs.read`/`fs.edit`/`fs.write`/`fs.mkdir`/`fs.rename`/`fs.delete`, `project.run`, `project.exec`/`project.await_exec`/`project.cancel_exec`, `project.git`, `local.prepare_apply`/`local.await_apply`를 제공합니다. 현재 descriptor의 tool 수는 22개입니다.

- 모든 project-scoped 호출은 정확한 `workspace_id`와 immutable `workspace_binding`을 요구합니다. 경로는 canonicalize한 뒤 traversal, symlink/hard-link escape, secret/control path를 거부합니다. discovery는 bounded이고 symlink를 따라가지 않습니다.
- 기존 UTF-8 파일 mutation은 full-file SHA-256 read와 optimistic concurrency를 거치며, rename/delete도 직전 full read를 요구합니다. `fs.write`는 create 또는 guarded full replacement만 허용합니다.
- `project.run`은 root `package.json`의 allowlisted script만 macOS `sandbox-exec`에서 실행하고, `project.git`은 고정된 structured command만 사용합니다. `project.exec`는 Pi SDK `0.84.1`을 local execution tooling으로만 사용하며 Pi/Codex model, provider, OAuth, `AgentSession`, worker를 만들지 않습니다.
- `local.prepare_apply`는 owner-only Electron/daemon 경로가 claim하고 적용하는 bounded proposal입니다. read-only 상태는 새 mutation·check·execution·install을 막으며, 결과는 실제 상태와 affected-file re-read로 확인합니다. proposal·job·history는 memory-only이고 restart recovery를 보장하지 않습니다. execution job summary는 최대 100개, MCP activity는 workspace당 최대 100개·global listing 최대 500개입니다.

Electron은 local renderer와 ChatGPT remote view를 분리합니다. ChatGPT view에는 preload, Node, filesystem, IPC, daemon control 권한이 없습니다. 하단 xterm/node-pty 터미널은 사용자 수동 입력 전용이며 일반 사용자 권한으로 등록 프로젝트 root에서 시작합니다. MCP 실행 sandbox와는 별개이고 터미널 입출력은 ChatGPT에 전달하지 않습니다. 오른쪽 파일 트리는 필요한 폴더만 탐색하며 기존 경로·비밀 파일 정책을 유지합니다. 패널 크기는 저장하고, 터미널 세션·작업 기록은 memory-only입니다.

Secure MCP Tunnel은 authenticated local MCP endpoint를 OpenAI Developer Mode에 연결하는 전달 계층입니다. tunnel-client 자동 설치는 macOS에서만 지원하며, latest release metadata와 SHA-256 checksum을 확인한 versioned binary를 app data 옆에 저장합니다. installer는 global PATH 변경, tunnel 생성, key 생성, workspace 파일 접근을 수행하지 않습니다. 실제 account에서 Developer Mode, Tunnel 권한, app 노출, write action이 가능한지는 local build/test와 별도의 검증 항목입니다.

## Project instructions and editor

짧은 Project 지침은 `packages/protocol/src/project-instructions.ts`에서 생성합니다. 비공개 workspace identity와 MCP 작업 원칙만 포함하고, 작업 시작 시 프로젝트의 `AGENTS.md`와 존재하는 `docs/design-guidelines.md`를 읽도록 안내합니다. 파일 지침을 바꾼 뒤에도 binding은 그대로입니다.

연결된 Project의 유휴 ChatGPT 탭은 최신 지침을 자동 확인합니다. 기존 block의 workspace ID와 binding이 모두 일치하고 marker가 하나일 때만 그 block을 교체하며 사용자 지침은 보존합니다. Save를 클릭한 뒤 settings를 다시 열어 일치하는 저장 내용을 확인해야 완료입니다. editor·다른 tab·입력·다른 dialog·navigation이 활성화되면 중단하며 UI 불일치는 수동 경로로 남깁니다. 성공 hash와 실패 cooldown은 bounded session memory만 사용합니다. remote view는 갱신을 위해 reload하지 않습니다.

가운데 첫 탭은 ChatGPT, 이후 탭은 CodeMirror 수동 편집입니다. project 전환은 draft와 undo를 유지하고 파일 트리·terminal root를 함께 전환합니다. 저장은 owner-only daemon API와 full-file SHA 검증을 사용합니다. remote ChatGPT에는 editor/terminal IPC나 내용이 전달되지 않습니다.

## Automatic Tunnel lifecycle

Tunnel ID·Organization ID·runtime key를 한 번 설정하고 automatic start를 켜면 앱 시작과 설정 갱신 때 실행합니다. macOS에서 client가 누락되면 공식 binary/checksum 설치 경로로 복구합니다. launch/exit 오류는 credential-free 상태로 표시하고 2–30초 backoff로 재시도하며 Stop·설정 변경·종료가 이전 재시도를 무효화합니다. 빌드만으로 앱이 실행되지는 않으며 `pnpm dev`, `pnpm start` 또는 설치한 앱을 열어야 합니다.
