import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { ProjectExecInputSchema, type ProjectExecOperation } from '@chatsplice/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSettingsRepository } from '../settings/sqlite-repository.js';
import { WorkspaceReferenceService } from '../workspace/reference-service.js';
import { WorkspaceService } from '../workspace/service.js';
import { SqliteWorkspaceRepository } from '../workspace/sqlite-repository.js';
import { executeProjectOperation } from './pi-execution.js';
import { nodeRuntimeVersionSupported, prepareCargoHome } from './pi-trusted.js';

interface CapabilityReport {
  readonly checks: readonly {
    readonly check: string;
    readonly required: boolean;
    readonly state: 'passed' | 'failed';
  }[];
  readonly required_failed: number;
}

const diagnostic = await readFile(
  new URL('../../../../scripts/diagnose-development-runtime.py', import.meta.url),
  'utf8',
);

// Prefer the installed Python on the daemon PATH, including uv/Homebrew/Pyenv.
// If only Apple's command-line Python exists, this exercises that installation.
// Absence is an explicit skip; a present but unusable runtime is a test failure.
const installedPython = [
  ...(process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((path) => join(path, 'python3')),
  '/usr/bin/python3',
].find(existsSync);

/** Run from an ordinary macOS terminal. Nested sandbox refusal is a failure, not a skip. */
describe('native development capabilities in the Pi sandbox', () => {
  let directory: string;
  let root: string;
  let readOnlyRoot: string;
  let outsideRoot: string;
  let cargoHome: string;
  let repository: SqliteWorkspaceRepository;
  let settings: SqliteSettingsRepository;
  let workspaces: WorkspaceService;
  let references: WorkspaceReferenceService;
  let workspaceId: string;
  let requestNumber: number;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'cs-d-')));
    root = join(directory, 'workspace');
    readOnlyRoot = join(directory, 'read-only');
    outsideRoot = join(directory, 'unapproved');
    await Promise.all([root, readOnlyRoot, outsideRoot].map((path) => mkdir(path)));
    repository = new SqliteWorkspaceRepository(join(directory, 'state.sqlite'));
    settings = new SqliteSettingsRepository(join(directory, 'state.sqlite'));
    workspaces = new WorkspaceService(repository);
    references = new WorkspaceReferenceService(workspaces, settings);
    workspaceId = (await workspaces.register({ root_path: root })).workspace_id;
    const readOnlyId = (await workspaces.register({ root_path: readOnlyRoot }, 'reference'))
      .workspace_id;
    references.add({ source_workspace_id: workspaceId, reference_workspace_id: readOnlyId });
    cargoHome = await prepareCargoHome(root);
    requestNumber = 0;
  });

  afterEach(async () => {
    settings.close();
    repository.close();
    await rm(cargoHome, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });

  const native = it.skipIf(process.platform !== 'darwin' || !nodeRuntimeVersionSupported());

  function input(operation: ProjectExecOperation) {
    requestNumber += 1;
    return ProjectExecInputSchema.parse({
      workspace_id: workspaceId,
      workspace_binding: `wb_${'a'.repeat(64)}`,
      request_id: `development-capability-${requestNumber}`,
      operation,
      timeout_ms: 30_000,
    });
  }

  async function run(operation: ProjectExecOperation) {
    let output = '';
    let command = '';
    const result = await executeProjectOperation(workspaces, input(operation), {
      referenceService: references,
      onOutput: (chunk) => {
        output += chunk;
      },
      onStart: (started) => {
        command = started.command;
      },
    });
    return { ...result, output, command };
  }

  it.skipIf(
    process.platform !== 'darwin' ||
      !nodeRuntimeVersionSupported() ||
      installedPython === undefined,
  )(
    'loads an installed Python runtime from a structured Node check (requires Python 3)',
    async () => {
      if (installedPython === undefined) throw new Error('Python disappeared before the test.');
      await mkdir(join(root, '.venv', 'bin'), { recursive: true });
      // Match a project virtual environment pointing to an installed interpreter;
      // the child must also be permitted to load that interpreter's libraries.
      await symlink(await realpath(installedPython), join(root, '.venv', 'bin', 'python3'));
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'node-python-runtime-fixture',
          private: true,
          packageManager: 'npm@10.0.0',
          scripts: { check: 'node python-child.cjs' },
        }),
      );
      await writeFile(
        join(root, 'python-child.cjs'),
        `const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const child = spawnSync('python3', [
  '-c', 'import json, sys; print(json.dumps({"version": sys.version}))'
], { encoding: 'utf8', timeout: 10000 });
if (child.error) throw child.error;
assert.equal(child.status, 0, child.stderr);
const report = JSON.parse(child.stdout);
assert.match(report.version, /^3\\.\\d+\\.\\d+/);
console.log('NODE_PYTHON_CHILD_OK ' + report.version);
`,
      );
      const result = await run({ kind: 'node_script', script: 'check' });
      expect(result.command).toBe('npm run check');
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toMatch(/NODE_PYTHON_CHILD_OK 3\.\d+\.\d+/u);
    },
    40_000,
  );

  native(
    'allows Git repository inspection but denies Git writes and hook reads in a structured Node check',
    async () => {
      // Initialize only this disposable fixture. No commit or user Git state is changed.
      const initialized = spawnSync(
        'git',
        ['-c', 'init.defaultBranch=main', 'init', '--quiet', '--template=', root],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(initialized.error).toBeUndefined();
      expect(initialized.status, initialized.stderr).toBe(0);
      const head = await readFile(join(root, '.git', 'HEAD'), 'utf8');
      expect(head).toBe('ref: refs/heads/main\n');
      await mkdir(join(root, '.git', 'hooks'), { recursive: true });
      await writeFile(join(root, '.git', 'hooks', 'fixture-hook'), 'private-hook-fixture');
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'node-git-inspection-fixture',
          private: true,
          packageManager: 'npm@10.0.0',
          scripts: { check: 'node git-inspection.cjs' },
        }),
      );
      await writeFile(
        join(root, 'git-inspection.cjs'),
        `const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
assert.equal(fs.readFileSync('.git/HEAD', 'utf8'), ${JSON.stringify(head)});
const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8', timeout: 10000
});
if (git.error) throw git.error;
assert.equal(git.status, 0, git.stderr);
assert.equal(fs.realpathSync(git.stdout.trim()), fs.realpathSync(process.cwd()));
for (const action of [
  () => fs.writeFileSync('.git/HEAD', 'forbidden-change'),
  () => fs.writeFileSync('.git/forbidden-write', 'forbidden-new-file'),
  () => fs.readFileSync('.git/hooks/fixture-hook', 'utf8'),
]) {
  assert.throws(action, (error) => ['EPERM', 'EACCES'].includes(error.code));
}
console.log('NODE_GIT_METADATA_OK');
`,
      );
      const result = await run({ kind: 'node_script', script: 'check' });
      expect(result.command).toBe('npm run check');
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toContain('NODE_GIT_METADATA_OK');
      expect(await readFile(join(root, '.git', 'HEAD'), 'utf8')).toBe(head);
      expect(await readFile(join(root, '.git', 'hooks', 'fixture-hook'), 'utf8')).toBe(
        'private-hook-fixture',
      );
      await expect(readFile(join(root, '.git', 'forbidden-write'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    40_000,
  );

  for (const check of [
    'loopback_http',
    'pty_io',
    'descriptor_walk',
    'symlink_fixture',
    'hardlink_fixture',
    'own_process',
    'owned_child_process',
  ]) {
    native(`exercises Python ${check} through the actual command sandbox`, async () => {
      const result = await run({
        kind: 'shell',
        command: `python3 - --checks ${check}`,
        stdin: diagnostic,
        network: 'local',
      });
      expect(result.exit_code, result.output).toBe(0);
      const report = JSON.parse(result.output) as CapabilityReport;
      expect(report.required_failed).toBe(0);
      expect(report.checks).toEqual([
        expect.objectContaining({ check, required: true, state: 'passed' }),
      ]);
    });
  }

  native(
    'exercises localhost HTTP, PTY and private hardlinks from a dedicated offline Cargo test',
    async () => {
      await mkdir(join(root, 'src'));
      await writeFile(
        join(root, 'Cargo.toml'),
        '[package]\nname = "development_capability_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      await writeFile(
        join(root, 'src', 'lib.rs'),
        `
#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream, ToSocketAddrs};
    use std::time::{Duration, Instant};

    #[repr(C)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }

    unsafe extern "C" {
        fn openpty(
            master: *mut i32,
            slave: *mut i32,
            name: *mut std::ffi::c_char,
            termios: *const std::ffi::c_void,
            winsize: *const std::ffi::c_void,
        ) -> i32;
        fn poll(descriptors: *mut PollFd, count: u32, timeout_ms: i32) -> i32;
    }

    #[test]
    fn pty_allocation_and_io() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let mut master_fd = -1;
        let mut slave_fd = -1;
        let result = unsafe {
            openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        let error = std::io::Error::last_os_error();
        // Own any returned descriptors before checking the status so a failed
        // assertion closes them as well.
        let master = (master_fd >= 0).then(|| unsafe { std::fs::File::from_raw_fd(master_fd) });
        let slave = (slave_fd >= 0).then(|| unsafe { std::fs::File::from_raw_fd(slave_fd) });
        assert_eq!(result, 0, "openpty failed: {error}");
        let mut master = master.expect("openpty returned no master");
        let mut slave = slave.expect("openpty returned no slave");
        let marker = b"cargo-pty-fixture";
        slave.write_all(marker).unwrap();
        slave.write_all(b"\\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut received = Vec::new();
        while !received.windows(marker.len()).any(|part| part == marker) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "PTY read timed out");
            let mut descriptor = PollFd { fd: master.as_raw_fd(), events: 1, revents: 0 };
            let ready = unsafe {
                poll(&mut descriptor, 1, remaining.as_millis().max(1).min(2_000) as i32)
            };
            assert!(ready > 0, "PTY poll failed or timed out: {}", std::io::Error::last_os_error());
            assert_ne!(descriptor.revents & 1, 0, "PTY did not become readable");
            let mut buffer = [0_u8; 128];
            let count = master.read(&mut buffer).unwrap();
            assert!(count > 0, "PTY closed before producing output");
            received.extend_from_slice(&buffer[..count]);
            assert!(received.len() <= 256, "PTY fixture output exceeded its limit");
        }
    }

    struct OwnedDirectory(std::path::PathBuf);
    impl Drop for OwnedDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn private_runtime_hardlink_fixture() {
        use std::os::unix::fs::MetadataExt;
        let path = std::env::temp_dir()
            .join(format!("chatsplice-cargo-links-{}", std::process::id()));
        // create_dir refuses a pre-existing path; this test owns only the new directory.
        std::fs::create_dir(&path).unwrap();
        let directory = OwnedDirectory(path);
        let source = directory.0.join("input.txt");
        let alias = directory.0.join("alias.txt");
        std::fs::write(&source, b"cargo-link-fixture").unwrap();
        std::fs::hard_link(&source, &alias).expect("create private-runtime hardlink fixture");
        let first = std::fs::metadata(&source).unwrap();
        let second = std::fs::metadata(&alias).unwrap();
        assert_eq!((first.dev(), first.ino()), (second.dev(), second.ino()));
        assert_eq!(first.nlink(), 2);
        assert_eq!(second.nlink(), 2);
        std::fs::write(&alias, b"updated-link-fixture").unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), b"updated-link-fixture");
        std::fs::remove_dir_all(&directory.0).unwrap();
    }


    #[test]
    fn offline_dependencies_with_loopback_http() {
        assert_eq!(std::env::var("CARGO_NET_OFFLINE").unwrap(), "true");
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback test listener");
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let resolved: Vec<_> = ("localhost", address.port())
            .to_socket_addrs()
            .expect("resolve localhost in the dedicated Cargo sandbox")
            .collect();
        assert!(resolved.iter().all(|candidate| candidate.ip().is_loopback()),
            "localhost returned a non-loopback address: {resolved:?}");
        let client_address = resolved.iter().copied()
            .find(|candidate| *candidate == address)
            .unwrap_or_else(|| panic!("localhost did not resolve {address}: {resolved:?}"));
        let timeout = Duration::from_secs(2);
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect_timeout(&client_address, timeout).unwrap();
            stream.set_read_timeout(Some(timeout)).unwrap();
            stream.set_write_timeout(Some(timeout)).unwrap();
            let request = format!(
                "HEAD /health HTTP/1.0\\r\\nHost: localhost:{}\\r\\n\\r\\n", address.port());
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.take(1024).read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.0 204 No Content\\r\\n"), "{response}");
        });
        let deadline = Instant::now() + timeout;
        let mut peer = loop {
            match listener.accept() {
                Ok((peer, _)) => break peer,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "HTTP accept timed out");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("HTTP accept failed: {error}"),
            }
        };
        peer.set_read_timeout(Some(timeout)).unwrap();
        peer.set_write_timeout(Some(timeout)).unwrap();
        {
            let mut reader = BufReader::new(&mut peer);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, "HEAD /health HTTP/1.0\\r\\n");
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, format!("Host: localhost:{}\\r\\n", address.port()));
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, "\\r\\n");
        }
        peer.write_all(b"HTTP/1.0 204 No Content\\r\\nContent-Length: 0\\r\\n\\r\\n").unwrap();
        drop(peer);
        client.join().unwrap();
    }
}
`,
      );
      const result = await run({ kind: 'cargo', task: 'test' });
      expect(result.command).toContain('cargo test --offline');
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toContain('test result: ok. 3 passed');
    },
    40_000,
  );

  native(
    'serves Python HTTP in a background job and closes its listener after cancellation',
    async () => {
      const abort = new AbortController();
      let output = '';
      let ready!: (port: number) => void;
      const announcedPort = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const running = executeProjectOperation(
        workspaces,
        input({
          kind: 'shell',
          command: 'python3 -u -',
          network: 'local',
          background: true,
          stdin: `
import http.server, json
class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
with http.server.HTTPServer(("127.0.0.1", 0), Handler) as server:
    print(json.dumps({"port": server.server_port}), flush=True)
    server.serve_forever(poll_interval=0.05)
`,
        }),
        {
          referenceService: references,
          signal: abort.signal,
          onOutput: (chunk) => {
            output += chunk;
            const line = output.split('\n').find((value) => /^\{"port": \d+\}$/u.test(value));
            if (line !== undefined) ready((JSON.parse(line) as { port: number }).port);
          },
        },
      );
      let timer: NodeJS.Timeout | undefined;
      try {
        const port = await Promise.race([
          announcedPort,
          running.then((result) => {
            throw new Error(`Python exited before readiness: ${result.exit_code}\n${output}`);
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Python startup timed out\n${output}`)),
              20_000,
            );
          }),
        ]);
        const url = `http://127.0.0.1:${port}/health`;
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2_000) });
        expect(response.status).toBe(204);
        abort.abort();
        expect((await running).exit_code).toBeNull();
        await expect(
          fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2_000) }),
        ).rejects.toThrow();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        abort.abort();
        await running.catch(() => undefined);
      }
    },
    40_000,
  );

  native('supports scoped Unix socket IPC while denying an unapproved socket', async () => {
    const outsideSocket = join(outsideRoot, 's');
    expect(Buffer.byteLength(outsideSocket)).toBeLessThan(104);
    const outside = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      outside.once('error', reject);
      outside.listen(outsideSocket, resolve);
    });
    try {
      const result = await run({
        kind: 'shell',
        command: 'python3 -',
        network: 'local',
        stdin: `
import errno, os, socket, tempfile
original = os.getcwd()
for base in [original, tempfile.gettempdir()]:
    with tempfile.TemporaryDirectory(dir=base, prefix="ipc-") as directory:
        os.chdir(directory)
        try:
            with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
                server.settimeout(2)
                client.settimeout(2)
                server.bind("s")
                server.listen(1)
                client.connect("s")
                with server.accept()[0] as peer:
                    peer.settimeout(2)
                    client.sendall(b"scoped-ipc")
                    assert peer.recv(32) == b"scoped-ipc"
        finally:
            os.chdir(original)
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(2)
    try:
        client.connect(${JSON.stringify(outsideSocket)})
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), error
    else:
        raise AssertionError("unapproved host socket was reachable")
print("SCOPED_UNIX_IPC_OK")
`,
      });
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toContain('SCOPED_UNIX_IPC_OK');
    } finally {
      await new Promise<void>((resolve, reject) => {
        outside.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  native('does not convert runtime fixture access into external or read-only writes', async () => {
    const sources = [
      join(root, '.env'),
      join(readOnlyRoot, 'input.txt'),
      join(outsideRoot, 'input.txt'),
    ];
    for (const source of sources) await writeFile(source, 'fixture-only');
    const result = await run({
      kind: 'shell',
      command: 'python3 -',
      network: 'local',
      stdin: `
import errno, json, os, pathlib, tempfile
def denied(action):
    try:
        action()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES), error
    else:
        raise AssertionError("operation unexpectedly escaped its permitted scope")
with tempfile.TemporaryDirectory() as directory:
    owned = pathlib.Path(directory, "owned.txt")
    owned.write_text("private fixture")
    for index, source in enumerate(json.loads(${JSON.stringify(JSON.stringify(sources))})):
        denied(lambda: os.link(source, os.path.join(directory, "alias-" + str(index))))
    os.symlink(json.loads(${JSON.stringify(JSON.stringify(join(outsideRoot, 'input.txt')))}), os.path.join(directory, "outside-source-link"))
    dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        denied(lambda: os.link("outside-source-link", "followed-alias", src_dir_fd=dir_fd,
                               dst_dir_fd=dir_fd, follow_symlinks=True))
    finally:
        os.close(dir_fd)
    for root in json.loads(${JSON.stringify(JSON.stringify([readOnlyRoot, outsideRoot]))}):
        denied(lambda: pathlib.Path(root, "denied-write.txt").write_text("wrong"))
        denied(lambda: os.link(owned, os.path.join(root, "denied-link.txt")))
print("CAPABILITY_SCOPE_OK")
`,
    });
    expect(result.exit_code, result.output).toBe(0);
    expect(result.output).toContain('CAPABILITY_SCOPE_OK');
    for (const source of sources) expect(await readFile(source, 'utf8')).toBe('fixture-only');
    for (const path of [readOnlyRoot, outsideRoot]) {
      await expect(readFile(join(path, 'denied-write.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(path, 'denied-link.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });
});
