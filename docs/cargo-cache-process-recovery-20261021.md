# Cargo 캐시 복구와 macOS 프로세스 조회 — 2026-10-21

갱신: 2026-10-21. ChatSplice 소스 수정 및 분리 빌드 완료. 실행 중인 앱/daemon은 교체하지 않았다.

## 결론과 확인 범위

기존 수정본이 재시작에 반영되지 않았다는 증거는 없었다. 공개 `project.goal`이 반환한 실행 중 서버는 MCP descriptor `0.0.16`, execution contract `development-runtime-3`, 도구 24개이며 schema digest는 이전 검증값과 일치했다. `max_executions: 0`의 무제한 의미도 정상 노출됐다.

이번에 수정한 것은 **재시작 후에도 재사용되는 Cargo 캐시의 명시적 복구 경로**다. 별도로 macOS 기본 API를 통해 자기 프로세스와 실제 자식 프로세스의 신원을 조회할 수 있음을 현재 관리 실행에서 확인했다. `/bin/ps` 자체의 EPERM을 해제하거나 별도 테스트 프로젝트의 기존 ps 호출을 변경한 것은 아니다.

이번 연결의 소스 프로젝트는 ChatSplice이며 승인된 참조 폴더는 없었다. 별도 테스트 프로젝트와 인접 프로젝트 소스, 별도 테스트 프로젝트 캐시, 기존 별도 테스트 프로젝트 Goal은 변경하지 않았다. 사용자 보고의 두 패키지 누락을 현재 별도 테스트 프로젝트 파일에서 재확인한 것으로 기록하지 않는다.

## 원인 구분

### Cargo 캐시

기존 실행 준비는 canonical workspace별 관리 `CARGO_HOME`을 재사용했다. 상위 디렉터리의 소유권·mode·config를 검사하지만, 압축 해제한 패키지 내부의 manifest 누락을 복구하는 경로는 없었다. 앱이나 MCP 연결을 재시작해도 같은 캐시를 다시 선택하므로 파일 누락이 계속 남을 수 있다.

사용자 보고의 `aho-corasick-1.1.5` 및 `walkdir-2.5.0` manifest가 실제로 왜 사라졌는지는 미확정이다. OS 정리, 중단된 다운로드 또는 다른 실행을 원인으로 단정하지 않는다. 공식 Cargo 문서는 registry의 다운로드 원본과 압축 해제한 소스를 구분한다. 이번 실제 Cargo fixture는 완료 marker가 있는 추출 디렉터리에서 manifest를 지운 뒤 새 캐시로 복구되는 경우를 직접 검증했다.

