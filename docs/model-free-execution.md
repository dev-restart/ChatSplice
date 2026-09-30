# ChatGPT Chat + Pi execution tools

## Contract (2026-09-08)

ChatGPT Chat selects tools, interprets errors and decides the next change. Electron/daemon executes local work. The pinned `@earendil-works/pi-coding-agent@0.84.1` SDK is used for execution tooling only: no Pi CLI, `AgentSession`, provider, OAuth, or model prompt is created. Existing `fs.*` and `local.prepare_apply` continue to enforce SHA checks and canonical path/secret policies; they are not replaced by unrestricted Pi file tools.

Execution requests use the exact project `workspace_id` and `workspace_binding`. The MCP surfaces are:

- `project.exec`: submit one structured operation with a fresh `request_id`; identical transport retries reuse it.
- `project.await_exec`: retrieve/wait for the returned `job_id`, including real output and exit status.
- `project.cancel_exec`: cancel that exact workspace/job. Cancellation does not undo completed file writes or installed dependencies.

Every request also has a workspace-relative `cwd` (default `.`) and a bounded timeout. Read the intended manifest before choosing an operation. Symlinks, traversal, arbitrary shell input, user-provided executable paths/argv/environment, global packages, `sudo`, and OS/toolchain installation are outside this contract.

| Operation                               | Scope                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `{kind: "node_script", script: "test"}` | An existing script in the selected directory's `package.json`; includes project-defined build/start/dev scripts    |
| `{kind: "cargo", task: "check"}`        | Cargo `check`, `test`, `build`, `clippy`, or check-only formatting                                                 |
| `{kind: "install", ecosystem: "node"}`  | Restore project dependencies from an existing lockfile; lifecycle scripts are disabled during network installation |
| `{kind: "install", ecosystem: "rust"}`  | Fetch locked Cargo dependencies into the local execution cache                                                     |

Rust execution requires an already installed toolchain and SDK/linker. Dependency downloads and checks are separate: ordinary checks do not implicitly download packages. Node installation supports npm and pnpm; Yarn/Bun installation is rejected because disabling lifecycle scripts alone does not establish the same plugin/config boundary. Rust execution rejects custom workspace/Cargo-cache configuration to prevent external credential/helper execution. Package installations can fail if the lockfile is missing, dependencies need private credentials, or installation hooks are required. Such failures must remain visible; do not call them successful installations or silently run an unrestricted command.

After editing dependency declarations, use `{kind: "install", ecosystem: "node", mode: "resolve"}` (or ecosystem `rust`) to generate/update only the lockfile from the manifest. Re-read the resulting lockfile, then call install with `mode: "locked"` and a new request ID to restore the dependencies. Omitting mode means `locked`. A successful resolve job is not a completed dependency installation. Both phases use the same sandbox, disabled hooks/config guards, network policy and cancellation lifecycle.

Node scripts can listen/connect on loopback for local development servers; external network access remains restricted to explicit install/resolve jobs. The job network flag records that external-network policy, not measured traffic.

## State, visibility and limits

Jobs progress through `queued`, `running`, and a terminal state (`succeeded`, `failed`, `cancelled`, `timed_out`). `cancelling` means cleanup has been requested and is not yet complete. The daemon owns lifecycle, bounded output and retry state; none are restart-durable. Matching/nested canonical roots share reservations with file operations. At most two execution jobs run concurrently. Terminal history is bounded; request IDs do not promise permanent exactly-once execution after eviction/restart.

The bottom workbench offers an interactive human-operated Terminal and a separate history view for MCP execution jobs and file activity. Job history shows the command, working directory, timestamps, exit code, output and truncation; active jobs can be stopped there or through `project.cancel_exec`. The xterm/node-pty terminal is not an MCP surface. Only the app-owned terminal renderer can input shell commands, and the ChatGPT view receives no preload, Node, filesystem or terminal APIs.

The in-memory execution service retains at most 100 job summaries. Direct MCP activity retains up to 100 entries per workspace, and the global activity listing is capped at 500 entries. These limits are bounded session state and are cleared on restart.

The desktop no longer exposes a global read-only switch and clears the legacy preference at startup. The daemon retains its internal read-only guard for compatibility; this does not change read-only reference relationships or tool permissions in ChatGPT. Sandbox initialization failure still prevents MCP execution. Completed work is evidenced by the selected job result and relevant file re-read; a submission card is not a completed check.

## ChatGPT availability and usage

Official pages currently disagree on personal-plan availability. The [developer guide](https://developers.openai.com/api/docs/guides/developer-mode) describes read/write MCP tools for Pro and Plus, while the [Help Center FAQ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) retains Pro read/fetch wording. Treat actual tool exposure and a bounded invocation in the target account as evidence, not a plan-name assumption. Start/cancel tools are declared write actions and await is read-only, following the [annotation definition](https://developers.openai.com/plugins/reference#annotations). SDK integration does not bypass a host's denied action.

No secondary model is invoked by an execution job. This does not mean ChatGPT messages or app use are exempt from the plan's usage limits. Autonomous reasoning continues only while the ChatGPT conversation continues tool iteration; a local process can finish after the response ends, but Electron does not generate a new model turn or scrape/post into the source chat.

## Development and upgrade

Use Node >=22.19; this repository's `.nvmrc` selects Node 24. With nvm installed, run `nvm use`, then `pnpm install --frozen-lockfile` and `pnpm dev` (which builds all workspace packages). The launcher passes its Node executable to the development daemon. Existing app data and credentials are preserved.

This execution contract uses control protocol 4 and MCP descriptor 0.0.9. Finish active work, close the older app and launch the new build. Refresh the app's tool catalog and replace the marked Project instructions to expose the new execution tools. Account availability and the actual ChatGPT-to-tunnel call remain separate from local source/runtime test evidence.

Validation scope and observed results are recorded in the project's internal validation notes.
