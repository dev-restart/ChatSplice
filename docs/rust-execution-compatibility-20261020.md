# Rust 개발 실행 호환성 — 2026-10-20

## 요청과 확인 범위

별도 테스트 프로젝트 작업에서 일반 명령은 Rust 1.96을 사용하지만 Cargo 전용 검사는 1.85를 고르고, /bin/ps 실행이 거부된다는 보고를 기준으로 ChatSplice의 model-free Pi 실행 경로를 조사하고 수정했다. 이 작업은 ChatSplice 소스에 적용했으며 별도 테스트 프로젝트의 소스·Goal·기한·예산을 변경하지 않았다.

## 실제 관측과 원인

2026-10-20 16:45–16:46 KST의 로컬 MCP 실행에서 다음을 관측했다.

| 항목                        | 관측                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| 일반 shell Cargo            | cargo 1.96.0 (30a34c682 2026-05-25)                                                   |
| 일반 shell Rustc            | rustc 1.96.0 (ac68faa20 2026-05-25)                                                   |
| Rustup                      | 1.29.1                                                                                |
| 활성 도구 모음              | stable-aarch64-apple-darwin (default)                                                 |
| 설치 목록                   | 1.85.0-aarch64-apple-darwin, 1.96.0-aarch64-apple-darwin, stable-aarch64-apple-darwin |
| rustup which cargo / rustc  | 둘 다 stable 도구 모음의 같은 bin                                                     |
| /bin/ps 파일 속성           | root 소유, mode 4755                                                                  |
| 현재 작업 PID만 조회하는 ps | 시작 단계에서 EPERM, 종료 코드 없음                                                   |
| 대조 명령 /usr/bin/true     | 종료 코드 0                                                                           |

기존 resolveTrustedCargo는 Rustup proxy를 건너뛰고 설치된 도구 모음 이름을 문자열 오름차순으로 정렬하여 첫 사용 가능한 Cargo를 선택했다. 프로젝트 pin이나 활성 기본 버전을 확인하지 않는 실제 소스 결함이며, 작업 기록의 1.85 선택 보고와 일치한다.

일반 shell의 CARGO_HOME은 개별 runtimeDirectory 아래에 있었고 작업 종료 시 삭제됐다. 반면 전용 Cargo만 별도 프로젝트 캐시를 사용했다. 따라서 shell의 다운로드·설치 상태가 다음 shell이나 전용 offline Cargo로 이어지지 않았다.

전용 Cargo 준비 단계는 프로젝트 .cargo/config와 config.toml의 내용에 관계없이 실행을 거부했다. 정상적인 target, linker, runner, wrapper, rustflags 설정도 같은 제한에 걸리는 구조였다.

현재 sandbox 프로필은 기본 동작과 /bin 읽기·실행을 허용한다. 실제 ps EPERM과 setuid 속성은 macOS 실행 경계의 특권 실행 파일 호환성 문제를 시사한다. 정확한 커널 거부 코드까지 수집한 것은 아니므로 특정 커널 규칙을 확정하지 않는다. Pi adapter의 해당 경로는 별도 모델을 호출하지 않는다.

## 적용한 동작

- Cargo 선택은 첫 신뢰 가능한 PATH 항목을 보존한다. Rustup proxy이면 실제 cwd에서 고정된 rustup which cargo 질의로 pin/override/default를 해석한다. 선택된 버전이 없으면 원인을 반환하고 다른 구버전으로 넘어가지 않는다.
- 질의는 최대 5초, stdout 12 KiB와 stderr 4 KiB로 제한한다. project pin은 읽기만 가능하며, private runtime 외 쓰기와 네트워크는 허용하지 않는다. 자동 toolchain 설치를 끄고 취소·시간 초과·출력 초과 시 소유 process group을 정리한다.
- 선택된 Cargo와 rustc가 같은 신뢰된 canonical bin/root에 있는지 검증하고, 전용 Cargo와 Rust 설치의 PATH 앞에 해당 bin을 둔다.
- 모든 command 경로가 검증된 프로젝트별 Cargo 캐시를 재사용한다. 개별 HOME/runtime 정리는 유지하며 shell PATH에 cache/bin을 포함한다. 다른 프로젝트와 cache root가 분리된다.
- 이 캐시는 OS 임시 영역의 로컬 캐시이므로 OS 정리 후에도 영구 보존된다고 보장하지 않는다. lockfile과 명시적인 의존성 설치는 계속 필요하다.
- 프로젝트 .cargo/config와 config.toml은 canonical directory, regular/single-link, bounded checked-read, strict UTF-8 검증 후 허용한다. TOML은 Cargo가 sandbox 안에서 해석한다. 프로젝트 credentials 3종 및 private Cargo cache의 config/credentials는 계속 거부한다.
- 생성된 Project 지침은 반환된 job_id, await, readiness, cancel 후 cleanup을 사용하도록 보완했다. 선택적 ps 실패는 다른 작업의 중단 이유가 아니며, 필수 검사의 성공 근거를 대신하지 않는다.
- Rustup 질의의 macOS sandbox 초기화 실패는 RUST_TOOLCHAIN_SANDBOX_UNAVAILABLE로 구분한다. 원래 오류를 보존하며 toolchain 재설치나 모델 거절로 잘못 안내하지 않는다.

Rustup 선택 규칙과 자동 설치 환경 변수의 공식 근거:

- https://rust-lang.github.io/rustup/overrides.html
- https://rust-lang.github.io/rustup/environment-variables.html

