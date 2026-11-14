# Open-source readiness

The intended distribution is a source release under the root [MIT license](../LICENSE). Others can build and modify ChatSplice under that license. Keep the MIT notice and [third-party notices](../THIRD_PARTY_NOTICES.md) with the source. Verify that the publisher has the rights to the code, docs and images; a dependency inventory does not establish ownership or trademark clearance.

The distribution target is a self-built macOS Apple Silicon app. The package manifests are marked private because the workspace packages are not meant to be published to npm. This does not prevent publishing the repository source. For a public app binary, separately review the contents and license obligations of the Electron bundle and its dependencies, code signing, notarization and clean-machine installation.

## Choose the public repository

Review the exact source, history and hosted material before changing visibility. In an existing repository, old commits can expose author emails and previous file versions, and Actions history and logs can become public. See [GitHub's visibility guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility). If any of that material must stay private, keep the original repository private and publish the reviewed archive contents as a new repository. Do not mirror local refs or include `.git`, profiles or work logs. If the slug changes, update the repository, issue reporting and source-update links before publishing.

Check that the [public reporting instructions](../SECURITY.md) work after enabling GitHub private vulnerability reporting. Use ChatSplice's own name and artwork. Refer to ChatGPT as the service the app connects to, in line with the [OpenAI brand guidelines](https://openai.com/brand/).

## Use of ChatGPT

The app shows the ChatGPT website in an embedded browser and uses private MCP for local tool requests. Optional Project setup depends on the website's settings controls. If those controls change, follow the [manual setup steps](onboarding.md#문제-해결) in ChatGPT web while the local app is running. The MIT license covers ChatSplice's code. Use of ChatGPT follows the [applicable service terms](https://openai.com/policies/row-terms-of-use/) and workspace policy.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) supports private connections. Each user needs their own permitted workspace and Tunnel. A public GitHub repository does not make the MCP server public or list it in ChatGPT. The [plugin directory](https://developers.openai.com/plugins/deploy/submission) has its own submission and endpoint requirements.

See the [source verification checklist](../RELEASE_CHECKLIST.md) for the evidence to collect before publication.
