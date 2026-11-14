# Cargo 잔여 실행 호환성 보완 — 2026-10-20

## 결론과 작업 범위

별도 테스트 프로젝트에서 보고한 361개 통과·12개 실패·2개 ignored 결과는 사용자 제공 기록이다. 이번 작업은 현재 연결된 ChatSplice 저장소에서 실행 정책을 조사하고 수정했다. 승인된 추가 폴더가 없는 현재 연결에서 별도 테스트 프로젝트의 소스, Goal, receipt 예산은 변경하지 않았다. 별도 테스트 프로젝트의 12개 검사 전체나 AC-019가 통과했다고 판단하지 않는다.

작은 독립 Rust fixture로 현재 public 전용 Cargo의 Node 경로 접근과 localhost 조회 실패를 재현했다. 동일 fixture는 일반 shell에서 3개 모두 통과했다. 이 비교와 소스 대조를 근거로 Cargo의 optional trusted Node 준비, 검증된 runtime/cache root의 조상 디렉터리 접근, hosts 읽기를 보완했다. 실행 계약은 `development-runtime-2`다.

## 실제 실행에서 분리한 원인

| 관측                                                      | 현재 전용 Cargo                          | 같은 fixture의 일반 local shell        |
| --------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| PATH Node의 root dirfd/openat와 1바이트 읽기              | `.nvm` 성분 index 2에서 EPERM            | 통과, 8개 경로 성분                    |
| 숫자 IPv4·IPv6의 실제 HTTP                                | 통과                                     | 통과                                   |
| localhost 주소 조회 후 HTTP GET /allowed·Host 수신        | hosts 읽기 EPERM과 이름 조회 오류로 실패 | 조회와 요청·응답 관측 통과             |
| canonical resolv.conf 읽기·mDNSResponder Unix socket 연결 | 각각 EPERM                               | 각각 EPERM이지만 localhost 기능은 통과 |

전용 Cargo 실행은 2026-10-20 14:21:38 UTC 종료, `cargo test --offline --locked`, 1개 통과·2개 실패·exit 101이다. 실패는 별도 Cargo 진단 fixture의 결과이며 별도 테스트 프로젝트의 12개 검사를 반복한 결과가 아니다.

일반 shell 비교는 `(로컬 실행 ID 생략)`, 14:25:26 UTC 종료, 같은 fixture의 `cargo test --offline --locked -- --nocapture`, 3개 통과·exit 0이다. 이것은 현재 두 실행 경로의 차이를 보여주며, 새 전용 Cargo 정책 적용 성공을 대신하지 않는다.

기본 개발 기능 진단은 HTTP·PTY·descriptor walk·symlink fixture·private-runtime hardlink·libproc 자기 PID/UID/parent/path의 필수 6개를 통과했다. 이전 기록의 필수 3개 실패와 달리 현재 일반 실행에서는 이 기능들이 동작한다. 선택적 `/bin/ps`는 여전히 EPERM이다. 따라서 이전 변경이 전혀 적용되지 않았다고 단정하거나 전부 재시작 문제로 설명하지 않는다.

## 소스 보완

- `packages/core/src/project/pi-prepare.ts`: Cargo와 Rust install도 설치된 Node를 기존 trusted executable resolver로 선택한다. Node는 선택 사항이며 없으면 순수 Rust 작업은 계속 준비된다. 기존 실행 직전 `revalidateTrustedExecutables`가 Node도 다시 확인한다.
- `packages/core/src/project/pi-sandbox.ts`: 최종 명령의 조상 읽기 입력에 실행 파일 root, Node root, Corepack cache를 포함한다. PATH의 Node와 sandbox의 Node 읽기 root가 일치하도록 준비 결과를 전달한다.
- `packages/core/src/project/run-task.ts`: root check도 package-manager/Node/Corepack root의 정확한 조상 디렉터리 읽기를 포함한다.
- `packages/core/src/project/development-sandbox.ts`: 최종 명령에서 `/private/etc/hosts`의 정확한 file-read-data를 허용한다. 일반 shell이 resolver 설정·socket 없이도 localhost를 조회한 실제 결과에 따라 이 파일만 보완한다.
- `packages/protocol/src/schemas.ts`: execution contract를 `development-runtime-1`에서 `development-runtime-2`로 갱신해 이전 실행본과 구분한다. Control protocol 4, descriptor 0.0.14, MCP 도구 24개는 유지한다.

