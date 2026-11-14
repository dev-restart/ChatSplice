# Getting started

ChatSplice is a macOS desktop shell for a normal ChatGPT session and a private, loopback-only MCP server. ChatGPT remains the conversation and reasoning surface; ChatSplice provides bounded workspace tools and model-free local execution.

Use macOS 14 or later on Apple Silicon for the full workflow. The Node.js 24 binary requires macOS 13.5 or later, and the managed browser requires macOS 14 or later. [Playwright system requirements](https://playwright.dev/docs/intro#system-requirements)

> This is a source pre-release. Build it on your own Mac and use a disposable project for your first connection. The [publication checklist](../RELEASE_CHECKLIST.md) distinguishes a local build from verification on a target ChatGPT account.

## First checkout and daily use

Install Git and the Xcode Command Line Tools (`xcode-select --install` if needed). Use Node.js 24 (CI pins 24.18.0) and pnpm 10.33.2. With nvm, use `nvm install` and `nvm use` to select Node 24 from `.nvmrc`. If pnpm is missing, install it with `npm install -g pnpm@10.33.2`.

From the checkout or extracted source directory:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Run `pnpm install --frozen-lockfile` again when the dependency declarations or `pnpm-lock.yaml` change. To reopen an existing build without rebuilding, use:

```bash
pnpm start
```

After source changes, `pnpm dev` builds all workspace packages and starts the branded Electron development app. `pnpm build` followed by `pnpm start` performs the same work as two explicit commands. The root build cleans only the known generated output directories (`apps/desktop/dist`, `packages/core/dist`, `packages/mcp-server/dist`, and `packages/protocol/dist`) before compiling; it does not touch source, app profiles, credentials, or workspace data.

## Local workbench

Select a registered project and use the top-right **Terminal** and **Files** buttons. Terminal opens an interactive shell at that project root; **+** creates another tab. Tabs survive hiding the panel and close when explicitly closed or the app quits. Drag any panel divider to resize. The history view retains bounded MCP job output and file activity for this app session.

The Files panel is a lazy, expandable tree with bounded UTF-8 previews. It follows the selected project and rejects symlinks and protected files. The human-operated terminal has normal user permissions, including `cd` and development-server commands; the separate MCP tools retain their sandbox.

## Connect ChatGPT

Check whether your ChatGPT workspace allows custom MCP servers and whether your OpenAI Platform organization grants the required Tunnel permissions. Confirm read and write availability with a test call in the account you plan to use. [Custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

1. In OpenAI Platform **Settings → Organization → Tunnels**, create or select a tunnel and associate it with both the target ChatGPT workspace and the Platform organization. Keep the Tunnel ID, Organization ID, and runtime API key private. Creating or editing a tunnel requires `Tunnels Read + Manage`. Running or selecting one requires `Tunnels Read + Use`.
2. Start ChatSplice and sign in to ChatGPT in the center view. In **Connection management**, enter the Tunnel ID and Organization ID and save the configuration.
3. When ChatSplice finds no `tunnel-client`, it downloads the official macOS archive, verifies its published SHA-256, and stores the versioned executable beside the app data. If the download fails, install the client from Platform or the [latest public release](https://github.com/openai/tunnel-client/releases/latest) and enter its full path in **Advanced tunnel settings**.
4. Choose **Register** for the runtime API key and enter it in the secure prompt. ChatSplice encrypts the key with Electron `safeStorage` and macOS Keychain protection. Use **Run checks** to run `tunnel-client doctor --explain`. Keep the tunnel running during setup and tool calls.
5. In ChatGPT web, open **Plugins → + → Add custom MCP server**. Choose **Tunnel** under **Connection**, select the tunnel or enter its ID, and choose **No authentication** for this private ChatSplice connection. The tunnel client supplies the local MCP authentication token. Review the risk prompt, choose **Create as a plugin**, and install the resulting plugin.
6. In a new Project chat, type `@` and select the installed plugin for the message. Confirm it appears in the composer, send a read request for a practice file, and verify it in ChatSplice **History → MCP activity**.

If the embedded login or setup controls are unavailable, keep ChatSplice running and sign in to ChatGPT in your browser. Manually save the copied Project instructions and select the MCP app there using the same account and workspace. A connected Tunnel sends tool results to ChatGPT regardless of which browser view you use.

The tunnel can be healthy while the current message has no Local MCP app selected. The `doctor` result checks local configuration and the tunnel client preflight; it does not prove ChatGPT app selection or a successful MCP call. Check both the ChatSplice activity/status and a real bounded request in a disposable workspace.

Set **MCP app name in ChatGPT** to the exact name of the installed plugin so the generated Project instructions refer to it. `ChatSplice MCP` is the default name. Existing installations can continue to use `Local MCP`. If you change the name, check the refreshed Project instructions or copy and save them manually.

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

Git ignores `.env*`, credential files, runtime databases and generated builds. App data is outside the source tree; do not copy it into a public repository. For self-builds, optional local unsigned packaging and source updates, see [release distribution](release-distribution.md).

## Safe working loop

Use an exact path when known. Otherwise, narrow discovery before reading or changing a file.

```text
fs.list or fs.search → fs.read → fs.edit / fs.write → fs.read
```

`fs.rename` and `fs.delete` require the SHA-256 from the immediately preceding complete read. `project.run` accepts only an existing root script named `test`, `lint`, `typecheck`, `check`, or `build`. It never accepts an arbitrary command or arguments.

Use `project.exec` for declared Node scripts, Cargo checks, locked installation, general developer shell commands and local browser verification. Shell commands support Python environments and project runtime configuration. For a development server, set `background: true`, poll with `project.await_exec` and `timeout_ms: 0`, verify readiness, then continue edits/checks. Await foreground jobs until terminal. Browser actions setup/open/snapshot/click/fill/press/scroll/close return real page evidence and screenshots; open width/height supports mobile checks. `project.cancel_exec` stops the exact owned job and must be followed through cleanup. Pi SDK `0.84.1` handles command execution and pinned Playwright handles isolated browser sessions; neither creates another model/provider/OAuth session. After upgrading, refresh connector tool discovery and replace the marked Project instructions; see the [current contract](current-contract.md) for the active descriptor.

When mutation tools are available, `local.prepare_apply` submits one bounded proposal for automatic local application; it is a write action and cannot bypass a read-only ChatGPT connection. Wait with `local.await_apply` and re-read the affected files.

## MCP tool inventory

The current server exposes 24 tools:

```text
workspace.list
fs.reference_list, fs.reference_paths, fs.reference_search, fs.reference_read
fs.reference_request, fs.reference_request_await
fs.list, fs.search, fs.read, fs.edit, fs.write, fs.mkdir, fs.rename, fs.delete
project.run, project.git, project.exec, project.await_exec, project.cancel_exec
project.goal, project.goal_update
local.prepare_apply, local.await_apply
```

Read the full contract in [MCP tools](mcp-tools.md), [model-free execution](model-free-execution.md), and [current execution contract](current-contract.md). A connected app catalog, a tunnel health check, or a Project instruction does not prove that the current ChatGPT message has an invokable local action.

## Verification

```bash
pnpm verify
```

Run checks that match a change before opening a pull request. A completed tool card is not proof of an edit; re-read the file and report the relevant command result. Local tests do not prove the target ChatGPT account, connector selection, Tunnel association, or message-level tool availability.

See [한국어 안내](ko/README.ko.md) for a Korean quick start and [onboarding](onboarding.md) for the detailed Tunnel setup.
