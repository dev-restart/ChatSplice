# Milestone 0–2C MCP tools

서버 identity는 `chatspliced`이며 현재 tool은 24개다. MCP descriptor는 0.0.21, control protocol은 5, execution contract는 `development-runtime-4`이다.

```text
workspace.list
fs.reference_list
fs.reference_paths
fs.reference_search
fs.reference_read
fs.reference_request
fs.reference_request_await
fs.list
fs.search
fs.read
fs.edit
fs.write
fs.mkdir
fs.rename
fs.delete
project.run
project.git
project.exec
project.await_exec
project.cancel_exec
project.goal
project.goal_update
local.prepare_apply
local.await_apply
```

ChatGPT Chat이 reasoning/iteration loop를 맡고 ChatSplice MCP가 bounded local 도구를 제공합니다. 읽기 도구는 `workspace.list`, `fs.reference_*`(`fs.reference_request` 제외), `fs.list/search/read`, `local.await_apply`, `project.await_exec`, `project.goal`입니다. `local.prepare_apply`는 자동 변경을 유발하는 **write 도구**이며 destructive/open-world로 선언합니다. `project.goal_update`도 상태를 저장하고 owned job을 취소할 수 있어 write/destructive로 선언하지만 자체 외부 network는 사용하지 않습니다. `project.git`과 `project.exec`도 network 가능성을 선언합니다. `fs.reference_request`는 파일을 바꾸지 않지만 새 권한을 요청하는 도구라 동일하게 write 도구로 선언하고 읽기 전용 모드에서 차단됩니다. 별도 코딩 모델은 호출하지 않습니다. 요금제별 공식 안내가 일치하지 않으므로 계정의 실제 도구 노출·호출로 확인합니다. 현재 채팅이 read-only라면 자동 적용을 사용할 수 없습니다.

## `project.exec` / `project.await_exec` / `project.cancel_exec`

`project.exec`는 정확한 workspace binding, 새 `request_id`, 상대 `cwd`, `operation`, 제한된 `timeout_ms`로 작업을 제출하고 `job_id`를 반환합니다. 기존 Node script/Cargo/locked install 외에 `shell` 개발 명령과 `browser` 웹 검증을 지원합니다. shell은 Node.js·Python·Rust·Go·Elixir/Mix·sh 개발 명령과 의존성 설치를 실행합니다. HTML/CSS는 프로젝트 서버와 browser로 검증합니다. `network: local`은 loopback과 프로젝트/작업 전용 Unix socket만 허용합니다. shell/node_script의 `background: true`는 서버를 유지하면서 파일 수정·검사를 병행합니다. browser의 setup/open/snapshot/click/fill/press/scroll/close는 isolated local page를 검증하며 `project.await_exec` 결과에 screenshot image와 `browser_result`를 반환합니다. foreground 작업은 종료까지 await하고 서버는 `timeout_ms: 0`으로 상태를 확인한 뒤 실제 readiness를 검증합니다. 기존 install의 resolve는 lockfile만 갱신하므로 다시 읽은 뒤 별도 locked 설치가 필요합니다. `project.cancel_exec`와 사이드바 취소는 cleanup을 요청하며 완료된 변경을 되돌리지 않습니다. Pi SDK는 command execution, Playwright는 browser tooling이고 별도 model/provider/OAuth는 없습니다. 앱 전체 한도는 foreground 8개, background 12개, browser session 12개, queued/running 합계 64개입니다. request_id는 workspace별로 분리됩니다. 상세 범위는 [실행 계약](model-free-execution.md)을 따릅니다.

### 실행 환경 점검

