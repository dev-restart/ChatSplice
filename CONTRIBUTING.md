# Contributing

Thank you for improving ChatSplice. The project is not publicly released yet: do not publish, package, or redistribute it until name clearance, license, and the release checklist are completed.

## Development scope

- macOS Apple Silicon is the currently supported platform. Keep Windows/Linux work behind explicit platform validation.
- Preserve the security boundary: no ChatGPT DOM scraping, private ChatGPT endpoints, renderer access to Node/Electron/filesystem/daemon APIs, arbitrary shell input, or unbounded discovery.
- Every project-scoped MCP request needs the immutable `workspace_id` and matching `workspace_binding`.
- Keep mutation paths UTF-8, canonical-workspace, SHA-verified where required, and secret-policy bounded.

## Local workflow

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Read the relevant source and tests before editing. Keep changes focused, add regression coverage for defects, and report exactly which commands you ran. Do not commit generated `dist` output, local databases, credentials, tunnel keys, or `.env` files.

## Pull requests

Use a focused branch and explain:

1. The user-visible or security-relevant problem.
2. The bounded solution and non-goals.
3. Tests run and tests intentionally not run.
4. Any macOS, ChatGPT account, Tunnel, or real-message E2E gate that remains unverified.

Do not claim that a tool catalog, Project registration, or UI badge proves a mutation completed. Include a canonical re-read/diff and the relevant test result.

## 한국어 요약

공개 전에는 이름·LICENSE·release checklist가 끝나기 전 배포나 package publish를 하지 않습니다. ChatGPT DOM/private endpoint, renderer의 privileged API, arbitrary shell, unbounded discovery를 추가하지 마세요. 수정 전 관련 코드와 테스트를 읽고 `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` 중 해당 검증을 실행한 뒤 결과를 PR에 남깁니다. 실제 변경은 tool card가 아니라 canonical re-read/diff와 테스트 결과로 증명합니다.