조상 접근은 검증 root의 정확한 DIRECTORY 읽기이며 형제 파일 본문과 runtime root 쓰기를 추가하지 않는다. 보호 경로 deny, 기존 파일 검증·폴더 권한·preflight, 외부 IP 통신 제한, Cargo 의존성 offline은 유지한다. 일반 DNS 설정 파일이나 resolver Unix socket, privileged binary 실행 우회는 추가하지 않았다.

## 회귀 검사와 진단 파일

`trusted-runtime-access.test.ts`의 새 5개 회귀는 Cargo와 두 Rust install의 Node 준비, Node 없는 Rust 준비, 준비 결과에서 최종 spawn profile까지 Node/Rust/Corepack 및 조상 규칙 전달을 확인한다. `development-sandbox.test.ts`는 hosts 허용 순서와 보호 규칙을 확인하며 `development-capabilities.test.ts`의 기존 native Cargo fixture에는 실제 localhost 조회와 Host 수신을 추가했다.

독립 진단은 다음 네 파일로 구성된다.

- `scripts/cargo-runtime-smoke/Cargo.toml`
- `scripts/cargo-runtime-smoke/Cargo.lock`
- `scripts/cargo-runtime-smoke/.cargo/config.toml`
- `scripts/cargo-runtime-smoke/src/lib.rs`

외부 crate 의존성은 없다. 세 Rust 검사는 Node descriptor 접근, 숫자 IPv4/IPv6 HTTP, localhost 조회와 GET /allowed·Host 관측을 구분한다. Resolver 파일/socket의 실패는 관측으로 출력하고 실제 localhost 동작이 실패하면 검사를 실패시킨다. HTTP 작업과 fd는 종료 시 정리하며 DNS/socket probe 대기는 제한된다.

Cargo의 cwd는 반드시 `scripts/cargo-runtime-smoke`로 지정한다. 하위 config의 target-dir은 저장소의 `node_modules/.cache/chatsplice-cargo-runtime-smoke`로 해석되며 Cargo metadata 경로를 정규화해 일치함을 확인했다. 이번 진단이 만든 종전 `scripts/cargo-runtime-smoke/target`만 Cargo clean으로 정리했다. 생성물을 소스 snapshot에 포함하지 않도록 stage 스크립트는 변경하지 않았다.

## 검증 결과

| 검사                                                        | 결과와 한계                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 관련 core 회귀 7개 파일                                     | 63개 통과. 새 테스트의 type import 정리 후 해당 5개를 다시 통과했으며 합계에 중복 가산하지 않음 |
| 선택한 protocol 3개 파일                                    | 26개 통과·5개 실패. 전체 protocol 통과가 아님                                                   |
| protocol/core/MCP/desktop/renderer 타입                     | 모두 통과, Svelte 오류·경고 0개. 마지막 테스트 변경 뒤 core 타입 재검증 통과                    |
| 변경 코드 ESLint·Prettier                                   | 최종 통과                                                                                       |
| 독립 Rust fixture의 rustfmt                                 | 통과                                                                                            |
| 일반 shell의 독립 Rust fixture                              | 3개 통과                                                                                        |
| 현재 전용 Cargo의 독립 fixture                              | 1개 통과·2개 실패, 위 baseline으로 보존                                                         |
| 새 policy의 native macOS 전체 회귀                          | 미실행. 기존 managed nested sandbox 초기화 거부를 통과로 바꾸지 않음                            |
| 별도 테스트 프로젝트 원래 검사·integration·API/worker smoke | 이번 연결에서 실행하지 않음                                                                     |
| 별도 staged runtime build                                   | 통과, 아래 manifest와 compiled 코드 재읽기 확인                                                 |

Protocol의 실패는 `schemas.test.ts`가 기대하는 Project 안내문 구문과 현재 생성 구문의 불일치인 5개 테스트 케이스다. 변경 전 schemas.ts의 실행 버전 선언 한 곳을 치환하면 현재 파일 전체와 일치하며, 안내문 생성 함수는 이 상수나 execution-contract 문자열을 참조하지 않는다. 따라서 이번 marker 변경과 독립적이다. 안내문이나 assertion을 수정하지 않았으며 문구 불일치를 근거로 기존 기능 전체가 정상이라고 단정하지 않는다. 안내문의 PROJECT INSTRUCTIONS v1과 runtime의 development-runtime-2는 서로 다른 버전 표기다.

중간 검사에서 새 테스트의 type import lint 2건과 비교 스크립트의 정규화하지 않은 Cargo target 경로 비교가 실패했다. Type import를 프로젝트 규칙에 맞추고 경로 비교를 정규화한 후 최종 검사를 통과했다. 해당 중간 실패를 처음부터 통과한 것으로 기록하지 않는다.

