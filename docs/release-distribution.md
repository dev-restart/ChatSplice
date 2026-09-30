# macOS 배포와 업데이트

첫 배포는 Apple Silicon용 **unsigned pre-release**입니다. Apple Developer ID 자격 증명 없이 사용할 수 있는 경로이며, 서명·공증된 정식 배포는 별도로 준비합니다. 현재 구현과 실제 GitHub 게시·설치 검증은 구분합니다.

## 자동화

| 실행 조건                             | 수행하는 작업                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| PR 또는 `main` push                   | format/lint/build/typecheck/test, notices, release tooling 검증                 |
| workflow 수동 실행                    | 검증 후 unsigned arm64 DMG·SHA-256을 Actions artifact로 보관; Release 게시 없음 |
| 앱 버전과 일치하는 `v*` 태그 push     | 검증 → packaging → SHA-256 검증 → GitHub Release 자동 게시                      |
| 기본 unsigned release                 | pre-release 표시, DMG와 `SHA256SUMS.txt`, 수동 업데이트                         |
| 서명 옵션을 명시적으로 켠 stable 태그 | 서명·공증·검증한 DMG/ZIP/`latest-mac.yml` 게시, stable 앱 업데이트              |

설정은 [CI workflow](../.github/workflows/ci.yml)와 [unsigned config](../apps/desktop/electron-builder.yml), [signed config](../apps/desktop/electron-builder.signed.cjs)에 있습니다. build job은 `contents: read`이며 Release job만 `contents: write`를 사용합니다. packaging의 `--publish never`는 암묵적인 게시를 막습니다. Release를 draft로 만들고 모든 asset 업로드 성공 후 공개합니다. 같은 태그의 기존 Release는 덮어쓰지 않고 실패합니다. 부분 실패로 남은 draft는 자산과 오류를 점검한 뒤 maintainer가 정리하고 재실행합니다.

일반 Git push는 설치된 앱을 바꾸지 않습니다. `v0.0.1`은 root/desktop `package.json`의 버전이 모두 `0.0.1`일 때만 허용됩니다. 새 릴리스마다 두 파일의 버전을 함께 올리고 lockfile을 갱신·검증합니다. 버전 태그 게시 전 변경 사항을 먼저 commit/push해야 합니다.

```bash
# commit과 main push, hosted CI 성공을 확인한 뒤 명시적으로 실행
# 아래 태그는 desktop/root 버전 0.0.1인 첫 배포용입니다.
git tag v0.0.1
git push origin v0.0.1
```

## 저장소 공개 순서