참고: [Cargo Home](https://doc.rust-lang.org/cargo/guide/cargo-home.html).

### /bin/ps

현재 관리 shell에서 `/bin/ps`의 mode는 `0o4755`, setuid는 true였으며, 자신의 PID 하나를 대상으로 해도 프로세스 생성 단계에서 `PermissionError / errno 1 (EPERM)`이 발생했다. 실제 ps 출력 해석이나 PID 비교에 도달한 실패가 아니다.

macOS Seatbelt의 setuid 실행 제약과 일치하는 현상이다. 이 세션에서 커널의 `forbidden-exec-sugid` 로그를 직접 수집한 것은 아니므로 해당 코드가 관측됐다고 주장하지 않는다. 더 넓은 파일 읽기 경로만 허용하면 해결된다고 보지도 않는다.

반면 macOS libproc 호출은 실제 실행에서 자기 PID/UID/PPID/PGID/start time/path와 실행한 자식의 신원을 확인했다. 자식을 정리·reap한 뒤에는 존재하지 않는 PID로 판정했다. 따라서 이 환경에서 프로세스 소유권 검증 자체가 전부 불가능한 것은 아니며, 필수 ps 호출부에는 native API를 사용하는 구현이 필요하다.

참고: [Microsoft MXC Seatbelt backend](https://github.com/microsoft/mxc/blob/main/docs/backends/seatbelt/seatbelt-backend.md), [Apple proc_info.h](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/proc_info.h).

## 구현

### 1. 공개 도구부터 실행까지 연결한 복구 요청

`project.exec`의 Rust locked install에만 다음 operation을 추가했다.

```json
{
  "kind": "install",
  "ecosystem": "rust",
  "mode": "locked",
  "repair_cache": true
}
```

이것은 operation 부분이며 실제 호출에는 현재 프로젝트의 정확한 workspace binding, 새 request_id 및 필요한 Goal 연결을 함께 전달한다. `mode` 생략은 기존 locked 기본값을 따른다. Node 또는 Rust resolve-mode에 `repair_cache: true`를 붙이면 shared public/owner schema와 실행 준비에서 거부한다. false/생략은 기존 설치 경로를 유지한다.

새 private dependency cache에서 고정 명령 `cargo fetch --locked`를 실제 실행한다. exit code 0, timeout 없음, abort 없음, 시작 시점과 일치하는 selector를 확인한 뒤에만 새 세대를 선택한다. SDK 응답만 있고 실제 명령 실행 결과가 없는 경우를 성공으로 처리하지 않는다. fetch 실패·취소·시간 초과 또는 오래된 동시 복구 결과는 기존 선택을 보존한다. 성공 출력에는 전환 여부가 명시된다.

### 2. 다른 도구 및 기존 작업 유지

설치한 실행 파일과 Python/Go/Node/Mix/Hex 등의 cache는 기존 안정적인 tool home을 유지하며, Cargo 의존성 cache만 새 세대로 바뀐다. `CARGO_INSTALL_ROOT`와 도구 검색 PATH를 이에 맞췄고 shell·전용 Cargo·root check·Rustup metadata의 sandbox parameter도 함께 연결했다.

기존 실행은 시작할 때 받은 이전 cache 경로를 계속 사용한다. 이전 cache나 실패한 후보를 자동 삭제하지 않으며, 작업 중인 cache를 비우지 않는다. OS가 선택된 디렉터리 전체를 없앤 경우에는 기존 selector를 바꾸지 않고 정확한 검증 디렉터리만 다시 만든다. 이 공통 준비에 Rust manifest를 요구하지 않으므로 Python/Node 실행이 Cargo cache 디렉터리 소실만으로 막히지 않는다.

선택 metadata는 실행에 허용된 dependency/tool home 밖의 private single-link 파일이다. 크기와 필드, workspace별 이름을 검사한다. publication은 단일 owner daemon 안에서 serialize하며 오래된 selector fingerprint를 거부한다. 별도 daemon 프로세스들 사이의 cross-process CAS를 보장한다고 주장하지 않는다.

읽기 전용 inspection 함수는 시간·entry·issue 수를 제한하고 symlink를 따라가지 않으며, 완료 marker와 manifest 누락을 보고할 수 있다. 이 검사를 새 공개 도구로 추가하거나 모든 실행에서 자동 fetch하게 만들지는 않았다.

### 3. 환경 변경 이후의 Goal 근거

실제 cache 전환이 끝나면 같은 canonical root의 통과한 runtime criterion을 stale로 만든다. Goal 상태·checkpoint·receipt·누적 실행·파일 근거는 유지한다. 복구 실행에 Goal이 직접 연결되지 않은 경우도 해당 root에 반영하며, 전환 후 취소된 경우도 실제 전환 사실을 잃지 않는다.

전환 전에 시작한 assertion이 나중에 끝나 새 환경을 통과한 것으로 기록하지 않도록 기존 before-digest를 무효화했다. `max_executions: 0` 및 기존 무제한 재개 계약은 유지한다.

### 4. 프로세스 진단

`scripts/diagnose-development-runtime.py`에 macOS libproc 기반 요청 PID 신원 조회, 실제 자식 실행, 소유·시작 시각·경로 일치, 정리·reap 및 종료 후 소멸 확인을 보강했다. ps 선택 진단은 mode/setuid/setgid와 실패 단계(spawn/exit/parse/identity), errno를 구분한다.

필수 native 검사는 실제 결과로 판단하며, 선택적 ps 실패 때문에 native 검사의 성공을 취소하거나 필수 ps 기반 호출부를 통과 처리하지 않는다. 별도 테스트 프로젝트의 Rust 호출부와 그 회귀 검사는 별도 적용·검증 대상이다.

## 검증 결과

직접 관련 자동 검사는 **135개 통과**다. 아래 숫자는 같은 검사의 재실행을 중복 합산하지 않았다.

| 범위                                                                   | 결과    | 실행 근거             |
| ---------------------------------------------------------------------- | ------- | --------------------- |
| Protocol: repair contract 및 Goal budget                               | 17 통과 | `(로컬 실행 ID 생략)` |
| Core: cache foundation, orchestration, tool retention, Rustup, sandbox | 72 통과 | `(로컬 실행 ID 생략)` |
| MCP: 실제 tools/list, Goal invalidation, execution lifecycle           | 31 통과 | `(로컬 실행 ID 생략)` |
| Python diagnostic                                                      | 14 통과 | `(로컬 실행 ID 생략)` |
| 실제 Cargo cache 복구                                                  | 1 통과  | `(로컬 실행 ID 생략)` |

마지막 디렉터리 전체 소실 보정 뒤 cache foundation 25개를 재실행해 통과했다: `(로컬 실행 ID 생략)`.

실제 Cargo 검사는 opt-in fixture(`CHATSPLICE_CARGO_CACHE_NATIVE=1`)에서 walkdir 2.5.0을 정식 fetch하고, 테스트가 소유한 cache의 해당 manifest만 제거했다. 실제 marker를 유지한 채 결손 탐지→새 locked fetch→전환→lockfile 불변→새 cache의 offline Rust test 성공을 확인했다. 이전 결손 cache는 fixture 정리 전까지 그대로 남았다. 일반 단위 검사에서는 이 network 검사를 자동 실행하지 않는다.

현재 관리 실행에서 수정한 native 진단을 실행했다: `(로컬 실행 ID 생략)`. 자기 프로세스와 실제 자식 identity 및 reap 후 소멸이 통과했고 required_failed는 0이었다. 선택적 ps는 여전히 spawn EPERM이었다. 이 종료 코드 0을 별도 테스트 프로젝트의 ps 필수 검사 통과로 바꾸어 기록하지 않는다.

전체 protocol/core/MCP/desktop TypeScript 및 Svelte 검사: 0 errors, 0 warnings (`(로컬 실행 ID 생략)`). 변경 TypeScript의 ESLint 및 Prettier 통과. 최종 두 cache 파일의 format/lint도 재확인했다. 최종 staged build가 모든 package와 desktop main/preload/renderer를 다시 컴파일했다.

### 아직 남은 확장 검사

전체 repository suite가 모두 통과했다고 보고하지 않는다.

- `schemas.test.ts` 5건과 `execution-environment.test.ts` 1건: 이번 수정 전부터 소스와 다른 기존 안내 문구/소스 문자열 기대값이다. 이 테스트나 해당 안내문 생성기를 이번 작업에서 바꾸지 않았다.
- `cargo-cache-lifecycle.test.ts` 7건: 현재 관리 실행 안에서 호스트 `/private/tmp/cs-e-*` runtime을 다시 만들려다 EPERM으로 assertion 전에 중단됐다. 이를 기능 통과 또는 별도 테스트 프로젝트 결과로 계산하지 않았다.
- 새 orchestration 단위 검사는 mocked execution boundary를 테스트 소유 TMPDIR에 맞췄다. 실제 native runtime 배치·권한 검사는 위 단위 harness가 대신하지 않는다.
- 별도 테스트 프로젝트 전체 Cargo/Clippy/build/API/browser 검사는 이번에 실행하지 않았다.

## 최종 빌드와 적용

빌드 실행: `(로컬 실행 ID 생략)`, exit 0.

| 항목                       | 최종 후보                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| MCP descriptor             | `0.0.17`                                                           |
| Execution contract         | `development-runtime-4`                                            |
| Control protocol / 도구 수 | 4 / 24                                                             |
| built_at (UTC)             | `2026-10-21T13:48:39.918Z`                                         |
| Source SHA-256             | `650b72ac57fbd12b043d79c62da70b150bd22ba4bc107ccd01466d55bfc473cc` |
| Desktop build ID           | `b8dd9564e8455501bb75bf3822abaee953db302ebd4ffa415fc356e03e06742c` |
| Daemon build ID            | `cfed4c52b0432739bb222d07d85a2b17f98ac6803b03d97df36f5fd63d74432e` |
| Tool schema digest         | `d4b826b1fb64427830f3204f2b319f413e1b8524e9162f3399df93d016e06a6e` |

최종 후보 경로:

```text
node_modules/.cache/chatsplice-runtime-…
```

이 빌드는 현재 앱을 교체하거나 daemon을 재시작하지 않는다. 실행 중인 작업을 정리하고 기존 앱/daemon을 정상 종료한 뒤 다음 명령으로 검증한 후보를 시작한다.

별도로 만든 실행본을 사용하려면 `pnpm build:staged`가 출력한 폴더에서 `pnpm start`를 실행합니다.

현재 checkout에서 계속 개발할 경우 정상 종료 후 최신 소스로 `pnpm dev`를 시작하는 방법도 가능하다. 이때 위 staged build와 다른 새 build identity가 만들어질 수 있다. 어느 방법이든 **빌드/재시작만으로 손상 cache가 복구되지는 않는다**.

이후 적용 확인 순서는 다음과 같다.

1. 공개 `project.goal`의 실행 중 contract가 `development-runtime-4`, descriptor가 `0.0.17`인지 확인한다. staged 후보를 사용했다면 위 schema digest도 일치해야 한다.
2. ChatGPT 연결 도구 정의를 새로 고치고 advertised `project.exec` schema에 `repair_cache`가 보이는지 확인한다. 원격 client schema의 갱신을 로컬 server 응답만으로 확정하지 않는다.
3. 별도 테스트 프로젝트의 정확한 binding에서 기존 Goal의 최신 revision/root/files/소유 실행을 읽고 같은 Goal을 명시적으로 재개한다.
4. 위 Rust locked repair operation을 한 번 제출하고 `project.await_exec`로 실제 종료와 cache publication을 확인한다. 실패 시 원래 오류를 조사하며 같은 전체 Cargo 검사를 무조건 반복하지 않는다.
5. 새 cache에서 정확한 Cargo test/Clippy/build를 갱신한다. 기존 `/bin/ps` 필수 호출은 별도 테스트 프로젝트에서 native process API로 구현하고 해당 소유권 회귀를 별도로 검증한다.
6. API/worker/browser와 남은 기능 검증을 이어간다. cache 전환은 기능 완료나 기존 stale criterion의 통과를 의미하지 않는다.

현재 공개 도구에는 활성 앱/daemon의 정상 종료·재시작 기능이 없다. private owner endpoint, 강제 kill, sandbox 해제, ps binary 변형으로 대체하지 않았다. 최종 확인 시 활성 서버는 여전히 `0.0.16 / development-runtime-3`이며, 이번 `0.0.17` 후보의 실제 적용은 위 정상 시작 후 확인해야 한다.

## 주요 변경 파일

- `packages/core/src/project/cargo-cache.ts`, `pi-execution.ts`, `pi-trusted.ts`: cache 선택·복구·실제 실행 결과 연결.
- `packages/core/src/project/development-tools.ts`, `pi-sandbox.ts`, `shell-sandbox.ts`, `run-task.ts`, `rust-toolchain.ts`: 안정적인 tool home과 명령 경로 통합.
- `packages/protocol/src/execution.ts`, `schemas.ts`, `packages/mcp-server/src/mcp/tools-project.ts`: shared schema, 실행 contract 및 도구 설명.
- `packages/mcp-server/src/execution/service.ts`, `backend.ts`, `goal/service.ts`: cache 전환 후 실제 root의 Goal 근거 무효화.
- `scripts/diagnose-development-runtime.py` 및 관련 TypeScript/Python 검사: native 프로세스와 실제 Cargo 회귀.

기존 미커밋 변경을 보존했으며 commit/push는 수행하지 않았다.
