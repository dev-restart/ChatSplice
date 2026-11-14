# Dependency license supplements

`pnpm notices --require-complete` combines the installed packages' LICENSE/COPYING/NOTICE files with the version-specific entries in [manifest.json](manifest.json). Supplemental UTF-8 text is identified by SHA-256; generation fails on modified text or an invalid path. Ordinary notice generation is offline.

Some packages omit a license file from their npm archive. Where available, the supplement preserves upstream license text at an immutable revision or text embedded in the published README. For upstream packages that declare MIT without supplying separate terms, the supplement retains the exact version's published author/contributor/maintainer attribution and the MIT terms from a pinned SPDX license-list revision. It does not invent copyright holders or years. The manifest distinguishes these review methods; coverage is not a legal certification of upstream artifacts or bundled native libraries.

After updating dependencies, run `pnpm notices --require-complete`. A new missing package/version blocks binary packaging and CI. Review its published license and notices, record its source and version, save the exact UTF-8 supplement under `upstream/<sha256>.txt`, and add the hash/path to the manifest. Do not substitute a different license or silently reuse another package's attribution.
