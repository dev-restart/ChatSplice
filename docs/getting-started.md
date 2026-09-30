# Getting started

ChatSplice is a macOS desktop shell for a normal ChatGPT session and a private, loopback-only MCP server. ChatGPT remains the conversation and reasoning surface; ChatSplice provides bounded workspace tools and model-free local execution.

The validated development target is macOS Apple Silicon. Windows and Linux are architecture goals, not released platforms.

> This repository is a pre-release working tree. One target ChatGPT account has completed one bounded `project.exec` → `project.await_exec` run through the ChatGPT → Secure MCP Tunnel → Pi execution path; broader action, packaging, and release gates remain. Do not redistribute binaries or publish a fork under the `ChatSplice` name until the gates in [RELEASE_CHECKLIST](../RELEASE_CHECKLIST.md) are complete.

## First checkout and daily use

For the first checkout, or after dependency/lockfile changes, select the repository's Node version and restore the locked workspace dependencies:

```bash
nvm use
pnpm install --frozen-lockfile
pnpm dev
```

`.nvmrc` selects Node 24. Without nvm, use Node.js `>=22.19.0` and pnpm `10.33.2`. Run `pnpm install --frozen-lockfile` only for the first checkout or after changing dependency declarations or `pnpm-lock.yaml`. Use `nvm use` only when the currently selected Node version does not match the repository version. On a later day with no source changes and an existing build, use:

```bash
pnpm start
```

After source changes, `pnpm dev` builds all workspace packages and starts the branded Electron development app. `pnpm build` followed by `pnpm start` performs the same work as two explicit commands. The root build cleans only the known generated output directories (`apps/desktop/dist`, `packages/core/dist`, `packages/mcp-server/dist`, and `packages/protocol/dist`) before compiling; it does not touch source, app profiles, credentials, or workspace data.

## Local workbench

Select a registered project and use the top-right **Terminal** and **Files** buttons. Terminal opens an interactive shell at that project root; **+** creates another tab. Tabs survive hiding the panel and close when explicitly closed or the app quits. Drag any panel divider to resize. The history view retains bounded MCP job output and file activity for this app session.

The Files panel is a lazy, expandable tree with bounded UTF-8 previews. It follows the selected project and rejects symlinks and protected files. The human-operated terminal has normal user permissions, including `cd` and development-server commands; the separate MCP tools retain their sandbox.

## Connect ChatGPT Developer Mode

