# GPT 웹 기반 개발 루프

목표는 ChatGPT 웹의 현재 대화가 판단하고 Local MCP가 로컬 실행을 담당하는 것이다. 별도 Codex/Pi/Claude 모델, ChatGPT 입력창 자동 전송, 권한 우회는 추가하지 않는다. 도구 가용성과 사용량 정책은 별개이며 사용량 절약을 보장하지 않는다.

## 작업 시작과 재개

AGENTS.md, 디자인 지침, 존재하는 docs/agent-progress.md를 읽고 사용자 요청의 범위와 합격 기준을 먼저 정한다. 경로가 알려졌으면 바로 읽고, 아니면 좁은 목록/문자열 검색으로 찾는다. 저장소 전체를 읽지 않는다. 진행 기록은 참고 자료이지 현재 파일 상태나 권한의 근거가 아니다. 재개할 때 변경 파일과 실제 실행 상태를 다시 확인한다.

긴 작업의 진행 기록에는 요청 범위, 수정 파일, 실행한 검사와 정확한 결과, 미확인 항목, 다음 한 단계를 적는다. 비밀값, 계정 쿠키, 바인딩은 기록하지 않는다. live job/proposal/browser 상태는 재시작 후 유지되지 않는다. 사용자가 Goal 기능을 요청한 작업은 아래 영속 Goal 흐름을 사용한다.

## Goal 생성과 명시적 재개

사용자가 “이 작업을 Goal로 등록하고 계속 진행해 줘”처럼 자연어로 요청하면 파일 경로나 기술적인 기준을 사용자가 직접 채우게 하지 않는다. `project.goal`로 기존 Goal을 먼저 조회하고 관련 코드·manifest·검사 script를 조사해 objective·scope·추적 파일·완료 기준을 정한다. 같은 미완료 Goal을 이어가는 요청은 기존 ID를 재사용한다. 생성 응답이 불확실하면 목록을 다시 읽어 중복 생성을 피한다.

`project.goal`로 현재 프로젝트의 Goal을 읽는다. 사용자 요청으로 새 Goal을 만들 때만 `project.goal_update`의 create를 호출하며 objective·scope·tracked_paths와 file/check/browser criteria를 선언한다. 일반 파일 수정마다 Goal을 자동 생성하지 않는다. tracked_paths는 디렉터리나 `.` 대신 구체적인 상대 UTF-8 파일 1–32개이며 파일당 1 MiB·전체 8 MiB 이내다. 앞으로 만들 파일은 아직 없어도 된다. tracked set에는 변경 파일뿐 아니라 검사에 영향을 주는 manifest·lockfile·관련 소스를 포함한다. 추적하지 않은 파일의 변경까지 daemon이 검증한다고 가정하지 않는다. criterion은 생성 뒤 immutable이므로 합격 기준을 바꿀 때는 새 Goal로 명시한다.

Goal에 연결할 execution에는 `goal_id`를 붙인다. 검사 근거에는 `criterion_id`도 붙여 선언한 node_script/Cargo operation·cwd 또는 browser assertion과 정확히 연결한다. 다른 shell·install·server job은 receipt를 남기지만 criterion을 통과시키지 않는다. file criterion은 `verify_file`로 현재 파일을 읽어 검증한다. code 의미나 사용자 여정의 합격 여부는 현재 ChatGPT 대화가 실제 근거와 사용자 기준으로 판단한다.

변경 후 검사, file SHA와 Goal 상태를 다시 읽고 응답의 revision을 다음 mutation의 `expected_revision`으로 사용한다. 실행 hook이 revision을 바꿀 수 있으므로 저장해 둔 revision으로 덮어쓰지 않는다. checkpoint에는 수행 결과와 미확인 사항을 summary, 다음 한 단계를 next_step으로 저장한다. paused/interrupted 작업은 현재 root·tracked file 상태를 읽고 명시적으로 resume한다. 근거가 stale이면 같은 기준으로 다시 검사한다. 재시작된 명령을 자동 replay하지 않는다.

