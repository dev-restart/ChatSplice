# Current execution contract

Updated: 2026-09-30. This Milestone 2C amendment supersedes earlier claims about read-only proposal tools and automatic worker defaults. Control protocol: 4. MCP descriptor version: 0.0.9. The [model-free Pi execution extension](model-free-execution.md) adds asynchronous project scripts, Cargo checks, locked dependency installation, logs and cancellation without a Pi/Codex model.

## Generated Project instructions

`projectBindingText()` in `packages/protocol/src/project-instructions.ts` is the shared source for new Project setup, instruction copying and instruction updates. It preserves the registered workspace ID and binding and uses the current display name only as a label. A rename must not invalidate the binding or redirect work. The marked v1 block stays within the existing 7,800-character application limit, including the longest supported escaped project name.

The generated instructions prefer direct file tools for individual changes and `local.prepare_apply` for batches or when only that mutation route is invokable. A change must not be submitted through both routes. Root checks use `project.run`; broader declared scripts, Rust and dependency work use `project.exec` with Pi SDK execution tooling. Await calls continue returned IDs, cancellation is not rollback, and partial failures require inspecting completed changes. There is no `code.request`, `code.await_result` or secondary model fallback in the active runtime. An existing MCP app attachment should be retained rather than reopened; attachment does not grant tool permissions.

Generated instructions load `AGENTS.md` and, when present, `docs/design-guidelines.md` at task start; detailed project policy belongs in those files. Private bindings must not be copied into repository files. The concise template stays below 6,000 characters with the longest supported labels, within the unchanged 7,800-character schema limit.

The 2026-09-30 instructions amendment authorizes automatic refresh of a confirmed, active, idle Project tab. A successful template hash avoids redundant UI work until the generator, display name or app name changes; restart rechecks saved settings. Existing markers must be unique and both workspace ID and binding must match before replacement. Preserve unrelated instructions. Creation and update require an enabled Save action and a reopened-settings read-back; input, navigation, another tab, editor or unrelated dialog aborts automatic work. No chat reload, conversation read, private endpoint or automatic message submission is permitted. Unsupported UI and mismatched/manual instructions remain owner-managed, with a bounded cooldown. Rebuild and reopen the app after source changes; then start a new chat inside the Project after a verified update. No workspace re-registration, binding rotation, protocol change or MCP rescan is required for instruction-only changes.

With automatic Tunnel start enabled and a stored encrypted key, app startup and connection configuration refresh start the client. Missing macOS clients use the existing checksum-verified installer. Launch/exit failures are contained and retry with 2–30 second backoff; manual Stop, newer settings and app cleanup cancel earlier attempts. This does not create a remote tunnel, grant account rights, issue credentials or register a ChatGPT app. Build alone does not start the application.

## Chat reasoning and local execution

The desktop workbench now includes a human-operated xterm/node-pty terminal with project-scoped tabs, a lazy file tree and draggable panel sizes. A new terminal starts at the selected registered project's canonical root. The shell runs with the user's ordinary permissions; `cd`, interactive commands and long-running servers are supported. This is an owner-UI capability, not an MCP tool or an extension of ChatGPT permissions. Terminal contents are not automatically sent to ChatGPT or the daemon activity log. The existing bounded MCP tools retain their sandbox, binding and file policies.

The settings UI no longer exposes the global read-only toggle, manual ChatGPT login confirmation or diagnostics export. Desktop startup clears a previously enabled read-only preference. Required tunnel and credential controls remain in a separate connection-management dialog.

The 2026-09-08 auto-attach amendment retains the user's per-project opt-in MCP app attachment convenience. Its UI interaction is limited to the current composer's fixed attachment controls, their owned picker and the selected app pill, including Korean and English labels. An existing attachment requires no clicks; header/sidebar controls and global More buttons are never fallbacks. An unrelated open menu/dialog, hidden tab, navigation or replaced composer aborts the attempt. Automatic attachment is suspended while a file editor is active. Failures use a bounded per-context cooldown, and success requires observing the attachment pill. Unknown UI remains a manual-attachment case. This narrow exception supersedes earlier manual-only UI wording; it does not permit conversation/history scraping, cookie collection, private endpoints, automatic message submission or changes to account/tool authority. Control protocol and the MCP catalog are unchanged.

The ChatGPT app display name is a user setting (`ChatSplice MCP` by default, recommended; installations that already had projects keep `Local MCP`). It is stored in the daemon settings, exposed as `mcp_app_name` in the daemon status, and used only as a label: generated Project instructions and the auto-attach label match refer to it, and the localized `로컬 MCP` alias is matched only for the legacy `Local MCP` name. It does not change the MCP server name, the 22-tool catalog, protocol 4 or any permission. After renaming, the idle bound Project receives refreshed instructions; unsupported UI requires manual copy/save.

The 2026-09-09 composer lifecycle guard also pauses attachment on submission, disabled/busy input or visible response-stop controls. After submission or generation, it stays paused until new trusted user input; completion alone must not reopen the picker. Typing and IME composition interrupt an in-flight selection, which checks the interaction revision before every action. Attachment resumes after composition ends and input is quiet for 750 ms. Per-document listeners retain only activity flags, a revision and a timestamp, never prompt text, drafts or history. They never clear or refill the composer and are not installed on login/other origins. Normal pauses do not trigger failure cooldowns.