대상은 [dev-restart/ChatSplice](https://github.com/dev-restart/ChatSplice), maintainer는 [dev-restart](https://github.com/dev-restart)입니다. 공개 전에 source archive와 실제 commit의 포함 파일을 비교하고 credentials, app-private data, workspace binding, 실대화/개인 프로젝트 이미지가 없는지 확인합니다. `pnpm source:pack -- --output /tmp/chatsplice-source.tar.gz`는 제외 규칙을 적용한 source와 SHA-256 manifest를 생성합니다. 저장소에 실제로 등록되는 파일과 일치하는지도 별도로 확인합니다.

1. 비공개 상태에서 첫 commit/push 후 **Actions → CI**가 성공하는지 확인합니다. Actions가 비활성화되었다면 repository Settings → Actions에서 필요한 workflow를 허용합니다.
2. 새 설치와 기존 profile 교체를 시험하고, disposable workspace에서 실제 ChatGPT MCP 읽기·허용된 파일 수정·결과 재읽기를 확인합니다. 로컬 unit test는 이 검증을 대신하지 않습니다.
3. 제품 이름의 기존 사용·권리 확인을 마친 뒤 repository visibility를 공개로 변경합니다.
4. 즉시 Settings → Security에서 **Private vulnerability reporting**을 켜고 [비공개 신고 경로](https://github.com/dev-restart/ChatSplice/security/advisories/new)가 열리는지 확인합니다. GitHub의 해당 기능은 [public repository용](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting)입니다. 비공개 repository에서 404가 반환되는 것은 설정 완료의 증거가 아닙니다.
5. 버전 태그를 push하고 Actions 및 [Release](https://github.com/dev-restart/ChatSplice/releases)의 asset과 체크섬을 확인합니다.

소스 공개는 OpenAI의 공개 plugin 등록과 별개입니다. 각 사용자는 자신의 Developer Mode, Platform organization/ChatGPT workspace association, Tunnel 권한·runtime key, Plugins의 Tunnel app 등록과 tool scan을 설정해야 합니다. [onboarding](onboarding.md)을 참고하세요.

## 설치와 unsigned 업데이트

[Release](https://github.com/dev-restart/ChatSplice/releases)에서 Apple Silicon DMG와 같은 버전의 `SHA256SUMS.txt`를 내려받고 확인합니다.

```bash
shasum -a 256 -c SHA256SUMS.txt
```

DMG를 열고 ChatSplice.app을 Applications로 복사합니다. unsigned 앱은 Gatekeeper 경고가 발생할 수 있습니다. source와 배포자를 확인한 뒤 [macOS의 사용자 승인 절차](https://support.apple.com/102445)를 따르세요. 앱은 보안 설정을 자동 해제하지 않습니다.

업데이트는 미저장 파일을 저장하고 앱을 종료한 뒤 Applications의 기존 앱을 교체합니다. app-private data를 삭제하지 않습니다. workspace·connection·tab metadata와 암호화 key는 기존 profile을 재사용합니다. 미저장 draft 본문과 execution history는 종료 시 사라집니다. 앱 메뉴 **ChatSplice → 업데이트 확인…**은 unsigned/development build에서 Release 페이지를 안내합니다.

앱에는 bundled daemon, node-pty와 `Resources/licenses/`의 MIT·dependency·Electron·Chromium notices가 포함됩니다. `pnpm notices --require-complete`가 packaging을 막는 경우 [license supplements](licenses/README.md)를 검토하세요. Node/Cargo 등 프로젝트 toolchain은 필요한 작업에 따라 별도로 설치해야 합니다.

설치한 앱을 열면 daemon이 실행됩니다. 저장된 설정·runtime key와 automatic start가 켜져 있으면 Tunnel도 실행되고 오류는 bounded backoff로 재시도합니다. OpenAI 계정 로그인·Tunnel 발급·Plugins 등록은 설치 프로그램이 대신하지 않습니다.

## 서명·공증과 앱 업데이트로 전환

기본 config의 `identity: null`은 유지합니다. 인증서만 추가해도 unsigned build가 서명되지 않습니다. 아래 준비를 마친 후 repository **Variable** `CHATSPLICE_SIGNED_RELEASES=true`를 설정하면 stable 버전 태그의 CI만 `pnpm pack:mac:signed`를 선택합니다. signed job은 credentials가 없거나 서명·공증 검증에 실패하면 중단합니다. 수동 dispatch는 계속 unsigned artifact입니다.

GitHub **Secrets**에만 다음 값을 등록합니다. `.env`나 source에는 넣지 않습니다.

| Secret             | 내용                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| `CSC_LINK`         | Developer ID Application 인증서와 private key를 포함한 `.p12`의 base64                  |
| `CSC_KEY_PASSWORD` | 해당 `.p12` 비밀번호                                                                    |
| `APPLE_API_KEY`    | App Store Connect API의 `.p8` private key 원문; CI가 임시 owner-only 파일로 만들고 삭제 |
| `APPLE_API_KEY_ID` | API key ID                                                                              |
| `APPLE_API_ISSUER` | API issuer ID                                                                           |

[전자 서명·공증 안내](https://www.electron.build/v26/docs/mac/)와 Apple 계정 권한을 확인합니다. GitHub Release에는 Actions의 `GITHUB_TOKEN`을 사용하므로 별도 PAT를 앱이나 repository에 저장하지 않습니다. signed provider는 public `dev-restart/ChatSplice`를 사용하며 앱에 GitHub token을 포함하지 않습니다.

서명된 build에만 `chatspliceUpdateChannel: stable` metadata와 GitHub update provider가 들어갑니다. macOS 자동 업데이트에 필요한 ZIP과 `latest-mac.yml`도 생성합니다. [electron-builder의 macOS 업데이트는 서명이 필요](https://www.electron.build/v26/docs/features/auto-update/)합니다.

signed 앱은 시작 시와 6시간 간격으로 stable 버전을 확인합니다. 다운로드는 사용자 선택 후 수행합니다. SHA-512 검증과 native Squirrel staging을 마친 다음, 재시작 선택·미저장 editor 저장/버리기/취소 확인·terminal/daemon 정리를 거쳐 설치합니다. 종료 시 묵시적 설치, downgrade와 pre-release 자동 수신은 끕니다. 메뉴에서 수동 확인할 수 있습니다. 업데이트 권한은 main process에만 있으며 ChatGPT view/MCP에는 노출하지 않습니다.

자격 증명 없는 현재 환경에서는 signed build·notarization·두 signed 버전 사이 실제 업데이트를 검증하지 못했습니다. 첫 unsigned → signed 교체는 수동으로 진행하고, 이후 stable 업데이트는 별도 macOS 기기에서 완료까지 검증한 뒤 정식 사용합니다.