pause는 신규 제출·queued 시작을 막고 실행 중인 작업은 종료할 수 있다. cancel은 해당 Goal의 owned job cleanup만 기다리며 파일 변경을 rollback하지 않는다. deadline·execution budget은 local execution 한도이며 ChatGPT 요금·추론 사용량 제한을 보장하지 않는다. 최종 checkpoint는 complete 전에 저장한다. 완료된 Goal에는 checkpoint를 다시 쓸 수 없다. 기한·한도가 소진된 active Goal은 owned 실행 종료 확인 뒤 pause→최신 조회→명시적인 resume 갱신을 거친다. 새 Goal은 max_executions: 0이 기본으로 횟수 제한이 없다. 기존 양수 예산은 사용자의 계속 진행·제한 해제 요청에 따라 resume에서 0으로 갱신할 수 있다. 저장된 값이 이미 0이고 예산 변경이 필요 없다면 optional max_executions를 생략해 그대로 유지한다. 생략은 양수 예산도 보존하므로 양수 값을 없애는 수단으로 사용하지 않는다. 누적 횟수는 유지하며 오래된 receipt는 압축되므로 receipt 길이로 남은 실행 수를 계산하지 않는다. 목록에 has_more가 있으면 next_offset으로 이어 읽는다. 완료 기록 정리 요청에는 최신 revision으로 completed/cancelled Goal만 delete하며 미완료 Goal과 프로젝트 파일은 보존한다. complete는 모든 required criterion에 현재 근거가 있고 owned job이 terminal인 경우에만 허용된다. 완료 호출을 임의 성공으로 대체하지 않는다. 완료된 Goal의 기록과 이후 변경된 현재 파일을 구분한다.

