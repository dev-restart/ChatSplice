# 프로젝트 최근 대화·새 대화와 Goal 다시 점검 — 2026-10-21

## 변경 범위

프로젝트 이동 시 최근 대화가 바로 보이도록 하고, 프로젝트의 새 대화를 해당 ChatGPT 프로젝트에서 시작하도록 보완했다. Goal에는 기존 목표를 유지한 채 검증 기록을 비우는 명시적 동작을 추가했다. 이번 변경의 소스 계약은 MCP descriptor `0.0.18`, execution contract `development-runtime-4`, control protocol `4`, 공개 도구 24개다. 실행 정책을 전면 해제하거나 별도 모델을 호출하는 변경은 아니다.

## 프로젝트 이동과 새 대화

- 왼쪽 프로젝트를 누르면 그 프로젝트에서 최근 활성화한 로컬 ChatGPT 뷰를 전면에 표시한다. 이전에 편집기가 활성화되어 있었어도 프로젝트 진입은 ChatGPT를 보여 준다. 기존 편집 탭·미저장 draft·undo 상태는 보존한다.
- 프로젝트의 새 대화는 확인된 ChatGPT 프로젝트 홈으로 이동해 해당 프로젝트의 새 대화 입력을 시작한다. 프로젝트 홈을 확인할 수 없으면 전역 새 대화로 대신 이동하지 않는다.
- 로컬 대화 탭의 활성 시각과 확인된 프로젝트 URL을 앱 내부에 저장해 재시작 뒤 선택에 사용한다. 과거의 일반 `/c/` 대화 URL만으로 프로젝트 소속을 추측하지 않는다. 기존에 확인된 연결 정보를 복원하거나 사용자가 올바른 프로젝트를 열어 연결을 확인해야 한다.
- 2026-10-22 보완: 프로젝트를 눌렀는데 사용할 수 있는 탭이 없고(다른 Project 화면으로 이동해 연결 확인이 해제됨) 앱에 저장된 확인된 프로젝트 주소가 있으면, 그 프로젝트의 가장 최근 탭을 저장된 주소로 되돌려 이동한다. 주소는 앱 내부 저장값만 사용하며 다른 프로젝트의 주소나 일반 대화로 추측하지 않는다. 이동만으로는 연결 확인을 복원하지 않고 ChatGPT 페이지에서 스크립트를 실행하지 않는다. 지침 저장 재확인은 기존 연결 흐름이 맡는다. 새 대화는 여전히 확인된 프로젝트 홈이 필요하다. 저장된 주소가 없으면 기존처럼 탭 생성/설정 흐름으로 진행한다.
- 2026-10-22 보완: 프로젝트 탭은 고정된 프로젝트 안에서 마지막으로 본 위치(프로젝트 홈 또는 `/g/<id>/c/<id>` 대화)를 앱 내부에만 저장한다. 그 탭이 일반 대화나 다른 ChatGPT 페이지로 이동한 뒤 프로젝트를 누르면 저장한 위치로 돌아간다. 이미 프로젝트 안에 있으면 다시 불러오지 않는다. 다른 프로젝트의 주소나 일반 대화는 복원 대상으로 쓰지 않으며 주소는 렌더러에 노출하지 않는다.
- 2026-10-22 사이드바: 프로젝트 행은 이름만 보이고 상태는 점과 접근성 텍스트로만 표시한다. 마우스를 올리면 경로·연결 상태 카드가 사이드바 안에 나타나고, 오른쪽 새 대화 아이콘은 프로젝트 홈에서 새 입력을 시작하며, ⋯ 메뉴는 프로젝트 설정·이름 변경·Finder에서 보기·최근 실행·제거를 제공한다. 하단은 상태 점이 붙은 설정 아이콘 하나이며 설정 화면에는 연결·화면·도움말·버전만 둔다. 프로젝트별 대화 목록은 웹을 호출하는 구조라 가져오지 않는다.
- 2026-10-22 홈 주소 복구: 프로젝트 홈 주소가 저장되기 전에 연결된 프로젝트는 새 대화 아이콘이 `project_chat_url_unavailable`로 실패했다. 이제 새 대화는 그 오류 때문에 한 번만 지침 확인을 실행한다. 메인 프로세스는 탭의 `/g/g-p-…/c/…` 주소에서 `/g/g-p-…/project` 홈 후보를 만들어 이동하고, 지침의 workspace_id·workspace_binding이 일치할 때만 확인된 주소로 저장한 뒤 새 대화를 연다. 일치하지 않거나 `g-p-` 프로젝트 주소가 아니면(일반 GPT, 홈 주소만 있는 탭) 아무것도 저장하지 않고 기존 안내를 유지한다. `/projects` 목록을 읽거나 이름으로 추측하지 않는다.
- 2026-10-22 프로젝트 키 저장소: 확인된 프로젝트 홈 주소가 정해지면(새 프로젝트 생성 직후, 수동 연결 확인, 지침 갱신·복구 확인) 그 `g-p-…` 키를 워크스페이스별로 앱 내부 탭 상태(`project_keys`)에 따로 저장한다. 탭이 닫히거나 확인 표시가 풀려도 키는 남으며, 프로젝트 클릭에 사용할 탭이 없으면 저장된 키의 홈으로 새 탭을 열고 새 대화도 같은 홈에서 시작한다. 워크스페이스를 제거하면 키도 지운다. 키는 렌더러에 노출하지 않는다.
- 2026-10-22 설정 정리: 연결·MCP 앱 이름·연결 키 설정은 사이드바 설정 화면에 직접 둔다(별도 연결 관리 창 없음). 빌드 ID·schema·저장된 Goal 수는 화면에 표시하지 않고, daemon과 앱 빌드가 어긋났을 때만 재시작 안내를 보인다. 버전(앱·MCP)은 설정 화면 맨 아래 한 곳에만 표시한다. 도움말은 도움말 창 한 곳에 모은다(사용 순서, 여러 폴더 사용, 연결 값 찾는 법). 개별 `?` 도움말 창은 없앴다.
- 2026-10-22 프로젝트 설정 창: 프로젝트 상태, 로컬 폴더, Project 연결, 함께 사용할 폴더, 제거만 남긴다. 프로젝트 열기·새 대화는 사이드바에 있으므로 창 하단에는 완료만 둔다. 사이드바에서 프로젝트를 끌어 순서를 바꿀 수 있으며(Alt+↑/↓ 키보드 대안) 순서는 이 앱 화면의 로컬 저장소에만 저장한다.
- 2026-10-22 로컬 MCP 자동 첨부 중단: 실제로 안정적으로 동작하지 않아 프로젝트별 토글 UI를 없애고 dispatcher를 시작하지 않는다. 기존 저장 플래그는 지우지 않지만 효력이 없다. 메시지마다 `@` 목록 또는 `+` → 더 보기에서 앱을 선택한다. 이는 2026-09-08 auto-attach amendment를 대체한다.
- 2026-10-22 마크다운 읽기 모드: `.md`·`.markdown` 파일을 편집기에서 열면 '편집 | 읽기' 전환이 나타나고 기본은 읽기다(선택은 이 앱 화면에 기억). 읽기는 `marked`가 만든 토큰을 Svelte 텍스트 노드로만 그려서 문서 안의 원시 HTML·스크립트·`javascript:` 링크가 실행되거나 이동·로드되지 않는다. 링크는 이동하지 않고 주소만 툴팁으로 보이며 이미지는 `[이미지: 대체 텍스트]`로 대신한다. 편집기는 숨겨 둘 뿐 닫지 않아 입력·되돌리기 상태가 유지되고, 읽기 화면은 저장되지 않은 현재 내용을 보여 준다.
- 2026-10-22 문구: 안내·알림·오류·도움말·프로젝트 설정·연결 문구를 해요체로 통일하고 내부 용어(binding, workspace, daemon 등)를 줄였다. 실행 실패 진단과 Goal 화면 문구는 이번에 손대지 않았다. 앱을 다시 띄울 때 이전 빌드의 `chatspliced`가 남아 있으면 새 앱이 시작 화면에서 멈출 수 있으므로, 앱을 정상 종료한 뒤 남은 daemon도 정상 종료(SIGTERM)하고 다시 시작한다.
- 이 동작은 대화 화면을 선택하거나 연다. 대화 본문을 수집하거나 메시지를 자동 전송하지 않는다.

