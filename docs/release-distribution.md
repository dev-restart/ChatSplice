# 소스 공개와 사용자 직접 빌드

현재 배포 방식은 MIT 소스를 공개하고 사용자가 본인 Mac에서 빌드하는 것입니다. 관리형 브라우저까지 사용하려면 Apple Silicon과 macOS 14 이상이 필요합니다. 실제 ChatGPT 도구 권한은 계정과 워크스페이스 정책을 따릅니다. [Playwright 시스템 요구 사항](https://playwright.dev/docs/intro#system-requirements)

앱 버전은 `0.0.2`입니다. MCP descriptor와 control·execution protocol의 현재 값은 [현재 계약](current-contract.md)에서 확인하세요. 배포 전에 [공개 안내](publishing.md)와 [검증 체크리스트](../RELEASE_CHECKLIST.md)를 따릅니다.

## 본인 Mac에서 실행

[소스 저장소](https://github.com/dev-restart/ChatSplice)를 clone하거나 소스 archive를 풉니다. [설치 안내](getting-started.md#first-checkout-and-daily-use)에 따라 Node.js 24, pnpm 10.33.2, Xcode Command Line Tools를 준비한 뒤 소스 폴더에서 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm verify`는 format/lint/build/typecheck/unit/release-script/license 검사를 수행합니다. 소스를 바꾼 뒤 다시 빌드하고 열 때는 `pnpm dev`, 기존 빌드를 열 때는 `pnpm start`를 사용합니다. 개인 실행에는 Apple Developer ID, notarization key 또는 App Store 제출이 필요하지 않습니다.

로컬 페이지 검증에 필요한 관리형 Chromium은 `pnpm browser:setup`으로 준비하며 `pnpm test:browser`로 검증합니다. 프로젝트의 Node/Python/Cargo 같은 toolchain은 작업에 따라 별도로 설치합니다. Tunnel과 실제 ChatGPT 계정 연결은 사용자가 자신의 계정으로 설정합니다. 계정 권한과 서비스 사용 조건은 [연결 안내](onboarding.md)를 따릅니다.

## 선택 사항: 개인 설치용 unsigned 앱

개발 실행 대신 본인 Applications 폴더에 설치하려면 다음 명령을 사용합니다.

```bash
pnpm pack:mac
```

`apps/desktop/release/`에 arm64 `.app`과 DMG를 만듭니다. 기본 config는 `identity: null`이고 packaging은 `--publish never`를 사용합니다. 인증서를 찾거나 자동 게시하지 않습니다. 패키징 성공·실패 뒤에는 source 실행용 build identity가 자동 복원됩니다. 생성된 앱에는 bundled daemon과 native binding, MIT·dependency·Electron·Chromium notices가 포함됩니다. 기존 앱의 작업을 저장하고 정상 종료한 뒤 새 앱을 설치하세요. macOS가 실행을 막으면 출처를 확인하고 OS의 사용자 승인 절차를 따릅니다. 앱이나 빌드 스크립트가 보안 설정을 해제하지 않습니다.

개인 설치용 package 검증은 다음과 같습니다.

```bash
pnpm test:packaged -- --app apps/desktop/release/mac-arm64/ChatSplice.app --browser
```

이 검사는 임시 profile과 packaged Electron Node runtime으로 daemon·도구·실행·browser·Goal·cleanup을 확인합니다. 실제 계정 호출, native 키보드 입력과 다른 Mac에서의 설치를 대신하지 않습니다.

## 소스 업데이트

미저장 editor 내용을 저장하고 실행 중 작업을 정리한 뒤 기존 앱을 정상 종료합니다. 새 소스를 받고 locked 의존성을 복원한 뒤 `pnpm verify`와 `pnpm start`를 실행합니다. app-private data를 지우지 않습니다. workspace 등록, 연결 설정과 암호화된 key, 저장된 Goal은 기존 profile을 사용하지만 미저장 draft와 memory-only 실행 기록은 재시작 후 복원되지 않습니다.

앱 메뉴 **ChatSplice → 소스 업데이트 안내…**는 소스 저장소를 엽니다. development/unsigned 앱은 업데이트를 자동 다운로드·설치하지 않습니다. 이전 daemon의 실행 계약이 다르면 자동 종료하거나 재사용하지 않고 정상 종료·재빌드를 안내합니다. MCP 도구 정의 새로고침만으로 실행 중 코드가 바뀌지는 않습니다.

## CI와 소스 archive

공개 GitHub 저장소에 push하면 독자는 README와 소스를 볼 수 있고, **Code** 메뉴에서 내려받아 직접 빌드할 수 있습니다. 비공개 저장소에 push한 소스는 저장소 접근 권한이 있는 사용자에게 표시됩니다. 설치용 DMG나 `.app`을 담은 ZIP을 배포하려면 별도로 GitHub Release에 파일을 올립니다.

[CI](../.github/workflows/ci.yml)는 PR, `main` push, `v*` 태그와 수동 실행에서 검증만 수행합니다. 모든 job의 repository 권한은 `contents: read`입니다. Apple Secrets, signed build job, GitHub Release 게시 job, 앱 asset 업로드와 update feed 운영은 활성 workflow에서 제거했습니다. 기존 opt-in signed packaging 코드가 남아 있어도 기본 빌드나 CI가 호출하지 않습니다.

소스 archive를 로컬에 만들려면 기존 파일과 겹치지 않는 경로를 지정합니다.

```bash
pnpm source:pack -- --output /tmp/ChatSplice-0.0.2-source.tar.gz
```

검토용 소스와 파일별 SHA-256 manifest를 만듭니다. 앱 profile, credential 파일, 로컬 진행 기록, 런타임 DB, 빌드 결과와 Git 이력은 포함하지 않습니다. 이 명령은 commit, push 또는 업로드를 하지 않습니다. Archive의 파일 목록을 실제 공개할 commit과 비교하고, [LICENSE](../LICENSE)와 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)를 함께 보존합니다.

## 사용자가 직접 확인할 부분

보완된 소스로 빌드하고 이전 앱을 정상 종료한 다음, 임시 프로젝트에서 다음을 확인합니다.

1. 자신의 ChatGPT 계정으로 로그인하고 Tunnel을 통해 커스텀 MCP 서버를 연결합니다. [현재 계약](current-contract.md)의 descriptor와 24개 도구를 확인하고 새 Project 채팅을 시작합니다.
2. MCP로 파일 read → SHA edit → re-read → 기존 check를 실행합니다. Background 서버의 readiness와 browser assertion의 실제 결과, 종료 후 cleanup을 확인합니다.
3. Native workbench에서 editor 입력·저장·외부 변경 충돌·dirty 탭 닫기, terminal 입력·탭 추가·프로젝트 전환·패널 크기 조절을 확인합니다. 이 터미널은 일반 OS 사용자 권한이며 MCP sandbox와 별개입니다.
4. Goal을 생성하고 checkpoint·pause·resume을 조작합니다. 근거 누락 시 complete 거부, 현재 파일/check/browser 근거 확인 후 완료를 확인합니다. 앱 재시작 후 Goal 복원과 명시적 resume도 확인합니다.

소스 검사와 브라우저의 renderer fixture는 실제 계정 권한이나 native 입력 성공의 증거가 아닙니다. 실제 결과와 미확인 사항은 [검증 체크리스트](../RELEASE_CHECKLIST.md)를 기준으로 구분합니다. 소스 공개는 ChatGPT 공개 앱 등록과 별개이며, 다른 사용자도 본인의 계정·Tunnel 권한을 직접 설정합니다.
