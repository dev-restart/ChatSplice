# Public release checklist

Prepared code and local checks do not establish ChatGPT account capability, hosted CI success or published binaries.

- [x] Repair and regression-test the audited path, concurrency, execution-result and request-lifecycle defects.
- [x] Declare automatic proposals as write actions and document account read-only limitations.
- [x] Keep the active runtime model-free; Pi SDK is execution tooling only.
- [x] Apply MIT to original code and include versioned dependency license supplements, provenance and hash validation.
- [x] Keep legacy user data/browser profiles; reject incompatible running daemon versions.
- [x] Prepare least-privilege hosted CI, exact tag/version validation, immutable GitHub Release assets and SHA-256 manifests.
- [x] Prepare optional signed/notarized packaging and a main-process updater with consent and dirty-editor checks; default to unsigned pre-releases.
- [x] Identify repository/maintainer as dev-restart/ChatSplice and document the private security-report route.
- [x] Add public README usage flows and isolated fictional UI previews without real accounts, conversations or credentials.
- [ ] Resolve product-name clearance before publishing the source.
- [x] Inspect the public file set, push the initial source and confirm hosted CI succeeds.
- [x] Make the repository public, enable Private Vulnerability Reporting and confirm the Security page links to its private advisory form.
- [ ] Verify actual ChatGPT/Tunnel reads, a permitted file mutation and result re-read in a disposable workspace.
- [ ] For binary release, review native/upstream notice obligations and test a fresh installation plus existing-profile app replacement on a separate macOS device.
- [ ] Before signed stable distribution, register Apple Secrets, verify signatures/notarization and complete a real update between two signed versions.

Apple credentials are currently unavailable; unsigned distribution needs no Apple Secrets. Source, unsigned pre-release and signed stable updates have separate gates. Follow [release distribution](docs/release-distribution.md) and the [current contract](docs/current-contract.md).

Source publication verified on 2026-10-01: the public source excludes local-only planning documents, credentials and generated binaries. [Hosted CI passed](https://github.com/dev-restart/ChatSplice/actions/runs/36740967021) for commit `e586bb5`; Private Vulnerability Reporting is enabled and its entry is visible on the public Security page. This does not establish account-wide write support, fresh-device installation or signed updates.