`operation: { "kind": "environment" }`와 상대 `cwd`를 제출한 뒤 `project.await_exec`의 `environment_result`를 읽는다. Go·Elixir를 포함한 고정 manifest/lockfile 19개·runtime/도구 17개·Node manager/script 이름·상위 lockfile·runtime/manager의 PATH 존재·관리형 browser cache와 누락 항목을 반환한다. Node manifest 64 KiB·script 32개·PATH directory 64개·cwd 31단계로 제한한다. 설치나 project script/version command는 실행하지 않는다. browser cache가 있어도 `launch_verified:false`이며 executable 존재를 사용 가능·버전 적합으로 단정하지 않는다. report 성공과 검사 대상의 문제 유무는 별개다. 설치·구동·browser assert는 실제 별도 job으로 확인한다.

### 구조화된 readiness

`project.exec`의 `operation`에 `{ "kind": "readiness", "url": "http://127.0.0.1:5173/health", "expected_status": 200, "attempts": 5, "interval_ms": 500, "request_timeout_ms": 1000 }`을 전달한다. 기존 workspace binding·request_id와 전체 timeout을 사용하고 `project.await_exec`까지 기다린다. literal loopback HTTP(S)에 HEAD를 보내며 redirect·body·cookie를 수집하지 않는다. 결과의 `readiness_result`는 ready·status_code·attempts_used·duration_ms와 시도별 실패를 반환한다. 취소는 request/retry delay 정리가 끝난 뒤 cancelled가 된다. URL query는 command/output/result에서 제외한다. endpoint 준비가 process 소유권이나 페이지 기능 통과를 뜻하지 않으므로 이후 browser assert로 여정을 확인한다. 일반 shell/install/Git은 자동 재시도하지 않는다.

## `project.goal` / `project.goal_update`

`project.goal_update`의 공개 inputSchema는 `action` enum과 모든 action 필드를 선택 속성으로 가진 단일 object다. 기본값은 광고하지 않으며, 서버가 action별 기존 schema로 다시 검증해 필수·금지 필드를 확인하고 `create` 기본값(scope `''`, next_step `''`, max_executions `0`, deadline_ms `3600000`)을 적용한다. `resume`에서 생략한 `max_executions`는 저장된 예산을 유지한다. 모든 도구의 결과 schema는 `tools/list`에 광고하지 않고 서버 내부에서 검증한다.

`project.goal`은 기존 `structuredContent`를 유지하고 별도 `goal_tool_contract` text에 현재 실행 서버의 descriptor·도구 수·schema digest와 예산 의미를 추가합니다. identity 조회 실패는 Goal 조회를 실패시키지 않으며 private 오류를 반환하지 않습니다. `client_tool_schema_status: not_observable`은 원격 ChatGPT 도구 정의를 서버가 관측하지 못한다는 뜻입니다. 현재 서버의 `0` 지원과 연결에 남은 `minimum:1`을 구분하고, 로컬 적용과 ChatGPT Plugins의 연결 Refresh·새 대화 검증을 별도로 수행합니다.

`project.goal`은 binding 검증 뒤 현재 프로젝트의 Goal 목록을 반환한다. `goal_id`를 함께 보내면 해당 Goal 하나만 읽는다. 결과는 `{ "goals": [...], "total": 40, "has_more": true, "next_offset": 32 }`와 같은 페이지이며 optional offset·limit(1–32)으로 이어 읽는다. 페이지는 약 2 MiB 이내라 32개보다 적게 반환될 수도 있다. 각 Goal은 현재 root 일치 여부, criterion 상태·근거, checkpoint, 최소 execution receipts와 예산을 포함한다. 조회는 실행을 시작하거나 Goal을 재개하지 않는다.