실제 Rust 컴파일에는 xcrun의 OS 임시 cache 생성 경고가 남았고, 일반 shell 비교에서 incremental cache hardlink 대신 copy를 사용하는 경고도 있었다. 컴파일과 해당 세 검사는 완료됐으므로 이를 테스트 실패와 구분한다.

## 새 빌드와 적용

`pnpm build:staged`는 382개 소스·설정 입력을 고정해 원본 dist와 현재 앱을 교체하지 않고 새 runtime을 빌드했다. 빌드 전후 source fingerprint 일치와 manifest, desktop/daemon identity, compiled Node 준비·hosts 정책·execution marker를 재읽어 확인했다.

| 항목                             | 확인 값                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| 후보 경로                        | `node_modules/.cache/chatsplice-runtime-ttsotj`                    |
| 빌드 완료 UTC                    | `2026-10-20T14:37:12.046Z`                                         |
| source SHA-256                   | `cc25f49e15ed47c8293a35e3174eb2ae65f2649f0127429819a043e72762aa05` |
| desktop build ID                 | `3dfb1554a8d19293aa35abde63bef9356b9cd4db39df66f31ed5de5187934483` |
| daemon build ID                  | `9f1eb104aad80536926cea8914fc28ef66184d38f89a577fd3b360169d8dc1f1` |
| tool schema digest               | `04b550f7b11abd17613b46f145160a8785483853b885100c75124f2f41f996a2` |
| execution / descriptor / 도구 수 | `development-runtime-2` / `0.0.14` / 24                            |

이 빌드가 현재 앱에서 실행 중이라는 뜻은 아니다. 현재 연결 도구에 owner daemon 재시작 작업이 없고, 도구 설명의 cached marker만으로 active build를 판정할 수도 없다.

진행 중인 작업을 정리하고 기존 ChatSplice를 정상 종료한 뒤, 저장소 루트의 일반 macOS 터미널에서 검증된 후보를 시작한다.

```sh
pnpm --dir node_modules/.cache/chatsplice-runtime-ttsotj start
```

원본 소스를 다시 빌드해 실행하려면 같은 정상 종료 후 저장소 루트에서 `pnpm dev`를 사용할 수 있다. 실행 중인 앱을 둔 채 root build/dev로 기존 dist를 지우지 않는다.

새 실행본 적용 후 이 저장소에서 public MCP의 작은 Cargo 진단을 먼저 확인한다.

```json
{
  "cwd": "scripts/cargo-runtime-smoke",
  "operation": { "kind": "cargo", "task": "test" }
}
```

위 조각은 기존 정확한 workspace binding·fresh request_id·timeout과 함께 사용한다. 이 별도 진단을 별도 테스트 프로젝트 Goal의 rust_behavior 근거로 등록하지 않는다. 일반 macOS 터미널에서 새 최종 sandbox의 native 경계 회귀도 확인한다.

```sh
node scripts/check-workspace-folders.mjs unit core src/project/development-capabilities.test.ts
```

이후 정확히 연결된 별도 테스트 프로젝트에서 기존 Goal/root/파일을 재검증하고 명시적으로 재개한다. `/bin/ps`에 의존하는 필수 소유권 검사는 해당 호출부의 지원 구현과 실제 대상 프로세스 검증이 필요하다. 현재 확인한 libproc 자기 프로세스 조회 성공은 그 검사를 대신하지 않는다. hostname discovery의 GET /allowed 미관측도 새 환경에서 독립 재검증한다. 등록된 rust_behavior와 integration·API/worker smoke를 현재 근거로 갱신하며, 환경 적용 근거 없이 동일 전체 Cargo 검사를 반복하지 않는다.

## 참고한 공식 소스

- [Chromium macOS network sandbox profile](https://chromium.googlesource.com/chromium/src/+/cfbe56f17a3d7a3397a09d091252db6e3470223d/sandbox/policy/mac/network.sb): hosts/resolver 파일과 네트워크 권한을 개별 지정하는 구성을 확인했다. 이 전체 권한 집합을 복사하지 않았다.
- [Cargo configuration relative paths](https://doc.rust-lang.org/cargo/reference/config.html#config-relative-paths): fixture의 별도 target 경로와 cwd에 따른 config 검색 규칙을 확인했다.
- [Apple Darwin fcntl.h](https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h): 진단 fixture의 macOS openat 플래그 정의를 확인했다.