추가로 사이드바의 선택 값을 legacy reactive 복사본에서 직접 상태 getter로 연결해 polling 없이 즉시 갱신되게 했다. 선택이 진행 중이거나 이후 선택 revision이 바뀌면 오래된 tabs/panel·이름 보정·지침 동기화 응답을 적용하지 않는다. 전역 새 채팅에서는 다음 상태 조회 후에도 프로젝트를 잘못 강조하지 않는다. UI 회귀 검사는 polling 응답을 의도적으로 보류해 이 동작을 확인한다.

이 규칙은 과거 project editor amendment의 “프로젝트 진입 시 마지막 편집 탭을 전면 복원” 동작만 대체한다. 편집 상태 보존과 파일 저장의 revision/SHA 검사는 유지한다.

## Goal 기록 비우고 다시 점검

Goal 화면의 **기록 비우고 다시 점검**은 확인 창에서 **검증 기록 초기화**를 눌렀을 때만 `project.goal_update(action: "reset")`을 호출한다. 확인을 열었을 때의 Goal ID와 revision을 고정하며, 그 사이 기록이 갱신되면 확인 버튼을 비활성화한다. 선택한 프로젝트/Goal이 바뀌면 확인을 닫는다.

| 항목                                                               | 초기화 결과                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Goal ID·목표·범위·완료 기준 정의                                   | 유지                                                           |
| 프로젝트 root identity·추적 파일 경로                              | 유지                                                           |
| 기존 추적 파일의 SHA baseline·checkpoint 파일 snapshot와 저장 시각 | 유지. 새 검증 성공으로 해석하지 않음                           |
| 완료 기준의 상태·근거                                              | 모두 `pending`, evidence 제거                                  |
| checkpoint의 진행 요약·다음 단계                                   | 비움                                                           |
| 화면에 보이는 실행 receipt                                         | 비움                                                           |
| 누적 실행 사용량·예산·기한                                         | 유지                                                           |
| 이전 요청의 중복 실행 방지 ledger                                  | 유지                                                           |
| Goal 상태                                                          | 같은 Goal을 `paused`로 저장                                    |
| 새 검사·명령 실행                                                  | 자동 실행 없음. 명시적 resume에서 현재 파일을 재검증한 뒤 진행 |

