# Security policy

Maintainer: [dev-restart](https://github.com/dev-restart). Repository: [dev-restart/ChatSplice](https://github.com/dev-restart/ChatSplice).

Use the repository's [private advisory form](https://github.com/dev-restart/ChatSplice/security/advisories/new) (**Security → Report a vulnerability**). The maintainer verifies this route when opening a repository to the public. If the form is unavailable, contact the maintainer privately before sharing technical details.

The current supported line is the latest pre-release. Signing and device validation status are documented in [release distribution](docs/release-distribution.md); there is no stable support or response-time guarantee yet.

Reports involving workspace binding bypass, path traversal, symlink escape, secret-file access, local authentication, tunnel credentials, ChatGPT session data, renderer privilege escalation or command execution are sensitive. Include an affected version/commit, minimal reproduction with fictional data, impact/preconditions and any proposed mitigation.

Never attach runtime keys, access tokens, cookies, bindings, private project contents or copied ChatGPT conversations. See [technical security boundaries](docs/security.md).

## 한국어

저장소의 **Security → Report a vulnerability** 또는 위 비공개 신고 양식을 이용하세요. 저장소를 공개할 때 관리자가 이 경로를 확인합니다. 양식이 열리지 않으면 상세 내용을 공개 이슈에 쓰기 전에 [관리자](https://github.com/dev-restart)에게 비공개로 연락하세요.

영향받는 버전, 가상 데이터의 최소 재현 절차, 영향과 발생 조건을 포함하세요. key·token·cookie·binding·실제 프로젝트 파일·대화 내용은 첨부하지 않습니다. 현재는 pre-release 검증 단계이며 안정 버전 지원이나 응답 기한을 약속하지 않습니다.
