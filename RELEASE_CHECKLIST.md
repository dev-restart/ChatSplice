# Source publication checklist

ChatSplice is distributed as MIT source for people to build on their own Macs. Review the exact tree you plan to publish. A green local build, an earlier GitHub Actions run, and a successful ChatGPT connection each verify different things.

## Prepare the source

- [ ] Keep [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Confirm that you have the right to publish contributed code, images and documentation.
- [ ] Review the proposed public file list and reachable Git history. Exclude app profiles, keys, private bindings, actual chats, customer data, and local progress logs. Inspect images and build logs as well as text. Use a new repository with only the reviewed source if the existing history or hosted records must stay private.
- [ ] Unpack the source candidate in a separate folder on macOS Apple Silicon. Run `pnpm install --frozen-lockfile` and `pnpm verify` using the documented versions. Confirm that `pnpm notices --require-complete` has no missing entries.
- [ ] Run `pnpm audit` against the final lockfile. Resolve high-severity findings and assess the remaining findings against the features the app uses.
- [ ] Start that build with an isolated test profile and confirm the app and daemon agree on the runtime identity. See the [current contract](docs/current-contract.md) for current protocol and catalog versions.
- [ ] Check an actual ChatGPT account in a disposable folder: discover the tools, select the app in a new chat, make a bounded read, then make and verify a small edit if permitted. Document which account and native workflows remain unverified without disclosing their private values.

## Publish the reviewed commit

- [ ] Confirm the owner, repository name, publication rights and final file list. See [open-source readiness](docs/publishing.md) before changing repository visibility.
- [ ] Enable and verify [private vulnerability reporting](SECURITY.md) on the public repository. Check README links and the source-update URL if the repository slug changes.
- [ ] Verify GitHub Actions for the exact commit and record any remaining gates. Do not use an earlier commit's green check as evidence for the current tree.

The default [CI workflow](.github/workflows/ci.yml) verifies source without publishing app assets. Signing, notarization, a public binary, and a public ChatGPT plugin each require separate review. See [source distribution](docs/release-distribution.md).
