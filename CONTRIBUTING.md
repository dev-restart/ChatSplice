# Contributing

ChatSplice distributes MIT source for users to build on their own Macs. See the [installation guide](docs/getting-started.md) for prerequisites, the [publication checklist](RELEASE_CHECKLIST.md) for release checks, and [SECURITY.md](SECURITY.md) for private reports.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) when participating.

## Development scope

- macOS Apple Silicon is the currently supported platform. Keep Windows/Linux work behind explicit platform validation.
- Preserve the security boundary: no ChatGPT DOM scraping, private ChatGPT endpoints, remote renderer access to Node/Electron/filesystem/daemon APIs, unbound execution, or unbounded discovery. Developer shell input is supported only through the bound project.exec lifecycle and workspace-confined sandbox.
- Every project-scoped MCP request needs the immutable `workspace_id` and matching `workspace_binding`.
- Keep mutation paths UTF-8, canonical-workspace, SHA-verified where required, and secret-policy bounded.

## Local workflow

With Node.js 24 and pnpm 10.33.2:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Some execution tests invoke installed tools. For the full verification suite, put a working Python 3 and Rust/Cargo toolchain on your `PATH`. Use a short checkout path on macOS so temporary Unix socket paths fit.

Read the relevant source and tests before editing. Keep changes focused, add regression coverage for defects, and report exactly which commands you ran. Use fictional projects in screenshots and fixtures. Keep private progress notes under `docs/local/` or in `docs/agent-progress.md`; both are ignored. Never commit build output, runtime profiles, private project data, credentials, or real conversation URLs.

The execution path and packaging responsibilities are described in [execution architecture](docs/execution-architecture.md). Run the opt-in browser workflows and packaged smoke when changing execution or distribution; see [release distribution](docs/release-distribution.md).

## Pull requests

Use a focused branch and explain:

1. The user-visible or security-relevant problem.
2. The bounded solution and non-goals.
3. Tests run and tests intentionally not run.
4. Any macOS, ChatGPT account, Tunnel, or real-message E2E gate that remains unverified.

Do not claim that a tool catalog, Project registration, or UI badge proves a mutation completed. Include a canonical re-read/diff and the relevant test result.

## 한국어 요약

MIT 소스 공개와 사용자 직접 빌드를 기준으로 검증 체크리스트와 직접 빌드 안내를 따릅니다. 서명·공증·자동 Release 운영은 필수 절차가 아닙니다. ChatGPT DOM/private endpoint, remote renderer의 privileged API, workspace binding 없는 실행, unbounded discovery를 추가하지 마세요. 개발 shell은 project.exec의 실행·sandbox 계약을 따릅니다. 수정 전 관련 코드와 테스트를 읽고 `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` 중 해당 검증을 실행한 뒤 결과를 PR에 남깁니다. 실제 변경은 tool card가 아니라 canonical re-read/diff와 테스트 결과로 증명합니다.
