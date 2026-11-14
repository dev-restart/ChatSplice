# Goal chat workflow — 2026-10-20

## User flow

A user can describe a task in the bound project's ChatGPT conversation and ask to register it as a Goal: “설정 화면을 개선하고 저장 동작까지 검증해 줘. Goal로 등록하고 계속 진행해 줘.”

ChatGPT reads existing Goals, inspects the relevant project instructions, source and manifests/scripts, and chooses the concrete tracked files and meaningful acceptance criteria. It creates a Goal only when the user requests Goal/task tracking. A continuation request reuses the selected Goal ID. An uncertain create response is reconciled by reading saved Goals before another create; create is not idempotent.

The reasoning and repair loop stays in the active ChatGPT conversation. Pi executes the existing model-free local operations. A saved Goal does not schedule a new model call or send a ChatGPT message after the conversation ends.

## Workbench changes

The Goal pane starts with a natural-language task description, two examples, a three-step explanation and a prepared request. Users can speak directly in the project chat or copy the request. The advanced manual form retains direct creation for users who know the concrete files and checks.

The request is visible in a read-only, selectable text area. Clipboard success is reported only after the write resolves. A denied or absent Clipboard API leaves the text available for manual copying. A late clipboard result cannot show success after the project, Goal, request or locale changes. Copying performs no Goal mutation, execution or message submission.

A saved active, paused or interrupted Goal with a matching root offers a continuation request containing its workspace ID, Goal ID and saved next step. The request requires a fresh tool read; it carries no stored revision, binding or root path. Completed, cancelled, cancelling and root-mismatched Goals do not offer continuation.

The workbench's manually edited checkpoint tracks its original revision. Polling updates clean inputs, preserves dirty inputs, and reports an external revision conflict before saving. The save uses the draft's baseline revision, so an update arriving after polling is still rejected by the service. Loading the latest checkpoint explicitly replaces the draft. This conservative conflict check also notices receipt and other Goal revision changes.

## Registration, evidence and continuation contracts

The existing Goal schemas, SQLite persistence and mutation guards are retained. Scope, tracked files and criteria remain immutable. Planning must choose 1–32 concrete relative regular UTF-8 files, at most 1 MiB each and 8 MiB total. Planned new files may be absent. Directories and a dot are not tracked-file placeholders.

Criteria must describe observable results. A file SHA establishes the current file identity; it does not prove that the feature works. Declared Node/Cargo checks and local browser assertions earn criterion evidence only through matching Goal-linked executions. Additional-folder checks cannot satisfy main-project criteria.

Every non-create mutation requires the latest expected_revision. Existing owned operations are awaited instead of replayed. Before completing, save the final checkpoint, then request complete only with current required evidence and terminal owned executions. A completed Goal does not accept a subsequent checkpoint.

Resume applies only to paused/interrupted Goals after checking the current root, files and owned operations. An expired or exhausted active Goal first pauses, is read again and then resumes with an explicit deadline/budget renewal. The lifetime execution/receipt cap is 128. At the hard cap, save the remaining work and report the limit instead of promising endless continuation.

Generated project instructions describe this flow within the existing 6,000-character field. Both Goal MCP tool descriptions carry the detailed discovery, deduplication, evidence and continuation rules. No protocol shape, model integration, auto-message path or private owner-control fallback is added.

## Validation and current connection limits

Focused protocol, renderer-helper, owner-IPC, Goal lifecycle and actual MCP in-memory transport checks cover this workflow. The transport fixture uses the real registered Goal tools, SDK Client.callTool and SQLite GoalService; its binding guard is fixture-specific. It verifies discovery, creation, stale-revision rejection, same-ID pause/resume, missing/stale evidence rejection and completion. It does not represent a live target-account HTTP call or test a model's natural-language planning.

The Chromium owner-bridge fixture tests natural-language requests, copy success/failure, visible fallback text, project switching, stale clipboard completion, same-Goal continuation, current/dirty checkpoint handling, manual creation and evidence controls, terminal-state UI, Korean/English and compact layout. It never changes live user Goals, the system clipboard, the user's ChatGPT session or project commands.

Use a separately built renderer while the app is running:

```sh
node scripts/check-workspace-folders.mjs renderer
CHATSPLICE_RENDERER_DIR="$PWD/node_modules/.cache/chatsplice-folders-check/renderer" node apps/desktop/scripts/goal-ui-smoke.mjs
```

The smoke script accepts --serve for an isolated loopback fixture that the existing project browser can inspect. Backend/IPC fixtures, browser-rendered UI and native Electron behavior are distinct validation surfaces.

During implementation, the current attached connector exposed 22 tools and omitted project.goal/project.goal_update even though the source catalog registers 24. Source tests and a new build do not update that attachment. Normally close the prior app/daemon, start the prepared runtime, refresh Scan Tools, and confirm both Goal tools plus goal_id/criterion_id and browser assertions on project.exec are actually invokable. Refreshing schemas alone does not replace running code. Generated project instructions should also be refreshed through the existing project setup flow.

The current task did not create a real user Goal through an unavailable tool or use a private endpoint to substitute for it. Live target-account Goal registration, native clipboard behavior and any automatic model continuation remain unverified until that supported connection is refreshed and used.

## Verification results

On 2026-10-20, 28 distinct focused tests passed: protocol/instruction constraints (11), renderer request helpers and owner Goal IPC (9), Goal execution lifecycle and SDK in-memory Goal transport (6), and full source catalog discovery/fingerprinting (2). The separate authenticated HTTP catalog test was not selected; the current target-account Goal attachment is still a distinct unverified surface.

TypeScript checks for protocol, core, MCP and desktop passed. Svelte reported zero errors and zero warnings. Changed TypeScript/scripts passed ESLint, and changed source/document files passed Prettier checks. The renderer build and Chromium smoke completed successfully, including manual Goal/evidence controls, natural-language request preparation, copy rejection fallback, workspace switching, stale copy suppression, same-Goal continuation, checkpoint conflict protection and Korean/English compact layouts. Browser pageErrors was empty.

A separate project-browser observation opened the loopback fixture, selected Goal and entered a natural-language request; the expected form and generated request were visible in screenshots. The console retained CSP inline-style diagnostics from the initial terminal surface. This is not a claim of a clean terminal console or native Electron verification. The Goal flow assertions passed without relaxing CSP.

The renderer build retained a bundle-size warning for a pre-existing editor chunk. This task did not change editor chunking or broaden the goal into an unrelated terminal/style refactor.