프로젝트 console의 Goal 탭은 자연어 요청 작성·복사와 저장된 Goal 이어하기를 제공하고 직접 등록은 고급 입력으로 접어 둔다. 복사한 요청문은 사용자가 해당 프로젝트 ChatGPT에 보내며, 실제 MCP 등록 응답 뒤 Goal이 나타난다. 상태·근거·checkpoint와 수동 pause/resume/cancel도 유지한다. 모델이 갱신한 checkpoint는 수정하지 않은 입력에 반영하고, 편집 중 revision 충돌이 생기면 원래 입력을 보존하며 최신 checkpoint 불러오기를 제공한다. 버튼과 저장된 기록은 ChatGPT 입력창을 채우거나 메시지를 전송하지 않는다. 새 대화에서 Goal을 읽어 계속할 수 있지만 대화 종료 후 새 추론을 시작하는 무인 서비스는 별도 지원 경로가 필요하다. API shape와 limits는 [MCP tools](mcp-tools.md#projectgoal--projectgoal_update)와 [current contract](current-contract.md#goal-runtime-amendment-2026-10-11)를 따른다.

### 공개 도구 스키마와 활성 서버 구분

project.goal의 추가 goal_tool_contract text는 현재 서버의 descriptor·schema digest·예산 의미를 알려준다. 기존 structuredContent는 그대로 유지하며 원격 ChatGPT 정의는 서버가 관측할 수 없다. 호출 스키마에 minimum:1·maximum:128이 남아 있는데 서버가 unlimited를 지원하면 모델 거절이나 프로젝트 코드 오류로 단정하지 않는다. 소스, 빌드 산출물, 실제 daemon, 원격 연결 정의를 구분해 확인한다.

로컬 앱/daemon을 새 빌드로 적용한 뒤 직접 연결한 MCP는 ChatGPT Plugins에서 해당 연결의 Refresh를 수행하고 새 대화에서 도구 정의와 관련 호출을 확인한다. 연결 새로고침은 daemon을 재시작하지 않으며 pnpm dev도 원격 도구 정의 갱신을 보장하지 않는다. 기존 Goal 재개에는 현재 root·파일·revision·소유 작업·기한을 다시 확인한다. 자세한 근거는 [Goal 스키마 호환성](goal-schema-compatibility-20261021.md), 갱신 순서는 [OpenAI 공식 연결 문서](https://developers.openai.com/plugins/deploy/connect-chatgpt)를 따른다.

## 수정과 설치

전체 파일을 읽고 SHA로 보호한 파일 도구 또는 일괄 proposal로 수정한다. 부분 실패는 성공한 변경을 먼저 확인하며 같은 변경을 중복 제출하지 않는다. 사용자의 미커밋 작업은 유지한다.

필요한 의존성이 없으면 실제 manifest와 lockfile을 확인하고 해당 프로젝트의 패키지 관리자를 사용한다. 기존 lockfile 기반 설치가 우선이다. 새 의존성이 필요하면 버전과 사용 목적을 확인하고 manifest 수정, lockfile resolve, 재확인, locked install을 구분한다. 의존성 설치 완료와 빌드 성공은 다른 결과다. Python은 프로젝트 .venv에 설치한다. 전역 설치, sudo, 무관한 업그레이드, 검증되지 않은 원격 설치 스크립트는 실행하지 않는다. private registry 인증이 필요한 경우 비밀값을 출력하지 말고 차단 사유를 보고한다.

### Rust 개발 환경

일반 shell과 전용 Cargo는 같은 프로젝트 cwd와 Rustup pin/override/default를 기준으로 확인한다. 전용 Cargo는 선택된 실제 Cargo/rustc를 같은 도구 모음에서 사용하며, 선택된 버전이 없으면 다른 설치 버전으로 바꾸지 않고 원인을 반환한다. 프로젝트 `.cargo/config(.toml)`의 target/linker/runner/flags 설정은 검증 후 기존 실행 sandbox 안에서 사용한다. 의존성과 `cargo install` 개발 도구는 프로젝트별 Cargo 캐시에 남으며, 다음 shell이 cache/bin을 검색한다. OS 임시 영역 정리 후 캐시가 없어질 수 있으므로 lockfile과 명시적 설치로 복구한다.

작업 생존·진행 확인에는 반환된 job_id와 project.await_exec를 사용하고 서버 준비는 readiness로 확인한다. 선택적인 ps 조회의 EPERM 때문에 다른 수정·검사를 중단하거나 같은 조회를 반복하지 않는다. 필수 검사가 실패한 경우에는 원래 exit/output과 미완료 상태를 유지한다. sandbox 초기화 실패와 선택된 toolchain 누락을 구분하며, 검사 실패를 도구 재설치나 모델 거절로 임의 해석하지 않는다.

### 서버·PTY·경로와 link fixture

전용 Cargo의 offline은 의존성 해석 정책이다. Cargo 및 root check는 loopback 테스트 통신을 허용하며 실제 listener는 `127.0.0.1` 또는 `::1`에 bind한다. shell은 기존 enabled/local 옵션을 사용한다. 서버 등록 성공만으로 준비를 판단하지 말고 실제 응답과 필요한 페이지 동작을 확인한 뒤 owned job을 취소하고 종료를 확인한다.

명령은 scoped PTY와 검증 root의 상위 디렉터리 descriptor 접근을 지원하는 profile을 사용한다. symlink/hardlink fixture는 `TMPDIR` 안에서 만들며 `TMP`·`TEMP`도 같은 private runtime이다. workspace나 외부 source를 runtime으로 hardlink하는 것은 허용 범위가 아니다. 파일 도구와 실행 전 alias 검사는 그대로 적용한다. private-runtime hardlink의 실제 경계는 native positive/negative 검사 통과 전까지 미검증으로 남긴다.

Cargo 전용 경로에서 Node·localhost가 실패하면 `cwd: scripts/cargo-runtime-smoke`, `operation: { kind: "cargo", task: "test" }`의 작은 진단을 먼저 사용한다. 이 fixture는 ChatSplice 저장소에만 있으므로 다른 프로젝트의 경로로 추정하지 않는다. 숫자 IPv4/IPv6 HTTP, Node descriptor walk, localhost 조회와 Host·경로 수신을 구분하며 resolver 파일·socket 실패는 관측으로만 기록한다. 새 소스·빌드·활성 runtime을 구분하고, 변경되지 않은 환경에서 별도 테스트 프로젝트의 전체 Cargo 검사나 Goal 예산을 반복 소비하지 않는다. 새 runtime 적용 뒤 작은 전용 진단을 통과한 다음 해당 프로젝트의 기존 필수 기준과 integration을 다시 검증한다. 자세한 결과는 [Cargo 잔여 실행 호환성 기록](cargo-runtime-residual-20261020.md)을 따른다.

이 저장소의 `python3 scripts/diagnose-development-runtime.py --include-system-ps`는 실제 HTTP·PTY·descriptor·link·자기 프로세스 정보를 JSON으로 구분한다. 필수 실패는 exit 1이고 선택적 ps 실패는 별도 기록이다. 일반 metadata 검사에서 executable이 있다고 나오는 결과를 이 기능들의 실행 성공으로 해석하지 않는다. 다른 프로젝트에서 이 파일이 있다고 가정하지 말고 승인된 경로만 사용한다.

네이티브 최종 profile 회귀는 일반 macOS 터미널에서 `node scripts/check-workspace-folders.mjs unit core src/project/development-capabilities.test.ts`로 실행한다. 관리 명령 안에서 다시 sandbox를 적용하다 초기화가 거부된 결과는 해당 기능 내부 검사 통과가 아니다. 실행 중인 앱/daemon은 소스나 도구 정의 갱신으로 교체되지 않으므로 새 빌드의 정상 재시작과 별도 테스트 프로젝트 동일 검사 재실행을 별도로 확인한다. 자세한 근거는 [개발 실행 환경 기록](development-runtime-20261020.md)을 따른다.

## 구동과 브라우저 검사

개발 서버는 background:true로 시작한다. 종료될 때까지 기다리지 말고 await_exec(timeout_ms:0)으로 실제 준비 로그와 주소를 확인한다. 서버 실행 중 파일 수정과 별도 검사를 계속할 수 있다. 포트가 충돌하면 기존 프로세스를 무작정 종료하지 않는다.

전용 browser 서비스로 관찰된 loopback 주소를 연다. 입력/클릭 후 기대 결과를 assert로 검증한다. 클릭 호출 성공만으로 업무 흐름을 통과 처리하지 않는다. 예를 들면 다음 action을 project.exec의 browser operation에 사용한다.

```json
{
  "kind": "assert",
  "expectation": { "kind": "text", "selector": "#result", "text": "저장 완료" },
  "timeout_ms": 5000
}
```

expectation은 visible, hidden, text, value, url을 지원한다. text는 기본 포함 비교이며 exact:true는 전체 텍스트 비교다. assertion timeout은 100~10000ms이고 전체 job timeout 안에서 제한된다. 실패하면 exit_code:1과 가능한 경우 스크린샷/페이지 증거를 반환한다. 페이지가 닫혔거나 전체 timeout이 발생하면 화면을 얻지 못할 수 있다. 콘솔의 HTTP 오류는 별도 증거이며 로그인 전 예상된 401 등은 시나리오 기준으로 판단한다.

정상 입력, 오류 입력, 주요 상태 전환과 필요한 좁은 화면을 확인한다. 화면 너비 변경은 모바일 기기 전체 검증이 아니다. 테스트용 계정/데이터를 사용하고 실제 결제, 메시지 발송, 운영 데이터 삭제는 별도 권한 없이 수행하지 않는다. 현재 브라우저는 로컬 앱 전용이며 팝업, 다운로드, 서비스 워커를 제한한다. 웹 확인으로 Electron 네이티브 클릭/창 동작을 검증했다고 보고하지 않는다.

## 반복 실행할 브라우저 회귀 검사

이 저장소 자체의 브라우저 테스트는 루트의 `pnpm browser:setup`으로 브라우저 바이너리를 설치한 뒤 `pnpm test:browser`로 실행한다. 설치에는 네트워크가 필요하고 테스트는 loopback만으로 실행 가능하다. 두 명령은 `packages/mcp-server/node_modules/.cache/chatsplice-playwright`를 공통 사용하므로 격리된 실행마다 HOME이 달라져도 설치 위치를 잃지 않는다. 테스트 실행은 누락된 브라우저를 임의로 설치하지 않는다. 다른 프로젝트에 이 명령이 있다고 가정하지 말고 그 프로젝트의 manifest를 먼저 확인한다.

검사는 실제 Chromium 사용자 동작과 별도의 로컬 MCP HTTP client/server를 사용한다. 후자는 테스트 파일 읽기→SHA 검증 편집→재읽기→화면 확인→성공/실패 assertion→MCP 이미지 반환을 검증한다. 실행 중인 사용자 데몬·브라우저 프로필·실제 데이터는 사용하지 않는다. 테스트 통과와 현재 ChatGPT 대화에 새 도구 스키마가 노출되는 것은 별개다.

Goal renderer 회귀는 browser setup 뒤 `pnpm test:goal-ui`로 실행한다. 실행 중인 앱의 renderer를 교체하지 않으려면 `node scripts/check-workspace-folders.mjs renderer` 뒤 해당 renderer 디렉터리를 `CHATSPLICE_RENDERER_DIR`로 지정해 `node apps/desktop/scripts/goal-ui-smoke.mjs`를 실행한다. 자연어 요청·복사 실패·프로젝트 전환·checkpoint 충돌·영어/한국어도 검증한다. 이 명령은 renderer를 빌드한 뒤 owner bridge fixture와 Chromium으로 Goal 생성·기준·checkpoint·pause/resume/cancel 및 좁은 화면을 검증한다. 실제 daemon/MCP Goal lifecycle 검사는 별도의 단위·HTTP integration test가 담당한다. fixture 화면 통과를 사용자 설치 앱·실제 계정 호출이나 native Electron IPC의 live 확인으로 쓰지 않는다.

시작 실패는 browser_missing, browser_permission_denied, browser_launch_timeout, browser_launch_failed로 구분한다. 누락이면 해당 실행기의 캐시에 설치하고, 권한 거부이면 샌드박스를 해제하거나 설치를 반복하지 않는다. 닫히거나 끊어진 preview는 다음 open에서 다시 만들 수 있지만 사라진 로그인 상태를 자동 복원한다고 가정하지 않는다. 정상 상태의 다른 프로젝트 preview는 유지한다.

클릭은 제한 시간 안에서 대상 요소가 나타날 때까지 기다리되, 여러 요소에 동시에 일치하면 실패한다. 명령에 남은 시간 중 일부를 실패 증거 캡처에 남긴다. 이미지가 너무 크거나 캡처에 실패해도 읽어낸 페이지 텍스트는 반환하고 screenshot_available:false 및 실패 코드로 보고한다. 이미지가 없는데 화면 확인을 완료했다고 보고하지 않는다.

## 병렬 검토와 변경 적용

같은 프로젝트를 여러 에이전트가 검토할 때는 읽기·분석·패치 제안을 병행하고, 실제 파일 변경과 실행은 하나의 적용 흐름에서 순차 수행한다. 제안된 변경도 적용 직전에 해당 파일을 다시 읽고 현재 SHA와 정확한 변경 대상을 확인한다. 이 방식은 모델이나 폴더 권한을 바꾸지 않으며 다른 작업의 변경을 보호한다.

수정 도구의 응답이 끊기거나 오래 돌아오지 않으면 성공·실패를 추측하거나 같은 요청을 새 작업으로 제출하지 않는다. 직접 파일 변경은 현재 내용/SHA, 실행은 기존 job_id, 변경 제안은 기존 proposal_id의 결과를 먼저 확인하고 미적용분만 처리한다. 대기 시간 초과에 ‘작업 미시작’ 근거가 있는 경우와, 전송이 끊겨 적용 여부를 모르는 경우를 구분한다. 도구 응답 지연을 전부 모델 추론 시간으로 보고하지 않는다.

## 실패 처리와 완료

오류 로그와 실패 화면을 보고 코드 결함, 누락 의존성, 실행 환경 문제, 권한 거부를 구분한다. 해결 가능한 오류는 범위 안에서 수정 후 같은 합격 기준으로 다시 검사한다. 테스트를 삭제하거나 합격 기준을 낮추지 않는다. sandbox 초기화 실패는 보안 해제 사유가 아니다.

완료 전 변경 파일 재확인, 관련 정적 검사, 기능 테스트, 브라우저 흐름 확인을 수행한다. 새 UI 시나리오는 가능하면 반복 실행할 테스트로 남긴다. 완료/실패/미실행 항목과 소스·빌드·실행 앱 반영 여부를 분리해서 보고한다. 소유한 테스트 서버와 브라우저는 정리한다. commit/push는 명시 요청 때만 한다.

## 적용 범위

도구 정의 새로고침은 실행 중인 앱/daemon의 코드를 다시 읽는 동작이 아니다. 새 소스 빌드로 앱/daemon을 구동한 후 도구 정의를 확인한다. 현재 execution contract는 `development-runtime-3`이며 daemon status에는 executing bundle의 build_id·이번 run_id·실제 tool count/schema digest가 있다. 이들은 코드·실행 근거를 구분하며 도구 권한이나 target-account 호출 성공의 증거는 아니다.

assertion과 optional Goal 연결은 기존 project.exec의 입력 스키마를 확장하고 두 Goal 도구는 catalog에 추가된다. 업데이트한 앱/daemon을 구동한 후 실제 도구 정의에 새 action/field가 없는 경우 앱 관리자에서 정의를 갱신한다. 확인된 프로젝트의 기존 자동 지침 갱신 흐름은 유지한다. 실행 중인 대화를 강제로 새로고침하거나 사용자 로그인 프로필을 복제하지 않는다. 대화 종료 뒤 새로운 추론을 자동으로 시작하는 무인 작업 서비스는 이 변경에 포함되지 않는다.

2026-10-20 Goal 자연어 흐름과 검증 범위는 [Goal chat workflow](goal-chat-workflow-20261020.md)를 따른다.

## 여러 언어가 함께 쓰는 실행 환경 (2026-10-21)

Node script·Cargo·root check가 Python 등 자식 도구를 실행할 때도 공통 설치 runtime/library/shim 읽기와 프로젝트별 dependency cache를 사용한다. 일반 개발·의존성 설치는 shell에서 실제 필요한 명령을 선택하고, 외부 다운로드가 필요하면 network: enabled를 사용한다. 전용 Cargo 검사는 offline을 유지하므로 누락된 의존성은 먼저 명시적인 install 또는 shell로 준비한다. Go/Elixir의 전용 install enum을 가정하지 말고 shell의 go/mix/hex 명령을 사용한다. environment 결과는 manifest와 executable 존재 검사이며 설치·구동 통과가 아니다.

macOS job은 짧은 /private/tmp/cs-e-* 또는 cs-r-* 아래 전용 runtime을 사용한다. loopback 외에 WORKSPACE/RUNTIME 내부 Unix socket을 허용하지만 임의 host daemon socket은 local 모드 범위가 아니다. 프로젝트 .venv Python/pip wrapper는 선택된 Node/Rust를 바꾸지 않으며 명령 실행에 필요한 원래 .venv 경로를 유지한다. structured Git metadata 조회는 가능하되 Git 변경은 목적에 맞는 별도 작업으로 수행한다.

실제 /bin/ps EPERM, xcrun cache 경고 또는 nested sandbox 거부는 원래 결과를 유지한다. optional 조회 실패를 전체 개발 중단으로 확대하지 않지만 필수 검사를 성공 처리하지도 않는다. 새 source/unit/build와 활성 앱/daemon, target 프로젝트의 재검증을 구분한다. 현재 검증과 재시작 순서는 [개발 환경·Goal 기록](development-goals-20261021.md)에 있다.