사용자가 Goal 작업을 요청한 경우 `project.goal_update`의 `create`로 목표와 합격 기준을 선언한다. 다음 예시는 실제 manifest에 `check`가 있을 때 사용한다.

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "action": "create",
  "objective": "저장 버튼을 수정하고 검사를 통과한다",
  "scope": "src/button.ts와 관련 검사",
  "tracked_paths": ["src/button.ts", "package.json", "pnpm-lock.yaml"],
  "criteria": [
    {
      "criterion_id": "source",
      "kind": "file",
      "path": "src/button.ts",
      "description": "수정 파일 재읽기"
    },
    {
      "criterion_id": "check",
      "kind": "check",
      "cwd": ".",
      "operation": { "kind": "node_script", "script": "check" },
      "description": "기존 check 통과"
    }
  ],
  "next_step": "파일을 읽고 수정한다"
}
```

objective/scope/criteria는 생성 뒤 바꾸지 않는다. 기준을 바꿔야 하면 새 Goal로 명시한다. tracked path 1–32개와 criterion 1–16개를 받으며 criterion ID는 중복될 수 없고 required 기준이 최소 하나 필요하다. file criterion의 path는 tracked set에 자동 포함되며 합친 경로도 32개 이내여야 한다. 기본 max_executions는 0(횟수 제한 없음), 기한은 한 시간이며 기한 상한은 24시간이다. 양수 실행 예산은 명시적으로 선택할 수 있다. lifetime 128회와 프로젝트 32개·전체 256개 등록 차단은 없다. 저장 metadata는 1 MiB 이내이고 최근 32개 및 실행 중·현재 기준 근거 receipt를 보존하며 오래된 본문을 압축한다. 별도 요청 해시 ledger가 재시작 후에도 중복 실행을 막고 누적 executions_used는 초기화하지 않는다.

생성 외 mutation은 응답의 `goal_id`와 현재 `revision`을 `expected_revision`으로 전달한다. 응답은 `{ "goal": ... }`이다. 충돌하면 현재 Goal을 다시 읽고 의도한 단계만 수행한다. `checkpoint`는 `summary`·`next_step`과 현재 파일 SHA를 저장하고, `verify_file`은 `criterion_id`로 현재 파일을 안전하게 읽어 실제 SHA 근거를 기록한다. `pause`, `resume`, `cancel`, `complete`, `delete`도 동일한 revision guard를 사용한다. delete는 completed/cancelled이며 owned 실행이 모두 끝난 Goal의 기록과 요청 해시만 삭제하고 `{ "goal": ..., "deleted": true }`를 반환한다. 프로젝트 파일이나 미완료 Goal은 삭제하지 않는다. `resume`은 optional `deadline_ms`·`max_executions`로 예산을 명시적으로 갱신할 수 있으며 기존 양수 예산을 없앨 때는 max_executions: 0을 보낸다. 저장된 max_executions가 이미 0이고 변경이 필요 없으면 resume에서 이 선택 필드를 생략해 무제한 상태를 유지한다. 생략은 저장된 양수 값도 보존하며 새 0을 설정하는 동작은 아니다.

검사 제출 시 `project.exec`에 `goal_id`와 `criterion_id`를 추가한다. check는 선언된 node_script/Cargo operation과 cwd가 정확히 일치해야 하고 browser는 선언된 expectation을 사용하는 `assert`여야 한다. file criterion은 `verify_file`로 검증한다. `goal_id`만 연결한 서버·shell·설치 job은 receipt와 예산에 포함되지만 criterion을 통과시키지 않는다. 실행 결과를 await한 뒤 Goal을 다시 읽고 변경된 revision을 사용한다. 직접 `project.run` 결과나 caller의 passed flag로 Goal을 통과시키지 않는다.

tracked file 변경은 이전 근거를 stale로 만들고 runtime build/run 변경은 check/browser 근거를 다시 요구한다. `complete`는 현재 required 근거가 모두 통과하고 owned job cleanup이 끝난 경우에만 성공한다. pause는 신규/queued 시작을 막고 이미 실행 중인 job의 종료를 허용한다. cancel은 해당 Goal의 job만 정리하며 completed writes를 되돌리지 않는다. daemon read-only mode에서도 조회·pause·cancel은 허용되지만 이것이 현재 ChatGPT 계정의 write-action 노출을 보장하지는 않는다.

Goal·checkpoint·최소 receipt는 app-private SQLite에 남는다. job output·browser session·이미지·proposal은 memory-only다. 재시작 당시 불확실한 실행은 interrupted로 남으며 자동 replay하지 않는다. root identity가 바뀌면 이전 Goal을 재개할 수 없다. Goal 저장·resume은 새 ChatGPT turn이나 자동 메시지 전송을 수행하지 않는다. 상세 경계는 [current contract](current-contract.md)를 따른다.

## `fs.reference_request` / `fs.reference_request_await`

대화에서 외부 폴더를 연결하기 위한 승인 요청이다. `fs.reference_request`는 `workspace_id`, `workspace_binding`, 절대 경로 `path`, 선택적 `label`과 `access_mode`를 받아 `request_id`와 `pending_approval`을 반환한다. 신규 요청에서 모드를 생략하면 `read_write` 작업 권한을 제안하고, 조회만 필요하면 `read_only`를 명시한다. 이 호출 자체는 경로를 열거나 권한을 부여하지 않는다.

ChatSplice의 네이티브 창은 프로젝트와 정확한 폴더를 표시하고 **이 폴더에서 작업 허용** 또는 **거부**를 받는다. **읽기 전용으로 연결**을 선택하면 조회만 허용한다. 명시적 읽기 요청과 구형 모드 누락 요청은 이 선택을 기본 체크한다. 소유자가 최종 선택한 모드가 저장되고 승인 결과의 `access_mode`에 반환된다. 기존 저장된 연결에서 모드가 없으면 계속 읽기 전용이다.

`fs.reference_request_await`는 같은 `request_id`의 결과만 기다린다. 승인 뒤 `fs.reference_list`에서 실제 권한과 `workspace_id`를 확인하고 이를 `reference_workspace_id`로 재사용한다. 원래 대화의 source binding을 유지하며 일반 `fs.*`와 `project.exec`를 폴더 기준 상대경로로 호출한다. 읽기 전용에서는 파일 쓰기와 명령 실행을 허용하지 않는다. 추가 폴더는 별도 사이드바 프로젝트나 ChatGPT Project가 되지 않는다.

응답 유실 시 같은 요청 ID의 같은 소유자 결정만 재전송한다. 동시 재전송은 하나의 권한 적용을 공유하고, 다른 승인 여부·모드는 거부한다. 권한 적용 중 만료·프로젝트 제거로 결과가 사라지지 않게 보호하며 source root가 요청 당시와 달라졌으면 새 요청이 필요하다. 읽기·편집·검사마다 같은 폴더 연결을 다시 요청하지 않는다.

ChatGPT 자체의 도구 승인창은 이 네이티브 승인과 별개다. 앱별 승인 정책은 ChatGPT의 공식 설정에서 관리하며 MCP 코드로 강제 승인하지 않는다. `project.exec`의 실제 변경·실행·network 기능에 맞는 annotation을 유지한다. 공식 [앱 권한 설명](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security#apps-plugins-and-connected-accounts)과 [도구 annotation](https://developers.openai.com/plugins/reference#annotations)을 참고한다.

실행·동시성·재시도·부분 실패의 최신 계약은 [current-contract.md](current-contract.md)에 정리되어 있습니다.

## `workspace.list`

입력은 빈 strict object다.

```json
{}
```

출력은 등록된 workspace의 immutable ID, display name, kind만 포함한다. absolute root와 `workspace_binding`은 반환하지 않는다. 이는 discovery 전용이며 mutation target 선택 권한이 아니다.

## `fs.list`

정확한 path를 모를 때 bounded directory/glob discovery를 수행한다.

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src",
  "glob": "**/*.ts",
  "recursive": true,
  "max_depth": 6,
  "limit": 100,
  "offset": 0
}
```