OpenAI controls Developer Mode, Tunnel access, and MCP action availability. Plan names and local health checks do not guarantee that a target account can invoke a particular read or write action. Check the current account and workspace in the [OpenAI Developer Mode guide](https://developers.openai.com/api/docs/guides/developer-mode), [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), and [Help Center article](https://help.openai.com/en/articles/12584461).

1. In ChatGPT web, enable **Developer mode** under **Settings → Security and login**.
2. In OpenAI Platform **Settings → Organization → Tunnels**, create or select a tunnel and associate it with both the target ChatGPT workspace and the Platform organization. Keep the Tunnel ID, Organization ID, and runtime API key private. Tunnel creation/editing needs `Tunnels Read + Manage`; running or selecting a tunnel needs `Tunnels Read + Use`.
3. Start ChatSplice and sign in to ChatGPT in the center view. In **Connection management**, enter the Tunnel ID and Organization ID and save the configuration.
4. On macOS, ChatSplice installs the official `tunnel-client` automatically when no executable is detected. It fetches the latest `openai/tunnel-client` release metadata and `SHA256SUMS.txt`, selects the current `darwin-arm64` or `darwin-amd64` archive, verifies its SHA-256, and stores a versioned executable next to the app data. This is a per-app install: it does not modify `PATH`, create a tunnel, or create a runtime key. If the automatic install is unavailable, install the official client from Platform or the [latest public release](https://github.com/openai/tunnel-client/releases/latest) and enter its full path in **Advanced tunnel settings**.
5. Choose **Register** for the runtime API key and enter it in the native secure prompt. ChatSplice stores an encrypted file using Electron `safeStorage`, whose encryption key is protected by macOS Keychain. Use **Run checks** to run `tunnel-client doctor --explain`, then use **Start** or enable **Start tunnel when the app starts**. A managed start runs `tunnel-client run` with the current loopback MCP URL and a local token-file header.
6. In ChatGPT's **Plugins** page, choose **+**, create a developer-mode app, choose **Tunnel**, select or paste the Tunnel ID, scan tools, and create the app. In a new chat, open the composer's app picker (for example **+ → Developer mode**, depending on the account UI) and select the MCP app for the message (name it `ChatSplice MCP`, or set the name you chose under Manage connection → ChatGPT app name) that needs local tools. Confirm the selected app pill; menu labels can vary.

The tunnel can be healthy while the current message has no Local MCP app selected. The `doctor` result checks local configuration and the tunnel client preflight; it does not prove ChatGPT app selection or a successful MCP call. Check both the ChatSplice activity/status and a real bounded request in a disposable workspace.

**MCP app name in ChatGPT** is a local matching setting. Enter the exact name of your registered ChatGPT MCP app; saving here does not rename that app or the ChatSplice desktop app. Keep `ChatSplice MCP` if that is the name you registered. `Local MCP` supports existing installations. A name change updates auto-attach matching and the generated Project instructions; supported, idle bound Projects refresh automatically, with manual copy/save as the fallback.

If the app's tool descriptor changes, refresh the app's tools and start a new Project chat. ChatGPT can retain a frozen tool snapshot for an existing app or conversation.

## First workspace

1. Sign in to ChatGPT in the center view.
2. Add a project folder from the ChatSplice sidebar.
3. Let the user-initiated Project setup action create a ChatGPT Project, or choose the manual path.
4. For manual setup, copy the complete binding from ChatSplice and paste it into **Project settings → Project instructions**, then save it and mark the local setup complete. Replace the existing ChatSplice marker block instead of appending a duplicate.
5. Select your MCP app (**ChatSplice MCP** by default) from the ChatGPT composer for every message that needs local tools. A Project binding does not attach the app to a message, and typing `@ChatSplice MCP` without selecting its autocomplete item does not invoke it.

On supported UI, automatic setup/update checks the existing binding, preserves custom instructions, saves the generated marker block and reopens Project settings to verify the stored text. It defers while you type, use an editor or open another dialog. The manual “saved” indicator records only your confirmation. Start a new chat after changing Project instructions so the new binding is used. Keep detailed project rules in `AGENTS.md` and design rules in `docs/design-guidelines.md`; the generated startup instructions tell ChatGPT to read those files through MCP.

## Configuration and credentials

There is no `.env` loader or required `.env.example`. Use **Connection management** for Tunnel ID, Organization ID, app name, client path, automatic start and runtime key. No separate model API key is used by ChatSplice; the Tunnel key authenticates the transport.

The installed app bundles its daemon runtime. Project commands still require the project's external toolchain: trusted Node/package-manager executables for Node checks/install, or Rust/Cargo for Rust work, available on the daemon's `PATH`. Finder launches can have a different `PATH` from your terminal; a successful daemon/Tunnel startup does not prove these executables are discoverable. ChatSplice reports missing trusted tools instead of installing global runtimes or running an unrestricted fallback.

- Workspace registrations, Tunnel configuration, references and ChatGPT tab metadata use SQLite under `app.getPath('userData')` (legacy app data is reused).
- Sidebar/window/editor metadata use private JSON files. Editor draft contents and MCP execution/proposal history are memory-only.
- The runtime key uses an owner-only `secrets/tunnel-runtime-key.enc` file encrypted by Electron `safeStorage`. Local authentication tokens use private files and are regenerated independently.
- Development accepts `CHATSPLICE_USER_DATA_DIR` and `CHATSPLICE_NODE_BINARY`, with legacy `LOCALCHAT_*` equivalents. Packaged apps ignore the profile override and use bundled Electron to run the daemon. These overrides are process environment variables, not values loaded from `.env`.

Git ignores `.env*`, credential files, runtime databases and generated builds. App data is outside the source tree; do not copy it into a public repository. For macOS packaging, GitHub events and manual updates, see [release distribution](release-distribution.md).

## Safe working loop

Use an exact path when known. Otherwise, narrow discovery before reading or changing a file.

```text
fs.list or fs.search → fs.read → fs.edit / fs.write → fs.read
```

`fs.rename` and `fs.delete` require the SHA-256 from the immediately preceding complete read. `project.run` accepts only an existing root script named `test`, `lint`, `typecheck`, `check`, or `build`. It never accepts an arbitrary command or arguments.

For declared Node scripts, Cargo checks, locked dependency installation, and cancellation, use `project.exec`, then `project.await_exec` until the job is terminal. `project.cancel_exec` cancels that exact job. These tools use the pinned Pi SDK `0.84.1` for local execution only; they do not create a Pi or Codex model, provider, OAuth session, `AgentSession`, or coding worker. Completed execution is evidenced by the job's actual exit status and output plus a relevant file re-read.

When mutation tools are available, `local.prepare_apply` submits one bounded proposal for automatic local application; it is a write action and cannot bypass a read-only ChatGPT connection. Wait with `local.await_apply` and re-read the affected files.

## MCP tool inventory

The current server exposes 22 tools:

```text
workspace.list
fs.reference_list, fs.reference_paths, fs.reference_search, fs.reference_read
fs.reference_request, fs.reference_request_await
fs.list, fs.search, fs.read, fs.edit, fs.write, fs.mkdir, fs.rename, fs.delete
project.run, project.git, project.exec, project.await_exec, project.cancel_exec
local.prepare_apply, local.await_apply
```

Read the full contract in [MCP tools](mcp-tools.md), [model-free execution](model-free-execution.md), and [current execution contract](current-contract.md). A connected app catalog, a tunnel health check, or a Project instruction does not prove that the current ChatGPT message has an invokable local action.

## Verification

```bash
pnpm verify
```

Run checks that match a change before opening a pull request. A completed tool card is not proof of an edit; re-read the file and report the relevant command result. Local tests do not prove the target ChatGPT account, connector selection, Tunnel association, or message-level tool availability.

See [한국어 안내](ko/README.ko.md) for a Korean quick start and [onboarding](onboarding.md) for the detailed Tunnel setup.
