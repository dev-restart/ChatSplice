# Developer execution verification

## 2026-10-11 source audit

The current source passed `pnpm verify` on macOS/Node 24.18.0: 495 unit tests, four release tests, format/lint/build/typecheck and complete notices. The four opt-in Chromium/MCP workflows passed separately, including actual `project.run` after a guarded file edit and twelve parallel projects (installation hooks, background servers, eight foreground jobs plus four queued jobs, browser storage isolation and owned-process cleanup). Desktop and narrow-viewport screenshots were inspected.

Additional regressions cover pip/uv local wheel installation followed by import in another job, installed Rust toolchains, cached Corepack reuse, pnpm locked/resolve with hooks disabled, Bun without external Node while secrets/outside files remain denied, manifest aliases, root-change races, accepted-input snapshots, bounded await waiters, cancellation cleanup, long browser selectors and incompatible-daemon preservation. A missing Corepack version's external download was not exercised. The running user's app/daemon and installed package were not replaced; the currently exposed connector schema still lacks `assert`/`web-verify-2`. Local source verification does not establish target-account invocation, an updated package or hosted CI.

## 2026-10-09 earlier package evidence

Observed locally on 2026-10-09, macOS with Node 24.18.0 and packaged ChatSplice 0.0.2 using its bundled Electron runtime. These results describe the new source/build and separate test daemons. The user's running ChatSplice instance was preserved because a ChatGPT project was actively working.

| Verification                       | Observed result                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace request identity         | Reproduced cross-project request-ID collision before fixing it. Identical IDs now work independently across projects; same-project retries retain the same job and changed requests fail. Cross-project job lookup is rejected.                                                               |
| Actual multi-project MCP execution | Twelve disposable projects ran offline npm installation with postinstall hooks and twelve background HTTP servers. Eight foreground jobs ran while four waited, and a queued job resumed after a slot was released.                                                                           |
| Concurrent editing/checks          | All twelve server projects accepted full-read/SHA-guarded edits and then passed their npm checks while servers stayed running.                                                                                                                                                                |
| Browser isolation                  | Twelve Chromium contexts rendered the corresponding project. All then visited the same origin, saved different names through observed fill/click selectors and retained their own names after reload at 360 × 640.                                                                            |
| Cancellation/cleanup               | Canceling one server stopped its endpoint while the other eleven remained reachable and running. Closing/canceling all test jobs stopped all owned servers.                                                                                                                                   |
| Real repositories                  | Link Stash and Reading Musical frontend `pnpm check` ran concurrently through MCP shell execution. Both reported zero errors and warnings. No source changes were made to either project.                                                                                                     |
| Real local pages                   | Link Stash reached its unauthenticated login page after session lookup. Reading Musical rendered login, navigated through the observed password-reset link, and rendered mobile login. Authenticated data flows were not tested.                                                              |
| Repository verification            | `pnpm verify` passed: formatting, lint, build, typecheck, 383 unit tests, four release tests and complete third-party notices. The two opt-in browser workflows also passed separately.                                                                                                       |
| Release execution fixes            | Reproduced and fixed non-Node shell commands being blocked by missing external Node and network-enabled developer installs skipping postinstall hooks. Both new regression tests passed.                                                                                                      |
| Packaged daemon                    | Unsigned 0.0.2 arm64 DMG packaging and `pnpm test:packaged --browser` passed using the `.app` Electron runtime. Minimal Finder-like PATH shell/browser setup, npm hook, background server with guarded edit, observed fill/click, mobile screenshot, cancellation and daemon shutdown passed. |

The browser runs use isolated sessions. Link Stash's unauthenticated session lookup returned 401; this was followed by its login screen. Reading Musical's service-worker registration was blocked by the preview browser policy; offline/PWA behavior is outside this verification. Login credentials and authenticated user state were not copied from existing browser profiles.

The desktop/HTTP runtime limits are eight foreground jobs, twelve background processes, twelve browser sessions and 64 queued/running jobs across the app. Overlapping foreground roots still serialize. Browser sessions can remain open while another browser action waits for a foreground slot. The configured caps are execution limits, not a throughput guarantee for every computer.

To reproduce the two real MCP workflows after the pinned Chromium setup:

```sh
CHATSPLICE_BROWSER_TESTS=1 pnpm --filter @chatsplice/mcp-server exec vitest run src/execution/developer-workflow.test.ts src/execution/multi-project-workflow.test.ts
```

The expanded schema uses MCP descriptor 0.0.10 and control protocol 4. After active work finishes, close the old app, start the new build, refresh the ChatGPT connector tool catalog and verify the generated Project instructions. A fresh target-account ChatGPT invocation through its configured tunnel remains unverified; local MCP client success does not prove account discovery or write-action availability. No commit, deployment or automatic ChatGPT message was performed.

The local release bundle is under `apps/desktop/release/v0.0.2-local/`, with packaged smoke screenshots and `evidence.json` under `smoke/`. Source publication/GitHub release, hosted CI on this uncommitted revision, separate-device installation/profile replacement and signing/notarization remain unverified. The reproducible packaging and checksum steps are in [release distribution](release-distribution.md).