glob은 `*`, `**`, `?`만 지원한다. traversal, absolute pattern, secret/control path는 거부하고 symlink를 따라가지 않는다. `node_modules`, `dist`, `build`, cache 등 generated directory를 재귀 탐색하지 않는다. `has_more`는 ordinary pagination이고 `truncated: true`는 hard cap이므로 같은 broad call을 반복하지 말고 범위를 좁힌다.

## `fs.search`

기존 UTF-8 text file에서 literal single-line text를 bounded하게 찾는다.

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src",
  "glob": "**/*.ts",
  "query": "createChatSpliceMcpServer",
  "case_sensitive": true,
  "max_depth": 6,
  "limit": 30,
  "offset": 0
}
```

정규식, subprocess, shell은 실행하지 않는다. directory depth, file count, per-file size, aggregate bytes, result count를 제한한다. `truncated: true`이면 path/glob/query를 좁힌다.

선택적 `context_lines`는 기본 0, 최대 3으로 각 검색 결과 앞뒤의 문맥 줄 수를 지정한다. 0이면 기존 결과 형태를 그대로 반환한다. 1–3이면 각 match에 `context_before`와 `context_after` 배열을 추가하고 원래 `line_number`, `line`, `truncated`를 제공한다. 문맥 한 줄은 최대 200 UTF-16 단위와 말줄임표이며 코드 포인트 중간을 자르지 않는다. 페이지 전체의 문맥 텍스트는 말줄임표를 포함해 UTF-8 16 KiB 이내다. 한 줄이 축약되거나 예산 때문에 문맥을 생략하면 `context_truncated: true`로 구분한다. 이는 검색 자원 한도의 `truncated`, 다음 매칭 페이지의 `has_more`와 별개다.

문맥 예산은 반환하는 페이지에만 사용하며 offset으로 건너뛴 결과와 다음 페이지 존재 확인용 결과에는 사용하지 않는다. CRLF와 빈 줄 번호를 보존하고 파일 끝 개행을 가짜 문맥 줄로 반환하지 않는다. NUL 포함 파일과 잘못된 UTF-8은 `skipped_files`로 제외한다. `fs.reference_search`도 같은 선택 필드를 지원한다. 문맥은 탐색용 미리보기이므로 수정 전에는 현재 파일의 정확한 내용과 full-file SHA를 별도로 읽는다.

## `fs.read`

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/example.ts",
  "start_line": 1,
  "end_line": 100,
  "max_bytes": 51200
}
```

