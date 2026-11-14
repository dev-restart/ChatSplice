# 폴더 작업 승인과 반복 요청 보완 — 2026-10-25

## 결과와 적용 범위

소스 수정과 별도 runtime 빌드를 완료했다. Control protocol은 **5**, MCP descriptor는 **0.0.20**, execution contract는 **development-runtime-4**, MCP 도구 수는 **24**다. 실행 중인 앱·daemon은 교체하지 않았다. native 승인창 실제 렌더링·입력과 현재 ChatGPT 계정에서 승인창이 더 이상 나타나지 않는지는 소스 검사 결과로 대신하지 않는다.

사용자 요청은 새 폴더에서 읽기·쓰기·명령 실행을 매번 구분해 요청하지 않고, 허용된 범위에서 현재 LLM이 필요한 작업을 선택하는 흐름이었다. 별도 모델이나 자동 ChatGPT 메시지 전송을 추가하지 않는다.

## 두 승인 체계

| 구분                   | 결정 대상                                           | 제어 위치                             |
| ---------------------- | --------------------------------------------------- | ------------------------------------- |
| ChatGPT의 앱 도구 승인 | 연결된 MCP 도구를 호출할 때 확인할지 여부           | ChatGPT의 공식 앱별 승인 설정         |
| ChatSplice의 폴더 승인 | 어느 프로젝트가 어느 외부 폴더에 어떤 권한을 갖는지 | 로컬 native 승인창과 저장된 폴더 관계 |

ChatGPT는 앱별 승인 설정을 제공한다. 사용 가능한 정책과 고위험 작업 예외는 계정·워크스페이스에 따라 달라질 수 있다. MCP 서버가 호스트의 승인 상태를 강제로 덮어쓰거나 승인창을 자동 클릭하지 않는다. 파일을 바꾸고 명령을 실행하는 도구를 읽기 전용으로 표시하지 않는다.

