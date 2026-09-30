# Milestone 0–2C MCP tools

서버 identity는 `chatspliced`이며 현재 tool은 22개다.

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
local.prepare_apply
local.await_apply
```

ChatGPT Chat이 reasoning/iteration loop를 맡고 ChatSplice MCP가 bounded local 도구를 제공합니다. 읽기 도구는 `workspace.list`, `fs.reference_*`(`fs.reference_request` 제외), `fs.list/search/read`, `local.await_apply`, `project.await_exec`입니다. `local.prepare_apply`는 자동 변경을 유발하는 **write 도구**이며 destructive/open-world로 선언합니다. `project.git`과 `project.exec`도 network 가능성을 선언합니다. `fs.reference_request`는 파일을 바꾸지 않지만 새 권한을 요청하는 도구라 동일하게 write 도구로 선언하고 읽기 전용 모드에서 차단됩니다. 별도 코딩 모델은 호출하지 않습니다. 요금제별 공식 안내가 일치하지 않으므로 계정의 실제 도구 노출·호출로 확인합니다. 현재 채팅이 read-only라면 자동 적용을 사용할 수 없습니다.

## `project.exec` / `project.await_exec` / `project.cancel_exec`

`project.exec`는 정확한 workspace binding, 새 `request_id`, 상대 `cwd`, `operation`, 제한된 `timeout_ms`로 작업을 제출하고 `job_id`를 반환합니다. `operation`은 선언된 Node script, Cargo 검사, lockfile 기반 프로젝트 의존성 설치입니다. manifest의 dependency를 변경했다면 install의 `mode: "resolve"`로 lockfile만 갱신하고 다시 읽은 뒤, 새 request_id로 `mode: "locked"` 설치를 호출합니다. mode 기본값은 locked이며 Node 설치는 npm/pnpm을 지원합니다. Pi SDK의 실행 도구를 사용하며 Pi 모델·provider·OAuth는 생성하지 않습니다. `project.await_exec`로 실제 종료 결과와 제한된 로그를 확인하고, `project.cancel_exec` 또는 사이드바의 취소 버튼으로 동일 workspace/job을 중단합니다. 취소는 앞서 완료된 쓰기나 설치를 되돌리지 않습니다. 상세 범위와 제한은 [실행 계약](model-free-execution.md)을 따릅니다.

## `fs.reference_request` / `fs.reference_request_await`

등록되지 않은 임의의 절대 경로를 코덱스처럼 그 자리에서 참조하기 위한 승인 브리지다. `fs.reference_request`는 `workspace_id`, `workspace_binding`, `path`, 선택적 `label`을 받아 `request_id`와 `pending_approval` 상태를 즉시 반환한다 — 이 호출만으로는 아무 것도 열리지 않는다. ChatSplice 데스크톱 앱이 소유자에게 네이티브 승인 대화상자를 띄우고, 소유자가 그 자리에서 허용/거부를 결정한다. 허용되면 가벼운 `reference` 종류 workspace가 등록되고(프로젝트 목록에는 나타나지 않고 ChatGPT Project로 연결되지도 않는다) 해당 workspace로의 read-only reference가 자동으로 생성되어 이후 `fs.reference_list`에 나타난다. `fs.reference_request_await`는 이전 요청의 `request_id`로 결정을 기다리기만 하는 continuation 전용 도구다. 승인된 참조는 오직 `fs.reference_paths`/`fs.reference_search`/`fs.reference_read`를 통해서만 읽을 수 있으며, 쓰기 권한은 절대 부여되지 않는다.

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

기존 regular UTF-8 file만 읽는다. 응답에는 검증된 workspace ID/name, content, line/byte metadata, full-file SHA-256, `truncated`가 포함된다. replace/edit/rename/delete에 사용할 SHA는 반드시 같은 path의 직전 **full non-truncated read**에서 얻는다.

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
ad-hoc reference: fs.reference_request -> owner approval -> fs.reference_request_await -> fs.reference_list/paths/search/read
```

성공한 direct mutation/check는 ChatSplice 왼쪽 project row에 최근 tool, path, summary로 표시한다. 이는 현재 daemon session의 provenance이며 영구 audit log가 아니다.

## Tool descriptor와 schema 버전 정책

ChatGPT Developer Mode app은 승인된 시점의 tool descriptor(input schema, annotation 포함)를 frozen snapshot으로 사용한다. 서버가 descriptor를 바꿔도 기존 대화나 기존 app 설정에는 자동 반영되지 않으므로 다음 규칙을 따른다.

- Schema 변경은 additive-only를 원칙으로 한다. 새 optional field 추가는 허용하고, field 필수화·제거·의미 변경은 tool 이름 또는 bundle version(`chatsplice.apply.v1`)을 올려 표현한다.
- 제거하는 field는 한 milestone 이상 deprecated 상태로 수용한다. 서버는 알 수 없는 field를 거부하지만, caller가 보낼 수 있는 이전 field의 마이그레이션 기간을 이 문서로 추적한다.
- MCP TypeScript SDK transport version은 pin하며 `protocolVersion` 협상 결과를 임의로 올리지 않는다.
- 도구 목록 변화나 input contract 변경에는 두 가지 원격 snapshot 갱신이 따라야 한다. Project instructions 재등록(`Project 지침 다시 등록`)과 Developer Mode app descriptor refresh다. 두 snapshot이 모두 갱신된 새 chat에서만 새 계약의 E2E를 선언한다.
- `Refresh`/`Scan Tools`는 Settings catalog 누락 또는 실제 schema/version mismatch가 관찰될 때만 쓰는 복구 절차다. 정기 작업이 아니다.
- Server identity(`chatspliced`)와 tool 개수(현재 22개)는 이 문서 상단의 계약이다. tool 개수 변화는 ADR로 기록한다.