기존 regular UTF-8 file만 읽는다. 응답에는 검증된 workspace ID/name, content, line/byte metadata, full-file SHA-256, `truncated`가 포함된다. 파일 앞부분을 생략한 suffix-only 읽기도 `truncated: true`이며, SHA가 전체 파일 기준이라는 사실만으로 전체 내용을 반환했다고 판단하지 않는다. 실제 파일보다 큰 end_line은 끝 줄로 제한하며 빈 논리 줄의 위치도 유지한다. replace/edit/rename/delete에 사용할 SHA는 반드시 같은 path의 직전 **full non-truncated read**에서 얻는다.

## `fs.edit`

기존 text file의 bounded exact replacement 기본 경로다.

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/example.ts",
  "expected_sha256": "<직전 full fs.read SHA-256>",
  "edits": [
    {
      "old_text": "const timeout = 1000;",
      "new_text": "const timeout = 1500;"
    }
  ]
}
```

각 `old_text`는 기본적으로 정확히 한 곳과 일치해야 한다. 여러 곳을 의도한 경우에만 `replace_all: true`를 사용한다. stale SHA, unmatched/ambiguous block, traversal, symlink escape, secret/control path, probe workspace를 write 전에 거부한다. 같은 directory의 private temporary file과 atomic replacement를 사용한다. 성공 후 같은 path를 한 번 다시 읽는다.

## `fs.write`

새 text file을 만들거나 기존 text file 전체를 교체한다.

공개 inputSchema는 단일 object이며 `mode`가 `create`/`replace`이고 `expected_sha256`은 선택 필드로 보인다. 서버는 `replace`에서 `expected_sha256`을 요구하고 `create`에서는 거부한다(`BAD_REQUEST`).

생성:

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/new-file.ts",
  "mode": "create",
  "content": "export const value = 1;\n"
}
```

