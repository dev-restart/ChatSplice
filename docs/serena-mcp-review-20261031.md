# Serena 검토와 MCP 탐색 개선 — 2026-10-31

## 결론과 범위

현재 ChatSplice의 SHA 기반 exact edit, 폴더별 권한, 실행 수명 관리가 이미 확보되어 있으므로 이를 유지하면서 필요한 코드만 조회하는 흐름을 보강했다. 이번 변경은 선택적 검색 문맥과 읽기 결과의 완전성 표시를 독립 구현한 것이다. Serena 전체 통합, 언어 서버 실행, 심볼 참조 조회나 심볼 수정 기능을 구현했다고 표현하지 않는다.

조사 대상은 사용자가 지정한 Serena 로컬 복제본과 공개 upstream이다. 로컬 pyproject 버전은 2.1.1.dev0이고 LICENSE는 SolidLSP MIT / Serena application GPL-3.0-or-later 구분을 명시한다. 공개 조사 스냅샷은 ede329aaf0c824bea75455a2926f01420d7aa620이다. 확인한 로컬 검색/개요 코드 범위와 README는 해당 스냅샷과 일치했지만 로컬 checkout 전체의 commit을 조회하지 않았으므로 동일 커밋으로 단정하지 않는다.

Serena source code를 복사하거나 새로운 dependency를 설치하지 않았다. 프로젝트의 기존 dependency와 MIT 구현 경계를 유지했다.

## 확인한 장점과 적용 판단

| 기능                | Serena의 이점                                         | 이번 판단                                                |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| 함수·클래스 개요    | 본문 없이 구조부터 조회                               | 향후 선택적 읽기 전용 분석 backend 후보                  |
| 심볼 검색·실제 참조 | 이름이 같은 문자열과 실제 사용 관계를 구분            | 큰 리팩터링에서 가치가 크지만 현재 미구현                |
| 검색 주변 문맥      | 일치한 줄의 의미를 추가 파일 조회 없이 판단 가능      | 기존 literal 검색에 선택적으로 구현                      |
| 결과량 제한         | 필요한 위치와 후속 조회 정보를 유지하면서 출력을 제한 | 문맥 자체의 상한과 명시적 잘림 상태 구현                 |
| 심볼 본문 교체      | 구조적 대상을 정확히 선택                             | 현재 SHA/exact edit를 유지                               |
| LSP 캐시·갱신       | 반복 조회를 줄이고 코드 변경을 동기화                 | 서버 수명·언어별 의존성·갱신 검증이 필요하므로 후속 범위 |

언어 서버를 통합할 경우 기존 source binding, canonical path, 읽기/쓰기 허용 폴더, SHA 충돌 검사를 그대로 통과시키는 읽기 전용 탐색 backend부터 시작하는 편이 적절하다. 단순 문자열 검색을 semantic reference 기능이라고 표시하지 않는다. 이번 작업에서 실제 토큰 사용량이나 전체 작업 속도 개선율은 측정하지 않았다.

## 구현한 동작

### 검색 문맥

`fs.search`와 레거시 `fs.reference_search`에 `context_lines`를 추가했다.

- 기본 0이며 기존 결과 구조를 유지한다.
- 1–3을 요청하면 각 결과의 `context_before` / `context_after`에 원래 줄 번호, 줄 텍스트, 줄별 `truncated`를 반환한다.
- 문맥 한 줄은 최대 200 UTF-16 단위와 말줄임표로 제한하고 surrogate pair를 자르지 않는다.
- 한 결과 페이지의 문맥 텍스트는 말줄임표를 포함한 UTF-8 16 KiB 이내다. 전체 JSON payload 16 KiB를 의미하지 않는다.
- 문맥이 축약되거나 예산 때문에 빠지면 `context_truncated: true`다. 검색 resource cap의 `truncated`, 다음 결과 존재 여부인 `has_more`와 별개다.
- offset으로 건너뛴 결과와 다음 페이지 확인용 결과에는 문맥 예산을 사용하지 않는다.
- 실제 파일 경계에는 빈 배열을 반환하며, 마지막 개행으로 가짜 줄을 만들지 않는다.
- CRLF와 내부 빈 줄의 원래 번호를 유지한다.
- NUL 포함 파일과 malformed UTF-8을 검색에서 제외하고 `skipped_files`로 집계한다.

호출 예시는 기존 바인딩 인자에 다음 검색 조건을 추가하는 방식이다.

```json
{
  "path": "packages/core/src/fs",
  "glob": "*.ts",
  "query": "lineTruncated",
  "context_lines": 2,
  "limit": 5
}
```

문맥은 탐색용 미리보기다. 실제 수정 전에는 현재 파일 전체를 빠짐없이 읽고 full-file SHA와 exact old_text를 사용한다. 문맥 결과로 새 쓰기 권한이나 SHA를 만들어내지 않는다.

### 파일 읽기 완전성

기존 구현은 `start_line > 1`로 파일 끝까지 읽었을 때 앞부분을 생략했는데도 `truncated: false`가 될 수 있었다. 실제 줄이 생략된 suffix-only 읽기는 이제 true다. 전체 파일 SHA는 계속 원래 파일 bytes를 대상으로 계산한다.

파일 끝보다 큰 `end_line`은 실제 끝으로 제한하므로, 모든 내용을 반환한 경우 불필요하게 partial로 표시하지 않는다. 빈 논리 줄을 포함한 결과의 end_line도 정확히 계산한다. 빈 파일, 범위를 벗어난 읽기, 2,000줄 상한과 UTF-8 byte 경계를 회귀 검사했다. 기존 CRLF/끝 개행 정규화 규약은 변경하지 않았다.