공식 근거: [앱 권한](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security#apps-plugins-and-connected-accounts), [앱별 승인 정책](https://developers.openai.com/plugins/changelog#app-permission-controls-in-chatgpt), [도구 annotation](https://developers.openai.com/plugins/reference#annotations).

## 구현한 동작

신규 `fs.reference_request`에서 `access_mode`를 생략하면 `read_write` 작업 권한을 제안한다. 조회 전용 요청은 `read_only`를 명시한다. 요청 생성만으로 폴더를 열거나 권한을 부여하지 않는다. 상대경로와 제어문자가 포함된 경로는 native 창에 전달하기 전에 거부한다.

Native 창은 **거부 / 이 폴더에서 작업 허용** 두 버튼과 **읽기 전용으로 연결** 체크박스를 제공한다. 한국어·영어를 지원하며 기본·취소 버튼은 거부다. 명시적 읽기 전용 요청 및 구형 모드 누락 상태는 체크박스를 기본 체크한다. 결과에 체크 상태가 없으면 쓰기 권한으로 추정하지 않고 거부한다. 실제 owner 선택 모드가 저장되고 승인 결과에도 반환된다. 기존 저장 관계에서 모드가 없는 경우는 계속 읽기 전용이다.

승인한 폴더는 `fs.reference_list`에서 실제 모드를 확인한 뒤 `reference_workspace_id`를 재사용한다. 원래 source binding을 유지하고 폴더 기준 상대경로로 파일 도구와 실행 도구를 선택한다. 이 흐름은 읽기·편집·검사마다 새 폴더 승인을 요청하지 않는다. 권한을 바꾸거나 다른 폴더를 연결하는 요청은 별도 결정이다.

응답 유실·busy 상태에서는 같은 요청 ID의 같은 승인 여부와 모드를 재전송한다. 서버는 동일한 동시 재전송에 하나의 적용 작업을 공유하고, 완료된 결정의 재전송에는 저장한 결과를 반환한다. 다른 결정은 두 번째 권한 적용 전에 거부한다. 실패한 첫 요청 때문에 다른 프로젝트의 승인 요청이 계속 밀리지 않도록 dispatcher가 순환 처리한다.

요청 생성 시 source root를 내부에 고정한다. 승인 전과 폴더 관계 저장 시 원래 경로를 검증하며, 적용 중에는 요청 만료·source 프로젝트 제거·root 변경으로 완료 결과가 사라지지 않도록 보호한다. 이 내부 경로는 공개 요청 상태에 추가하지 않는다.

Owner 결정 입력은 MCP catalog digest 밖에 있으므로 control protocol을 5로 올렸다. 새 desktop이 protocol 4 daemon을 재사용하지 않으며 기존 앱·작업을 자동 종료하지 않는다. 공개 도구의 설명과 생성되는 프로젝트 지침도 최종 저장 권한 확인·기존 연결 재사용을 안내한다. 지침의 기존 6,000자 한도를 유지했다.

## 로그와 작업 중 확인한 문제

- 저장소 루트와 깊이 3 범위에서는 별도 raw `.log` 파일을 찾지 못했다. 이전 실행 로그·요청 상태는 memory-only이므로 저장되지 않은 과거 작업의 로그까지 복구했다고 주장하지 않는다.
- 기존 진행 기록의 반복 승인·HTTP 400은 legacy SQLite의 reference kind migration 문제였고 이미 수정된 기록이다. 이번 반복 표시의 원인으로 다시 단정하지 않는다.
- 실제 `environment` 호출에서 존재하지 않는 다른 생태계의 선택 manifest·lockfile 17개가 `invalid`로 나와 `manifest_invalid`를 발생시키는 것을 확인했다. 기존 경로 resolver가 missing leaf를 일반 BAD_REQUEST로 바꾸는 것이 원인이었다. 실제 부모 경로를 검증한 뒤 leaf에 `lstat`를 적용하여 `missing`으로 구분했다. 디렉터리·symbolic link·dangling link·hard link 거부는 유지한다.
- Shared-folder integration의 atomic rename은 link 후 unlink를 사용한다. 저장소 cwd 아래 fixture는 바깥 검사 sandbox의 file-link 범위에 들지 않았다. fixture를 job-private `TMPDIR`로 이동해 실제 rename 검사를 통과시켰고, 제품의 sandbox 권한과 rename 구현은 바꾸지 않았다.
- 기존 native `project.run` integration 1개는 여전히 실패한다. 직접 core 테스트로 좁혀 `createProjectRuntimeDirectory`의 `mkdtemp('/private/tmp/cs-r-*')`가 중첩 실행 환경에서 `EPERM`을 내는 것을 확인했다. 테스트의 통과 조건을 바꾸거나 실행 권한을 완화하지 않았다.

## 검증

| 검사                                                                 | 결과                                         |
| -------------------------------------------------------------------- | -------------------------------------------- |
| Protocol owner 결정·프로젝트 지침                                    | 8개 통과                                     |
| MCP 요청 저장소                                                      | 21개 통과                                    |
| 실제 owner control → MCP 파일 권한 통합                              | 11개 통과                                    |
| 환경 검사                                                            | 10개 통과                                    |
| 공개 tool catalog                                                    | 3개 통과                                     |
| Desktop dispatcher·client·supervisor·identity·auto-attach·connection | 74개 통과                                    |
| 기존 runtime 통합                                                    | 27개 통과, native project.run 1개 실패       |
| 실패층 확인용 기존 core native 테스트 1개                            | EPERM 재현; 성공으로 집계하지 않음           |
| Protocol·core·MCP·desktop·renderer 타입 검사                         | 모두 통과; Svelte 오류·경고 0                |
| 변경 코드 ESLint                                                     | 통과                                         |
| `pnpm build:staged`                                                  | 통과; main/preload/renderer/daemon 빌드 완료 |

핵심 검사는 `node scripts/check-workspace-folders.mjs unit <protocol|mcp|desktop>`로 실행했으며 source alias와 별도 검사 디렉터리를 사용했다. 원본 `dist`를 교체하지 않았다. Native dialog 검사는 Electron API 경계의 단위검사이며 실제 macOS 팝업 클릭을 수행한 검사가 아니다.

남은 native 실행 검사는 중첩되지 않은 정상 macOS 환경에서 다음 기존 기준으로 확인한다.

```sh
node scripts/check-workspace-folders.mjs unit core src/project/run-task.test.ts -t 'runs only an existing allowlisted script with a sanitized environment on macOS'
node scripts/check-workspace-folders.mjs unit mcp src/runtime.test.ts -t 'lets bound Chat run an allowlisted project check without a worker handoff'
```

## 빌드와 적용

별도 빌드: `node_modules/.cache/chatsplice-runtime-GzycXA`

- Source snapshot: `9459bf8c3ad9762ee4f83d0fa6948ebd3b14141f0a04b915586841bb3af150bb`
- Desktop build: `4b2953f1f0d9517de6feb7fd93bd52e246e7d41ade3332de9b2e7a277c04e923`
- Daemon build: `84b9f9afcedc119bac3a0174dc6fe7f540597e277e051b0af68a85aed64dd4c4`
- Tool schema digest: `9bcd0953883917c5c968e6b1863aa5eff3cf35fae11230dd76711bd0fa78cbaa`

현재 작업과 미저장 편집을 마무리한 뒤 앱·daemon을 정상 종료하고, 원본 저장소에서 아래 명령으로 준비된 빌드를 실행한다.

```sh
pnpm --dir node_modules/.cache/chatsplice-runtime-GzycXA start
```

이 candidate는 원본 checkout의 설치된 의존성을 연결해 쓰는 로컬 runtime이며 배포용 독립 패키지가 아니다. 새 앱을 적용한 후 연결된 ChatGPT MCP 정의를 Refresh하고 native 폴더 승인에서 읽기 전용/작업 권한 선택과 이후 도구 호출을 확인한다. 연결 정의 Refresh만으로 구 daemon 코드가 바뀌지는 않는다.

기존 사용자 변경은 SHA 보호로 보존했고 commit/push 및 실행 중인 앱 재시작은 수행하지 않았다.