전체 교체:

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/existing.ts",
  "mode": "replace",
  "expected_sha256": "<직전 full fs.read SHA-256>",
  "content": "export const value = 2;\n"
}
```

`create`는 parent가 이미 존재하고 destination이 없어야 한다. `replace`는 직전 full read SHA를 요구한다. 두 mode 모두 UTF-8/10 MiB bound, canonical workspace confinement, secret-path denial을 적용하고 atomic하게 반영한다. 기존 destination을 암묵적으로 덮어쓰지 않는다. 성공 후 결과 path를 다시 읽는다.

## `fs.mkdir`

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/components"
}
```

기존 canonical parent 아래에 directory 한 단계를 생성한다. destination은 없어야 하고 symlinked parent와 secret/control path는 거부한다. 여러 단계를 만들려면 상위에서 하위 순서로 한 번씩 호출한다.

## `fs.rename`

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "source_path": "src/old.ts",
  "destination_path": "src/new.ts",
  "expected_sha256": "<source의 직전 full fs.read SHA-256>"
}
```

기존 regular UTF-8 file 하나를 workspace 안에서 이동하거나 이름 변경한다. destination parent는 이미 존재하고 destination은 없어야 한다. stale SHA, directory, overwrite, symlink escape, secret/control path는 거부한다. 성공 후 destination을 읽고 source가 사라졌는지 확인한다.

## `fs.delete`

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "path": "src/unused.ts",
  "expected_sha256": "<직전 full fs.read SHA-256>"
}
```

기존 regular UTF-8 file 하나를 **영구 삭제**한다. 사용자가 명시적으로 삭제를 요청한 경우에만 호출한다. directory 삭제, stale SHA, symlink escape, secret/control path는 거부한다. 성공 후 `fs.list` 또는 targeted search로 path가 사라졌는지 확인한다.