reset은 최신 revision과 원래 root 일치를 검증하며 읽기 전용 정책을 따른다. 소유한 queued/running 작업이나 cancellation 정리가 있으면 거절한다. 지연된 종료 callback이 초기화한 receipt·근거를 다시 만들지 않도록 현재 receipt 연결도 확인한다. 유한 예산을 초기화해 추가 실행량을 얻거나 과거 request ID를 재실행하는 동작은 아니다.

아직 저장하지 않은 Goal 진행 요약 입력도 확인 후 비운다. 완료 기준과 실행 설정·저장 기록은 기본으로 접어 두어 핵심 목표와 다음 동작이 먼저 보이게 했다.

### 다른 삭제 동작과의 구분

- **완료 기록 정리**는 기존 기능대로 최신 revision과 소유 작업 종료를 확인한 `completed`/`cancelled` Goal만 삭제한다. 미완료 Goal이나 프로젝트 파일은 지우지 않는다.
- **다시 점검**은 Goal을 삭제하지 않는다. 별도의 실행 작업 기록과 ChatGPT 대화 기록도 삭제하지 않는다.
- 이번 작업에서 실제 사용자 Goal을 초기화·삭제하지 않았다. 현재 연결된 ChatSplice 프로젝트의 Goal은 0개였으며 변경 검사는 별도 fixture로 수행한다.

## 실제 공개 shell 실행 확인

아래는 현재 연결된 관리 shell 경로에서 수행한 확인이다. 새 descriptor의 활성화나 전용 Cargo 경로의 통과 근거와는 구분한다.

| 확인 범위               | 관측 결과                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------- |
| 언어 runtime            | Node 24.18, Python 3.13.7, Rust 1.96, Go 1.26.2, Elixir 명령 실행 확인                |
| Python 의존성           | 격리된 임시 venv에서 로컬 wheel을 offline 설치하고 import 성공                        |
| Node 의존성             | 로컬 npm tarball 설치·의존성 postinstall·import, bare install의 root postinstall 성공 |
| sh·파일 쓰기            | sh pipe 처리, Node/Python의 테스트 소유 파일 덮어쓰기 성공                            |
| Node/Python HTTP와 curl | `127.0.0.1`과 `localhost` GET, JSON POST 요청·응답 확인                               |
| 외부 HTTPS              | 외부 통신을 허용한 실행에서 `https://example.com` HTTP 200                            |
| 관리 background 실행    | 공개 실행 도구의 서버 시작·readiness·cancel 확인                                      |

외부 DB 접속은 검사하지 않았다. 위 결과는 모든 프로젝트의 의존성 설치나 모든 서비스 연결을 보장하지 않는다. 전용 Cargo 캐시 복구와 `/bin/ps`의 기존 OS 거부는 별도 문제다. 이번 일반 shell 성공을 별도 테스트 프로젝트의 Cargo·프로세스 소유권 검사 통과로 보고하지 않는다. 이전 캐시 복구·native 진단의 구현과 남은 적용 절차는 [Cargo 복구 기록](cargo-cache-process-recovery-20261021.md)을 따른다.

