# Secure MCP Tunnel 연결

이 문서는 ChatSplice의 현재 managed Tunnel 흐름과 수동 client 경로를 설명합니다. ChatGPT Developer Mode와 Secure MCP Tunnel은 OpenAI account·workspace 정책 및 권한에 따라 실제 노출 여부가 달라집니다. 아래 절차가 현재 계정에서 가능하다는 것을 요금제 이름만으로 가정하지 말고, target account의 Developer Mode·Tunnel·실제 tool call로 확인하세요.

공식 참고 문서: [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode), [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Developer Mode Help Center](https://help.openai.com/en/articles/12584461).

## 1. 앱과 로컬 MCP 시작

처음 설치는 [Getting started](getting-started.md)의 `nvm use`, `pnpm install --frozen-lockfile`, `pnpm dev` 순서를 따릅니다. 이후 source 변경 없이 기존 build를 다시 열 때는 `pnpm start`, source를 변경한 뒤에는 `pnpm dev`를 사용합니다. `nvm use`는 현재 Node 버전이 repository 기준과 다를 때, dependency 설치는 dependency 선언이나 lockfile이 바뀌었을 때만 다시 필요합니다.

가운데 ChatGPT 화면에 로그인하고, 왼쪽 상태에서 `chatspliced`와 local MCP가 준비되었는지 확인합니다. ChatSplice의 MCP endpoint는 loopback에만 열리며 매 실행 시 local port가 달라질 수 있습니다.

## 2. OpenAI Platform에서 준비할 값

OpenAI Platform의 **Settings → Organization → Tunnels**에서 Tunnel을 만들거나 기존 Tunnel을 선택합니다.

- Tunnel을 사용하는 Platform organization과 target ChatGPT workspace를 association에 포함합니다. Platform organization만 association하면 enterprise workspace에서 보이지 않을 수 있습니다.
- Tunnel을 만들거나 수정하려면 `Tunnels Read + Manage`, tunnel을 실행하거나 ChatGPT app 생성 시 선택하려면 `Tunnels Read + Use`가 필요합니다.
- Tunnel ID(`tunnel_…`)와 Organization ID(`org-…`)를 복사합니다.
- **Settings → Organization → API keys**에서 runtime API key를 준비합니다. 이 key는 Tunnel control plane 인증용이며 repository, Project instructions, shell history에 기록하지 않습니다.

OpenAI 문서의 최신 `tunnel-client` release 링크는 특정 버전에 고정하지 말고 [latest public release](https://github.com/openai/tunnel-client/releases/latest)를 사용합니다.

## 3. tunnel-client 설치

ChatSplice는 macOS에서만 자동 설치를 제공합니다. **Connection management**에서 Tunnel ID와 Organization ID를 입력하고 저장할 때, 기존 실행 파일을 찾지 못하면 다음 작업을 수행합니다.

1. `https://api.github.com/repos/openai/tunnel-client/releases/latest`에서 최신 release metadata를 받습니다.
2. 현재 macOS architecture에 맞는 `tunnel-client-<version>-darwin-arm64.zip` 또는 `darwin-amd64.zip`과 해당 release의 `SHA256SUMS.txt`를 받습니다.
3. OpenAI가 공개한 SHA-256과 archive를 비교한 뒤 압축을 풉니다.
4. app data 디렉터리의 sibling `tunnel-client/<version>/tunnel-client`에 versioned executable을 저장하고 실행 권한을 설정합니다.

이 경로는 global install이나 `PATH` 변경을 하지 않고, OpenAI Tunnel을 만들거나 runtime API key를 발급하지도 않습니다. 이미 감지된 executable이 있으면 다운로드하지 않고 기존 경로를 사용합니다. 현재 자동 설치 오류는 unsupported platform, network error, checksum mismatch, extraction failure로만 표시됩니다.

macOS 외 환경이나 자동 설치가 지원되지 않는 환경에서는 Platform download 또는 [OpenAI 공식 release](https://github.com/openai/tunnel-client/releases/latest)에서 client를 직접 설치하고, **Advanced tunnel settings → Tunnel client path**에 실행 파일의 전체 경로를 입력한 뒤 저장합니다. 설치한 binary의 실제 CLI는 버전별로 다를 수 있으므로 `tunnel-client help quickstart`로 확인합니다.

## 4. ChatSplice managed 연결

1. **Connection management → Advanced tunnel settings**에서 Tunnel ID와 Organization ID를 저장합니다. macOS에서는 위 자동 설치가 이 저장 동작 중 수행됩니다.
2. **Register**를 눌러 runtime API key를 native secure prompt에 입력합니다. ChatSplice는 Electron `safeStorage`의 macOS Keychain 보호를 사용해 key를 암호화 파일로 저장하고 renderer, log, SQLite 설정에는 평문으로 넣지 않습니다.
3. **Run checks**를 누릅니다. ChatSplice는 고정된 `tunnel-client doctor --explain`을 실행하고 출력 자체는 renderer로 전달하지 않습니다. 이 점검은 tunnel을 시작하거나 중지하지 않습니다.
4. **Start tunnel when the app starts**는 기본으로 켜져 있습니다. key 등록 직후, 이후 앱 실행과 연결 설정 갱신 때 자동으로 시작합니다. 꺼둔 경우 **Start**를 누릅니다. managed 경로는 `tunnel-client run`을 실행하면서 현재 local MCP URL, Tunnel ID, Organization ID, runtime API key, local token-file header를 전달합니다.
5. 상태가 ready가 되면 ChatSplice의 loopback MCP와 Tunnel client의 `/readyz` 및 local admin 상태를 기준으로 준비 여부를 표시합니다.

다른 터미널에서 `tunnel-client`가 이미 실행 중이면 ChatSplice는 이를 external tunnel로 표시할 수 있습니다. managed 연결을 사용할 때는 먼저 외부 process를 종료하세요. 앱을 재시작하면 local MCP URL이 바뀔 수 있으므로, client를 수동 실행하는 경우에도 현재 상태에 표시된 URL을 사용해야 합니다.

## 5. 수동 client 경로

직접 client를 실행해야 한다면 먼저 vendor CLI와 profile 구성을 확인합니다.

```bash
tunnel-client help quickstart
```

OpenAI 공식 quickstart의 HTTP MCP 설정을 사용하되, `--mcp-server-url` 또는 동등한 설정에는 ChatSplice가 현재 표시한 `http://127.0.0.1:<port>/mcp`를 지정해야 합니다. ChatSplice local authentication을 위해 `MCP_EXTRA_HEADERS`에는 아래 형식의 token-file reference가 필요합니다.

```text
x-chatsplice-token: file:<ChatSplice data directory>/run/mcp-token
```

runtime API key는 `CONTROL_PLANE_API_KEY`, Tunnel ID는 `CONTROL_PLANE_TUNNEL_ID`로 client에 전달합니다. key와 token의 실제 값은 command line, profile, 문서에 literal로 쓰지 않습니다. 수동 client는 app discovery와 tool call이 끝날 때까지 실행 중이어야 하며, loopback admin endpoint가 응답하고 MCP URL이 현재 app URL과 일치해야 ChatSplice가 ready로 표시합니다.

## 6. ChatGPT Developer Mode app 등록

1. ChatGPT web의 **Settings → Security and login**에서 Developer Mode를 활성화합니다. 조직 workspace에서는 admin 정책과 RBAC가 추가로 필요할 수 있습니다.
2. ChatGPT **Plugins** 화면에서 **+**를 눌러 developer-mode app을 생성합니다.
3. Connection에서 **Tunnel**을 고르고, 목록에서 association된 Tunnel을 선택하거나 정확한 Tunnel ID를 붙여 넣습니다.
4. **Scan Tools**가 끝나면 app을 생성합니다. 현재 ChatSplice server의 tool 목록은 [MCP tools](mcp-tools.md)에 있는 22개 계약을 기준으로 합니다.
5. 새 chat을 열고 composer의 app picker에서 ChatSplice MCP app(연결 관리에서 설정한 앱 이름)을 선택합니다. account UI에 따라 **+ → Developer mode** 등으로 보일 수 있으므로 선택된 app pill을 확인합니다. 호출할 때 목적 tool과 exact `workspace_id` 및 `workspace_binding`을 명시합니다.

Developer Mode app의 action은 설정 및 workspace 승인 상태에 따라 달라질 수 있고, write action은 ChatGPT가 confirmation을 요구할 수 있습니다. 앱의 instruction template·표시 이름·MCP app 이름이 바뀌면 연결된 Project의 유휴 탭에서 생성 지침이 자동 갱신됩니다. 도구 catalog 변경은 별도로 app의 tools를 refresh해야 합니다. 자동 갱신이 지원되지 않거나 기존 identity가 다른 경우 수동으로 합친 뒤 저장하고, 새 Project chat에서 확인합니다. `Scan Tools` 성공, tunnel ready, 또는 Project instruction 저장만으로 현재 message의 app 선택이나 write capability가 증명되지는 않습니다.

## 7. 현재 실행 모델과 점검 경계

`project.exec`, `project.await_exec`, `project.cancel_exec`는 `@earendil-works/pi-coding-agent@0.84.1` SDK를 bounded Node/Cargo/install 실행 adapter로 사용합니다. 별도 Pi/Codex model, provider, OAuth, `AgentSession`, coding worker는 생성하지 않습니다. direct `fs.*`, `project.run`, `project.git`, `local.prepare_apply`가 현재의 file·check·mutation 경계입니다.

`doctor --explain`과 `/readyz`는 local configuration과 tunnel transport readiness를 확인합니다. ChatGPT가 실제 app action을 선택했는지 확인하려면 새 chat에서 disposable workspace에 `workspace.list` 또는 알려진 파일의 `fs.read`를 실제로 호출하고 ChatSplice activity를 다시 확인해야 합니다.

## 문제 해결

- 자동 설치가 network error이면 연결을 확인하고 설정 저장을 다시 시도합니다. checksum mismatch나 extraction failure가 반복되면 공식 latest release에서 binary를 받아 full path를 직접 지정합니다.
- `tunnel_client_not_found`이면 Advanced tunnel settings의 path가 실행 파일을 가리키는지 확인합니다.
- `tunnel_doctor_failed`이면 Tunnel ID, Organization ID, runtime API key, Platform association, `Tunnels Read + Use`를 확인합니다. runtime key를 문서나 log에 복사하지 않습니다.
- Tunnel이 ready인데 ChatGPT에서 tool이 호출되지 않으면 app의 Tunnel association, Developer Mode 권한, current composer의 MCP app 선택, frozen tool snapshot을 순서대로 확인합니다.

## 8. Project 지침과 자동 실행

Project instructions에는 생성된 private binding과 핵심 MCP 원칙만 둡니다. 상세 프로젝트 규칙은 `AGENTS.md`, 디자인 규칙은 `docs/design-guidelines.md`에 저장하고 ChatGPT가 작업 시작 시 MCP로 읽습니다. 이 파일들에는 private binding이나 credentials를 저장하지 않습니다. 앱이 만든 marker block만 자동 교체하며 그 밖의 사용자 지침은 보존합니다. Save가 활성화되어 있고 저장 후 다시 연 settings의 내용이 일치해야 갱신 완료입니다.

입력 중이거나 editor·다른 dialog·다른 tab이 활성화되면 자동 갱신을 미룹니다. 지침을 바꾼 뒤 기존 대화에 소급 적용됐다고 가정하지 말고 해당 Project에서 새 대화를 시작합니다.

`pnpm build`는 빌드만 합니다. 개발 중에는 `pnpm dev` 또는 빌드 후 `pnpm start`, 설치 후에는 ChatSplice 앱을 열어야 daemon과 Tunnel이 실행됩니다. 앱 종료·컴퓨터 sleep·네트워크 단절 중에는 연결이 유지된다고 보장할 수 없습니다. 최초 Tunnel 생성·권한·key 발급·ChatGPT MCP app 등록은 계정 소유자의 설정이 필요합니다. Secure MCP Tunnel은 private 개발 연결을 지원하며 공개 plugin 배포와는 별개입니다.