## 검증 결과

2026-10-20 17:10 KST 최종 검사:

| 검사                                                  | 결과                               |
| ----------------------------------------------------- | ---------------------------------- |
| Rust 선택·캐시·PATH·프로젝트 설정 및 기존 환경 검사   | 50개 통과                          |
| 실행 지속·Goal·참조 폴더 Project 지침                 | 6개 통과                           |
| 실제 실행 진입 전 프로젝트 Cargo credentials 3종 거부 | 3개 통과                           |
| 전체 TypeScript 검사: protocol/core/MCP/desktop       | 통과                               |
| Svelte 검사                                           | 오류 0, 경고 0                     |
| 변경 코드 Prettier 및 ESLint                          | 통과                               |
| 실제 sandbox 안의 Cargo 프로젝트 설정 검사            | 환경 차단으로 실패, 아래 원문 참조 |

총 59개가 통과했다. 이름 필터로 제외한 테스트는 통과 수에 포함하지 않았다. 초기 검증에서 발견한 type import 및 control-regex lint 4건은 수정 후 다시 통과했다. 기존 blanket config 거부 테스트는 실제 target-dir 적용을 검증하는 positive native 검사와 credential 거부 3종으로 대체하여 새 계약과 보호 조건을 함께 검사한다.

별도 native Cargo 실행은 현재 MCP command sandbox 안에서 다시 sandbox-exec를 시작하는 지점에서 차단됐다.

```text
[RUST_TOOLCHAIN_SANDBOX_UNAVAILABLE]
Rust toolchain inspection could not initialize the execution sandbox.
No toolchain selection or installation was performed.
sandbox-exec: sandbox_apply: Operation not permitted
```

이 실패는 전체 native Cargo 성공으로 계산하지 않았다. 새 rust-job-compatibility.test.ts에는 실제 shell→shell→Cargo 캐시 재사용, compiler/Cargo 버전 일치, 프로젝트 캐시 분리 검사를 추가했으며 이 환경에서는 해당 3개 native 검사의 통과를 주장하지 않는다. 현재 앱을 강제 종료하거나 사용자 daemon에 테스트용 우회를 추가하지 않았다.

검사 명령은 저장소 루트에서 다음과 같다.

```sh
node scripts/check-workspace-folders.mjs unit core src/project/rust-toolchain.test.ts src/project/cargo-cache-lifecycle.test.ts src/project/rust-command-environment.test.ts src/project/cargo-project-config.test.ts src/project/execution-environment.test.ts src/project/pi-trusted.test.ts
node scripts/check-workspace-folders.mjs unit protocol src/execution-continuity-instructions.test.ts src/goal-workflow-instructions.test.ts src/workspace-folders-instructions.test.ts
node scripts/check-workspace-folders.mjs types
```

중첩 sandbox가 없는 일반 로컬 터미널에서 수행할 native 검사:

```sh
node scripts/check-workspace-folders.mjs unit core src/project/rust-job-compatibility.test.ts
node scripts/check-workspace-folders.mjs unit core src/project/pi-execution.test.ts -t 'runs project Cargo configuration under the fixed offline policy'
```

## 실행 빌드와 재개

현재 소스를 pnpm build:staged로 별도 runtime에 빌드한다. ready 후보가 실제로 만들어졌는지는 아래 최종 빌드 기록과 runtime-candidate.json으로 확인한다. 빌드는 실행 중인 앱/daemon을 교체하지 않으며, 기존 작업과 미저장 파일을 마무리하고 정상 종료한 뒤 새 후보를 시작해야 한다. 도구 정의 새로고침만으로 코드는 적용되지 않는다. 이 변경은 MCP tool count, schema, execution contract를 바꾸지 않는다.

재개 후 같은 프로젝트에서 일반 shell의 cargo/rustc 버전과 전용 Cargo 검사를 비교하고, 프로젝트 설정 및 캐시 재사용을 확인한다. 기존 Goal의 근거는 실제 새 실행 결과로 갱신한다. /bin/ps의 특권 실행 자체가 허용됐다고 주장하지 않는다.

### 최종 빌드 기록

2026-10-20 17:14:29 KST에 분리 runtime 빌드가 종료 코드 0으로 완료됐다. 실제 runtime-candidate.json을 다시 읽어 빌드 결과의 source/desktop/daemon identity와 tool count가 일치함을 확인했다.

- 후보: `node_modules/.cache/chatsplice-runtime-ZHtFaH`
- 소스 SHA-256: `441725ce7d896a9d02752d07f59f63cdd06a3b2186a0489f3cd4290735b1e4d4`
- Desktop build ID: `37275c3d0621eeecf7713b383be26e824bec324c84f07b7b10d9b25710177210`
- Daemon build ID: `90a7903eca6fee62f1c801056cf4d9f9a2514ac653c6e1c4da717d63865d0978`
- 소스 snapshot: 373개 파일, 9383060바이트
- MCP descriptor: `0.0.14`, 24개 도구
- TypeScript 각 package, Electron main/preload/renderer, daemon identity 빌드: 완료
- 실제 앱/daemon 재시작과 새 실행기의 별도 테스트 프로젝트 Cargo 검증: 미수행

저장소 루트의 일반 터미널에서 현재 앱과 작업을 정상 종료한 뒤 다음 후보를 시작한다.

```sh
pnpm --dir node_modules/.cache/chatsplice-runtime-ZHtFaH start
```