## `project.run`

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "task": "typecheck",
  "timeout_ms": 60000
}
```

workspace root `package.json`에 실제로 선언된 `test`, `lint`, `typecheck`, `check`, `build` 중 하나만 실행한다. command string, 추가 arguments, alternate cwd, arbitrary executable, Git, network를 받지 않는다. macOS에서는 `/usr/bin/sandbox-exec`로 network를 거부하고 write를 workspace/private runtime으로 제한한다. file data read와 executable mapping은 기본 거부하고 workspace/runtime, 검증된 package-manager/Node runtime, offline Corepack cache, 최소 system runtime만 allowlist한다. workspace 안의 nested `.env*`, credential/private-key, control directory는 shared path policy에 맞춰 다시 거부한다. environment secret을 제거하며 기본 60초·최대 120초 timeout과 bounded stdout/stderr를 적용한다. non-zero exit와 timeout도 structured evidence로 반환하므로 direct file tool로 수정한 뒤 필요한 check만 다시 실행한다.

## `project.git`

workspace root에 실제 `.git` repository가 있는 user workspace에서 bounded git command 하나를 실행한다.

```json
{
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "git": { "command": "commit", "message": "Apply review fixes", "all": true },
  "timeout_ms": 60000
}
```

허용 command는 `status`, `branch`, `log`, `diff`, `add`, `commit`, `push`, `pull`, `fetch`의 9개다. command string이나 임의 argument는 받지 않고 각 command는 고정된 structured shape(status/branch는 인자 없음, log는 `max_count` 1–100, diff는 `staged`+paths, add는 `all` 또는 paths, commit은 `message`+`all`, push/pull/fetch는 remote/branch ref)로만 조립되며 path 앞에는 항상 `--`가 놓여 값이 flag로 작동할 수 없다. shell은 사용하지 않는다. git executable은 PATH에서 root 또는 현재 사용자가 소유하고 group/other-writable이 아닌 binary만 허용하며 workspace 안에 심어진 git은 거부한다. 호출별 private `HOME`/config/runtime과 trusted PATH를 사용하고 system/global Git config와 interactive prompt를 차단한다. hook, fsmonitor, signing, external diff/textconv, clean/smudge/process filter, merge driver, custom protocol helper를 실행하지 않으며 `ext`/`file`/`git` transport도 거부한다. `push`, `pull`, `fetch`만 의도적으로 network를 사용하고 SSH agent 또는 검증된 macOS Keychain helper를 선택적으로 이용하며 결과의 `used_network`로 표시된다. 나머지 command는 offline이다. stdout/stderr는 각각 bounded되고 timeout은 기본 60초·최대 120초다. 일반 흐름은 `fs.*` mutation → `add` → `commit` → 필요 시 `push`다.

## `local.prepare_apply`

Mutation action을 실제 호출할 수 있는 채팅에서 ChatSplice에 bounded mutation bundle을 제출한다. Read-only 제한을 우회하는 도구가 아니다.
새 UTF-8 text 수정·생성·directory 생성·이름 변경·삭제·allowlisted check/build·bounded git command(add/commit/push 등 9종) 요청에서 묶음 자동 적용을 요청할 때 선택하는 시작 action이다. 새 작업에는 continuation-only인 `local.await_apply`를 선택하지 않는다.

```json
{
  "format": "chatsplice.apply.v1",
  "idempotency_key": "change_20260905_001",
  "workspace_id": "ws_0123456789abcdef01234567",
  "workspace_binding": "wb_<64 lowercase hex>",
  "operations": [
    {
      "tool": "fs.edit",
      "path": "src/example.ts",
      "expected_sha256": "<직전 full fs.read SHA-256>",
      "edits": [
        {
          "old_text": "const timeout = 1000;",
          "new_text": "const timeout = 1500;"
        }
      ]
    }
  ],
  "checks": [{ "task": "typecheck", "timeout_ms": 60000 }],
  "git": [{ "command": "commit", "message": "Apply review fixes", "all": true }]
}
```

bundle은 최대 operation 20개, check 3개, git command 5개를 받으며 세 항목 중 하나라도 있으면 된다. git command shape는 `project.git`의 9종 allowlist와 동일하다.

도구는 binding과 bundle을 검증하고 Electron이 owner-only token으로 claim/execute하도록 요청한다. Execute는 HTTP 202를 반환하고 daemon이 실행 및 최종 결과를 소유한다. 이로 인해 지연된 파일 변경과 명령 실행이 발생하므로 read-only로 선언하지 않는다. `idempotency_key`는 동일 전송 재시도에서만 재사용하고 의도적으로 다시 실행할 때는 새 값을 쓴다. 30초 동안 실행을 시작하지 않은 claim은 회수하며, 이미 실행 중인 작업은 연결 실패만으로 재실행하지 않는다.

응답의 `applied_steps[].execution`에 `stdout`, `stderr`, `exit_code`, `timed_out`, `duration_ms`, `truncated`가 포함된다. 파일 write/edit/rename 결과에는 `sha256`이 포함된다. 묶음은 트랜잭션이 아니므로 뒤 단계 실패 시 앞선 변경이 남는다. `changed_paths`와 `failed_step`을 보고 현재 파일을 다시 확인해야 한다. 자세한 크기·메모리·재시도 제한은 current contract를 따른다.

## `local.await_apply`

`local.prepare_apply`가 반환한 exact `proposal_id`, `workspace_id`, `workspace_binding`으로 승인·적용 결과를 최대 30초 기다린다. timeout은 실패나 완료가 아니므로 같은 proposal을 다시 기다릴 수 있다. `succeeded`를 받은 뒤에도 관련 파일을 `fs.read`/`fs.list`로 다시 확인해야 한다.
새 수정 요청을 시작하는 action이 아니며, 앞선 `local.prepare_apply`의 `proposal_id`가 없으면 호출하지 않는다.

## 권장 agent loop

```text
known path: fs.read -> direct mutation -> fs.read
unknown path: fs.list/fs.search -> fs.read -> direct mutation -> fs.read/fs.list
verification: project.run -> failure inspection -> direct mutation -> project.run
git commit/push: fs.* mutations -> project.git add -> commit -> push (or git items in local.prepare_apply)
Mutation-capable bundle path: fs.read -> local.prepare_apply -> automatic claim/apply -> local.await_apply -> fs.read/fs.list
extra folder: fs.reference_request -> owner-selected mode -> fs.reference_request_await -> fs.reference_list -> fs.* / project.exec with granted access
explicit Goal: project.goal_update create -> linked project.exec/await_exec or verify_file -> checkpoint -> project.goal -> complete
```

성공한 direct mutation/check는 ChatSplice 왼쪽 project row에 최근 tool, path, summary로 표시한다. 이는 현재 daemon session의 provenance이며 영구 audit log가 아니다.

## Tool descriptor와 schema 버전 정책

ChatGPT Developer Mode app은 승인된 시점의 tool descriptor(input schema, annotation 포함)를 frozen snapshot으로 사용한다. 서버가 descriptor를 바꿔도 기존 대화나 기존 app 설정에는 자동 반영되지 않으므로 다음 규칙을 따른다.

- Schema 변경은 additive-only를 원칙으로 한다. 새 optional field 추가는 허용하고, field 필수화·제거·의미 변경은 tool 이름 또는 bundle version(`chatsplice.apply.v1`)을 올려 표현한다.
- 제거하는 field는 한 milestone 이상 deprecated 상태로 수용한다. 서버는 알 수 없는 field를 거부하지만, caller가 보낼 수 있는 이전 field의 마이그레이션 기간을 이 문서로 추적한다.
- MCP TypeScript SDK transport version은 pin하며 `protocolVersion` 협상 결과를 임의로 올리지 않는다.
- 도구 목록 변화나 input contract 변경에는 두 가지 원격 snapshot 갱신이 따라야 한다. Project instructions 재등록(`Project 지침 다시 등록`)과 Developer Mode app descriptor refresh다. 두 snapshot이 모두 갱신된 새 chat에서만 새 계약의 E2E를 선언한다.
- `Refresh`/`Scan Tools`는 Settings catalog 누락 또는 실제 schema/version mismatch가 관찰될 때만 쓰는 복구 절차다. 정기 작업이 아니다.
- Server identity(`chatspliced`)와 tool 개수(현재 24개)는 이 문서 상단의 계약이다. 이번 두 Goal 도구 추가의 결정과 권한 경계는 [Goal runtime amendment](current-contract.md#goal-runtime-amendment-2026-10-11)에 기록한다.

### 공통 개발 runtime 보완 (2026-10-21)

Node/Cargo/root check와 shell에 설치된 runtime/library/shim 읽기와 프로젝트별 npm/pnpm·pip/uv·Cargo·Go·Mix/Hex/Rebar·compiler cache를 연결한다. 구조화 검사에서도 Git metadata를 읽고 선택된 Node/Rust와 프로젝트 .venv Python을 함께 사용할 수 있다. macOS job runtime은 짧고 검증된 0700 경로이며 WORKSPACE/RUNTIME 아래 Unix socket을 local 네트워크에 포함한다. custom runtime 경로나 없는 도구는 실제 설치·승인 폴더 연결이 필요할 수 있다. 자동으로 모든 언어를 설치하거나 존재만으로 실행 성공을 표시하지 않는다. 자세한 검증과 실행본 적용은 [개발 환경·Goal 기록](development-goals-20261021.md)을 따른다.