ChatGPT Chat performs reasoning, chooses bounded tools and verifies the result. File tools and local checks do not invoke a second model. This is a statement about process invocation, not a guarantee about ChatGPT allowance or billing.

`local.prepare_apply` requests automatic changes. Electron detects and claims the request using its private mutation token; the daemon then owns execution independently of the HTTP response. `local.await_apply` returns the real state and evidence. The descriptor is `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` because operations may delete files or contact a Git remote. A delayed side effect is still a side effect under the [official annotation definition](https://developers.openai.com/plugins/reference#annotations).

A chat that only exposes read actions cannot use this automatic mutation path. Do not present Electron indirection as enabling write access on a read-only Pro connection. Verify actual tool invocation in the target account. No DOM scraping, private ChatGPT endpoint, hidden write annotation or automatic paid-worker fallback is used to bypass this boundary.

## Project tabs and manual editing

Each registered project has a center tab strip with ChatGPT first and open files after it. Selecting a project restores its active center tab, open drafts and undo state, while the terminal and right-hand file tree use the same selected project. The local editor is an owner-only `WebContentsView` with private main-process IPC. While it is active, the remote ChatGPT view remains hidden and retained without reloading or reading its history. Editor contents and APIs are not exposed to ChatGPT.

CodeMirror supports manual editing of existing regular UTF-8 files up to 1 MiB. The session permits at most 16 open file tabs per project and 48 globally; draft text and saved baselines share a 32 MiB total budget. Binary files, unsupported encodings, oversized files and secret/control paths receive an explicit unsupported or denied result. Highlighting covers JavaScript/TypeScript, JSX/TSX, JSON, Markdown, Python, Rust, HTML, CSS, SQL, YAML and shell; other text files use plain-text highlighting. Opening a file, including HTML or JavaScript, never executes its contents.

Saving uses the owner-only daemon API with canonical path checks, shared canonical-root reservations, full-file SHA validation and atomic replacement of the existing file. A changed or replaced file is a conflict, not permission to overwrite external changes. Manual editing does not add an MCP tool, grant a read-only chat write access or change protocol version 4 and the 22-tool catalog.

Project switches retain drafts and undo state in bounded memory. A JSON file in private app data persists only workspace IDs, file paths and active-tab metadata so those tabs can reopen after restart; unsaved draft text is never persisted. Closing a dirty tab, quitting, changing its workspace root or removing its workspace requires a decision about the unsaved changes. Terminal sessions and execution/activity history retain their existing memory-only lifecycle.

## Request lifecycle and evidence

- Use a fresh `idempotency_key` (8–96 letters, digits, `_` or `-`) per intentional operation. Reuse it only for an identical transport retry. Legacy requests without a key deduplicate by the validated bundle hash.
- Identical pending, applying and retained terminal requests return the same proposal. Reusing a key for different contents fails. Retention is memory-only, bounded to 500 terminal results and 16 MiB; after restart or eviction, deduplication is not guaranteed. Hence no unconditional idempotency annotation.
- Pending proposals expire after ten minutes. A claim that never starts returns to the queue after 30 seconds. Applying work is never requeued merely because a transport timed out.
- The owner-only `execute` endpoint returns HTTP 202. Retrying the same claim reads its existing state. The old synchronous `/v1/local-apply` and caller-supplied `/start`/`complete` endpoints are removed.
- Bundles are limited to 20 file operations, three checks and five Git commands, 900 KiB each, with a combined pending/claimed budget of 16 MiB.
- Each check/Git result carries exit code, timeout, duration, truncation and bounded stdout/stderr. File writes return their new SHA-256. The activity panel stores summaries, not these output bodies.
- A later failed step does **not** roll back earlier changes. `changed_paths`, `applied_steps` and `failed_step` describe partial execution. Re-read the affected files and correct only the remaining work.

## Files and concurrency

All tool-driven file mutations, owner-editor saves, bundle execution and project checks/Git/execution jobs share a daemon reservation over canonical workspace roots. Same and nested roots serialize; independent roots can proceed. Execution jobs retain their reservation through cancellation cleanup. Busy workspace removal is rejected. A crashed daemon does not provide durable recovery; inspect files before restarting uncertain work.

Read, search and mutation paths reject secret/control paths after canonicalization, symbolic links and hard-linked regular files. Reads are bounded on actual bytes. Replacements recheck the SHA immediately before the atomic rename. This prevents concurrent ChatSplice lost updates; the application is not a kernel-level transaction manager against an unrelated local process swapping directories at the last instant.

The current application does not dispatch a separate Codex/Pi model worker. The Pi SDK execution adapter invokes local tooling only. A binding is a target identity, not consent to arbitrary instructions: only user-requested actions should be submitted. Earlier worker-policy and OAuth descriptions in earlier design documents do not describe this active runtime.

## Upgrade

Finish ongoing work and close the old application before launching this source revision. A daemon with an older control protocol is rejected rather than silently reused by the version-4 desktop. Existing registered folders, browser profiles and persisted preferences are retained. Refresh the connector's tool definitions and replace the marked Project instruction block, then verify in a disposable workspace. Source tests do not prove account entitlement or packaged-app upgrades.