## 변경 파일

코드·검사:

- packages/protocol/src/schemas.ts
- packages/protocol/src/fs-search-context.test.ts
- packages/core/src/fs/discover-workspace.ts
- packages/core/src/fs/read-file.ts
- packages/core/src/fs/read-file.test.ts
- packages/core/src/fs/search-context.test.ts
- packages/mcp-server/src/mcp/tools-fs.ts
- packages/mcp-server/src/mcp/tools-workspace.ts
- packages/mcp-server/src/mcp/workspace-folders.test.ts
- packages/mcp-server/src/mcp/tool-catalog.test.ts

문서: AGENTS.md, docs/current-contract.md, docs/mcp-tools.md, docs/agent-progress.md 및 이 문서.

MCP descriptor는 0.0.21이고 tool count 24, control protocol 5, execution contract development-runtime-4는 유지한다. 의존성 manifest와 lockfile은 이번 작업에서 변경하지 않았다. 기존 사용자 미커밋 작업은 보존했다.

## 검증 결과

| 검사                                              | 결과                                       |
| ------------------------------------------------- | ------------------------------------------ |
| 수정 전 core 관련 기준선                          | 38개 통과                                  |
| 수정 후 core 검색/읽기/수정/연결 폴더 검사        | 49개 통과                                  |
| 신규 protocol 스키마 검사                         | 3개 통과                                   |
| MCP HTTP / 연결 폴더 / catalog / 결과 검증        | 20개 통과                                  |
| 전체 protocol/core/MCP/desktop/renderer 타입 검사 | 전부 exit 0                                |
| Svelte 진단                                       | 오류 0, 경고 0                             |
| 변경 TypeScript 10개 ESLint                       | 통과                                       |
| 변경 TypeScript 10개 Prettier                     | 초기 5개 스타일 경고를 수정한 뒤 최종 통과 |
| pnpm build:staged                                 | 통과, 별도 실행본 생성                     |

수정 후 관련 테스트 합계는 72개다. 기준선 38개를 중복 가산하지 않는다. HTTP 검사는 테스트용 실제 local MCP server/client로 새 입력 스키마, generic/legacy 검색 결과, read-only 폴더 수정 거부를 확인한다. 실행 중인 사용자 daemon이나 ChatGPT 연결의 새로운 도구 노출까지 통과한 것으로 해석하지 않는다.

전체 저장소 test/verify를 실행한 결과는 아니다. 기존 대소문자 무시 검색에서 일부 Unicode 소문자 변환이 문자열 길이를 바꾸는 경우의 column 계산은 변경하지 않았다. 이번 요청에서 UI 동작을 변경하지 않았고 native UI 검사는 수행하지 않았다. 빌드는 renderer의 기존 500 KiB 초과 chunk 안내와 기본 Svelte config 안내를 출력했으며 exit 0으로 완료됐다.

## 빌드와 실제 적용

- 생성 시각: 2026-10-31 22:53:57 KST
- candidate: node_modules/.cache/chatsplice-runtime-O3rmPS
- source SHA-256: 9a5e7d89ec033af526dc4929c116483a72a4045e411883afc6cbe2fba9764ab4
- desktop build: 0b35ecfea37948a613c7d34b45bbcbdf013f7880f740bd7e0123f0297dd6f6bc
- daemon build: d90b695c7be163bac112ae50a46c58ded78f52a4a9b004e8c08c429d05a11fb8
- catalog digest: 6da698781afbae048c4feaa4ec52a9ac45ecff0ba21ce2e79f4ecb67b68d7089

412개 build input의 snapshot을 빌드 전후 비교했고, 저장된 runtime-candidate.json과 desktop runtime-identity.json에서 버전/도구 수/digest/daemon identity 일치를 재확인했다. 이 실행본은 기존 checkout dependency를 참조하는 로컬 실행본이다.

현재 앱/daemon과 원본 dist는 교체하지 않았다. 미저장 편집과 진행 중 작업을 마친 뒤 정상 종료하고 다음 실행본을 시작한다.

별도로 만든 실행본을 사용하려면 `pnpm build:staged`가 출력한 폴더에서 `pnpm start`를 실행합니다.

그다음 연결 도구 정의를 Refresh하고 `fs.search.context_lines` 노출 및 실제 호출 결과를 확인한다. Refresh만으로 구 daemon 코드가 교체되지는 않는다. 이 작업에서는 앱 강제 종료, commit, push를 하지 않았다.

주요 실행 ID:

- core: (로컬 실행 ID 생략)
- protocol: (로컬 실행 ID 생략)
- MCP: (로컬 실행 ID 생략)
- 최종 types: (로컬 실행 ID 생략)
- lint: (로컬 실행 ID 생략)
- 최종 format: (로컬 실행 ID 생략)
- build: (로컬 실행 ID 생략)

실행 ID는 현재 daemon의 memory-only 기록이며 재시작 후 조회를 보장하지 않는다.

## 참고한 1차 자료

- [Serena 저장소](https://github.com/oraios/serena)
- [도구와 API](https://oraios.github.io/serena/01-about/035_tools.html)
- [언어 서버 지원 조건](https://oraios.github.io/serena/01-about/020_programming-languages.html)
- [프로젝트와 인덱싱](https://oraios.github.io/serena/02-usage/040_workflow.html)
- [구성요소별 라이선스](https://oraios.github.io/serena/01-about/060_license.html)
- 공개 스냅샷의 src/serena/tools/file_tools.py, src/serena/repl/api/fs_api.py, src/serena/repl/api/lsp_api.py, src/serena/ls_manager.py와 해당 로컬 복제본의 관련 범위.
