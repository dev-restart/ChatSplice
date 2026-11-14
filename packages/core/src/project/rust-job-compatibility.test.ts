import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectExecInputSchema, type ProjectExecOperation } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { executeProjectOperation } from './pi-execution.js';
import { nodeRuntimeVersionSupported, prepareCargoHome } from './pi-trusted.js';

/** These tests launch the real native sandbox; a nested denial is not a passing check. */
describe('Rust development across Pi jobs', () => {
  let temporaryDirectory: string;
  let root: string;
  let repository: SqliteWorkspaceRepository;
  let service: WorkspaceService;
  let workspaceId: string;
  let requestNumber: number;
  let ownedRoots: string[];

  beforeEach(async () => {
    temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'cs-rust-jobs-')));
    root = join(temporaryDirectory, 'workspace');
    await mkdir(root);
    repository = new SqliteWorkspaceRepository(join(temporaryDirectory, 'state.sqlite'));
    service = new WorkspaceService(repository);
    workspaceId = (await service.register({ root_path: root })).workspace_id;
    requestNumber = 0;
    ownedRoots = [root];
  });

  afterEach(async () => {
    repository.close();
    for (const ownedRoot of ownedRoots) {
      const cache = await prepareCargoHome(ownedRoot);
      await rm(cache, { recursive: true, force: true });
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const native = it.skipIf(process.platform !== 'darwin' || !nodeRuntimeVersionSupported());

  async function run(
    operation: ProjectExecOperation,
    targetWorkspaceId = workspaceId,
  ): Promise<{ output: string; exitCode: number | null }> {
    let output = '';
    requestNumber += 1;
    const result = await executeProjectOperation(
      service,
      ProjectExecInputSchema.parse({
        workspace_id: targetWorkspaceId,
        workspace_binding: `wb_${'a'.repeat(64)}`,
        request_id: `rust-compat-${requestNumber}`,
        timeout_ms: 30_000,
        operation,
      }),
      {
        onOutput: (chunk) => {
          output += chunk;
        },
      },
    );
    return { output, exitCode: result.exit_code };
  }

  async function rustFixture(buildScript: string): Promise<void> {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "rust_job_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn answer() -> u32 { 42 }\n');
    await writeFile(join(root, 'build.rs'), buildScript);
  }

  native(
    'reuses shell dependency cache in a later shell and dedicated offline Cargo job',
    async () => {
      await rustFixture(`
fn main() {
    let cache = std::path::PathBuf::from(std::env::var("CARGO_HOME").unwrap());
    let marker = std::fs::read_to_string(cache.join("registry/chatsplice-compatibility-marker"))
        .expect("the dedicated Cargo job must see the earlier shell dependency cache");
    assert_eq!(marker, "cache-ready");
    println!("cargo:rerun-if-changed=build.rs");
}
`);
      const seed = await run({
        kind: 'shell',
        network: 'local',
        command:
          'mkdir -p "$CARGO_HOME/registry" && printf cache-ready > "$CARGO_HOME/registry/chatsplice-compatibility-marker"',
      });
      expect(seed.exitCode, seed.output).toBe(0);
      const readBack = await run({
        kind: 'shell',
        network: 'local',
        command: 'cat "$CARGO_HOME/registry/chatsplice-compatibility-marker"',
      });
      expect(readBack).toEqual({ exitCode: 0, output: 'cache-ready' });
      const checked = await run({ kind: 'cargo', task: 'check' });
      expect(checked.exitCode, checked.output).toBe(0);
      expect(checked.output).toContain('Finished');
    },
    40_000,
  );

  native(
    'uses the same compiler and Cargo versions as the developer shell',
    async () => {
      await rustFixture(`
fn main() {
    let mut versions = String::new();
    for tool in ["rustc", "cargo"] {
        let result = std::process::Command::new(tool).arg("--version").output().unwrap();
        assert!(result.status.success(), "{tool} --version failed");
        versions.push_str(std::str::from_utf8(&result.stdout).unwrap());
    }
    std::fs::write("compiler-versions.txt", versions).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}
`);
      const shell = await run({
        kind: 'shell',
        network: 'local',
        command: 'rustc --version && cargo --version',
      });
      expect(shell.exitCode, shell.output).toBe(0);
      expect(shell.output).toMatch(/^rustc /mu);
      expect(shell.output).toMatch(/^cargo /mu);
      const checked = await run({ kind: 'cargo', task: 'check' });
      expect(checked.exitCode, checked.output).toBe(0);
      expect((await readFile(join(root, 'compiler-versions.txt'), 'utf8')).trim()).toBe(
        shell.output.trim(),
      );
    },
    40_000,
  );

  native(
    'keeps another project out of the persisted dependency cache',
    async () => {
      const seeded = await run({
        kind: 'shell',
        network: 'local',
        command:
          'mkdir -p "$CARGO_HOME/registry" && printf project-one > "$CARGO_HOME/registry/chatsplice-compatibility-marker"',
      });
      expect(seeded.exitCode, seeded.output).toBe(0);
      const secondRoot = join(temporaryDirectory, 'second-workspace');
      await mkdir(secondRoot);
      ownedRoots.push(secondRoot);
      const secondId = (await service.register({ root_path: secondRoot })).workspace_id;
      const second = await run(
        {
          kind: 'shell',
          network: 'local',
          command:
            'test ! -e "$CARGO_HOME/registry/chatsplice-compatibility-marker" && printf isolated',
        },
        secondId,
      );
      expect(second).toEqual({ exitCode: 0, output: 'isolated' });
    },
    40_000,
  );
});