## 구현 검사와 실제 적용 상태

| 검사                             | 결과                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Protocol                         | 10개 통과                                                                                 |
| Desktop                          | 81개 통과                                                                                 |
| Goal service·인증된 catalog      | 37개 통과                                                                                 |
| 위 세 묶음 합계                  | 128개 통과                                                                                |
| TypeScript/Svelte typecheck      | 오류 0, 경고 0                                                                            |
| Goal UI Chromium fixture         | 통과. 확인·취소·revision/프로젝트 변경·소유 실행·입력 초기화·자동 실행 부재 확인          |
| 프로젝트 이동·새 대화 UI fixture | 통과. 한국어/영어·300px·즉시 선택·이전/진행 중 refresh 응답 차단·일반 채팅 선택 해제 확인 |
| 최종 format/lint                 | 변경 파일 Prettier 검사·관련 ESLint 통과                                                  |
| 최종 staged build·identity 확인  | 성공. descriptor 0.0.18·공개 도구 24개·desktop/daemon schema identity 기록                |

브라우저 fixture는 확인 전·취소 시 reset 미호출, 최신 revision 충돌, 프로젝트 변경, 소유 작업 진행 중 차단, 확인 후 보존/초기화 범위와 자동 실행 부재를 검증한다. 실제 사용자 데이터나 ChatGPT 대화 전송을 사용하지 않는다.

진단 시점의 활성 daemon은 descriptor `0.0.16`·`development-runtime-3`였으며 이번 작업에서 기존 앱/daemon을 교체하지 않았다. 소스·fixture·staged build 성공과 실제 활성 runtime을 별도 상태로 기록한다. 새 버전 적용은 진행 중 작업을 정리한 뒤 앱/daemon을 정상 종료하고 검증한 실행본으로 시작한 다음, MCP 연결 도구 정의를 갱신해 실제 catalog identity와 reset 스키마를 확인하는 순서다. 연결 도구 새로고침만으로 기존 daemon이 재시작되는 것은 아니다.

최종 실행본 및 확인 근거: 실행본은 `node_modules/.cache/chatsplice-runtime-mKuaHp`이며 2026-10-21T14:44:57.115Z에 빌드했다. `runtime-candidate.json`의 source SHA는 `ad5b9ec43ddfc0b4732e34e141733d161874743bae396d8625afb884d34d209d`, tool schema digest는 `bd240cd47bb7e19b4728fa6f252ef6d0aa741beaaa328e289a157d3e29f2d6e9`다. 기존 앱/daemon을 정상 종료한 뒤 저장소에서 `pnpm --dir node_modules/.cache/chatsplice-runtime-mKuaHp start`로 시작할 수 있다. 이 실행본의 renderer로 두 UI smoke를 재실행해 모두 통과했다.

별도 테스트 프로젝트/별도 음성 프로젝트의 파일·Goal·전체 검사는 이번 범위에서 변경하거나 재실행하지 않았다. 해당 프로젝트에서 같은 오류가 해결되었는지는 새 runtime 적용 후 정확한 연결과 원래 실패 명령으로 별도 확인해야 한다.

### 재검증 명령

```sh
node scripts/check-workspace-folders.mjs unit protocol src/goal.test.ts
node scripts/check-workspace-folders.mjs unit desktop src/main/project-chat-navigation.test.ts src/main/chatgpt-tabs.test.ts src/main/editor-ipc.test.ts src/main/chatgpt-web-navigation.test.ts
node scripts/check-workspace-folders.mjs unit mcp src/goal/service.test.ts src/mcp/tool-catalog.test.ts
node scripts/check-workspace-folders.mjs types
CHATSPLICE_RENDERER_DIR=node_modules/.cache/chatsplice-runtime-mKuaHp/apps/desktop/dist/renderer node apps/desktop/scripts/project-navigation-ui-smoke.mjs
CHATSPLICE_RENDERER_DIR=node_modules/.cache/chatsplice-runtime-mKuaHp/apps/desktop/dist/renderer node apps/desktop/scripts/goal-ui-smoke.mjs
```

현재 공개 browser 도구로도 별도 fixture를 열어 좁은 프로젝트 목록과 Goal의 기본/초기화 확인/paused 화면을 관찰했다. Goal fixture의 초기 터미널 화면에서는 inline-style CSP 콘솔 메시지가 관측됐으며, 이번 검증은 native 터미널 스타일 정책의 정상 판정까지 포함하지 않는다. Goal·프로젝트 UI smoke의 page error는 없었다. 테스트 서버와 browser session은 확인 후 정리했다.
