#!/usr/bin/env python3
"""Exercise the current command sandbox using only disposable local fixtures.

Run this through the same project.exec shell path as the failing application.
The report describes observations, not permission grants. Required failures exit
nonzero; --include-system-ps reports the optional privileged executable separately.
"""

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def loopback_http():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.settimeout(2)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=2) as client:
            peer, _ = listener.accept()
            with peer:
                peer.settimeout(2)
                client.sendall(b"HEAD /health HTTP/1.0\r\n\r\n")
                received = b""
                while b"\r\n\r\n" not in received:
                    chunk = peer.recv(256)
                    require(bool(chunk), "HTTP request ended before its headers")
                    received += chunk
                    require(len(received) <= 1024, "HTTP request exceeded the fixture limit")
                require(received.startswith(b"HEAD /health HTTP/1.0"), "wrong HTTP request")
                peer.sendall(b"HTTP/1.0 204 No Content\r\nContent-Length: 0\r\n\r\n")
            reply = b""
            while True:
                chunk = client.recv(256)
                if not chunk:
                    break
                reply += chunk
                require(len(reply) <= 1024, "HTTP response exceeded the fixture limit")
            require(reply.startswith(b"HTTP/1.0 204 No Content\r\n"), "wrong HTTP response")
    return {"bind": "127.0.0.1:0", "http_status": 204, "request_and_response": True}


def pty_io():
    master, slave = os.openpty()
    try:
        require(os.isatty(master) and os.isatty(slave), "openpty did not return two terminals")
        os.write(slave, b"chatsplice-pty\n")
        require(bool(select.select([master], [], [], 2)[0]), "PTY read timed out")
        require(b"chatsplice-pty" in os.read(master, 128), "PTY output did not match")
    finally:
        os.close(master)
        os.close(slave)
    return {"allocated": True, "read_write": True}


def descriptor_at(parent):
    with tempfile.TemporaryDirectory(prefix="chatsplice-descriptor-", dir=parent) as directory:
        target = Path(directory).resolve() / "input.txt"
        target.write_bytes(b"descriptor-fixture")
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in target.parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            leaf = os.open(target.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                require(os.read(leaf, 64) == b"descriptor-fixture", "wrong descriptor contents")
            finally:
                os.close(leaf)
        finally:
            os.close(fd)


def descriptor_walk():
    descriptor_at(None)
    descriptor_at(os.getcwd())
    return {"root_to_temp_openat": True, "root_to_workspace_openat": True, "nofollow": True}


def symlink_fixture():
    with tempfile.TemporaryDirectory(prefix="chatsplice-symlink-") as directory:
        source = Path(directory) / "input.txt"
        alias = Path(directory) / "alias.txt"
        source.write_bytes(b"symlink-fixture")
        os.symlink(source.name, alias)
        require(alias.read_bytes() == b"symlink-fixture", "relative symlink read did not match")
        try:
            fd = os.open(alias, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as error:
            require(error.errno == errno.ELOOP, "O_NOFOLLOW failed for an unexpected reason")
        else:
            os.close(fd)
            raise RuntimeError("O_NOFOLLOW unexpectedly followed a symlink")
    return {"relative_symlink": True, "nofollow_rejects_symlink": True}


def hardlink_fixture():
    with tempfile.TemporaryDirectory(prefix="chatsplice-hardlink-") as directory:
        source = Path(directory) / "input.txt"
        alias = Path(directory) / "alias.txt"
        source.write_bytes(b"hardlink-fixture")
        os.link(source, alias)
        first, second = source.stat(), alias.stat()
        require((first.st_dev, first.st_ino) == (second.st_dev, second.st_ino), "different inodes")
        require(first.st_nlink == 2 and second.st_nlink == 2, "unexpected fixture link count")
        alias.write_bytes(b"updated-fixture")
        require(source.read_bytes() == b"updated-fixture", "hardlink write did not reach source")
    return {"private_temp_hardlink": True, "same_inode": True, "read_write": True}


# Public Darwin proc_bsdinfo ABI. This inspects a requested PID, not a process list.
# https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
class BsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32),
        ("exit_status", ctypes.c_uint32), ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32), ("reserved", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
        ("job_count", ctypes.c_uint32), ("tty", ctypes.c_uint32),
        ("tty_group", ctypes.c_uint32), ("nice", ctypes.c_int32),
        ("start_seconds", ctypes.c_uint64), ("start_microseconds", ctypes.c_uint64),
    ]


def native_process_snapshot(pid):
    """Return native identity for one PID, or fail without a ps fallback."""
    if type(pid) is not int or not 0 < pid <= 0x7fffffff:
        raise ValueError("a positive pid_t is required")
    if sys.platform != "darwin":
        raise OSError(errno.ENOTSUP, "this libproc check requires macOS")
    require(ctypes.sizeof(BsdInfo) == 136 and BsdInfo.start_seconds.offset == 120,
            "unsupported proc_bsdinfo ABI layout")
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    lib.proc_pidpath.restype = ctypes.c_int

    def read_identity():
        info = BsdInfo()
        ctypes.set_errno(0)
        count = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if count <= 0:
            raise OSError(ctypes.get_errno(), "proc_pidinfo")
        require(count == ctypes.sizeof(info), "proc_pidinfo returned an unexpected ABI size")
        require(info.pid == pid, "proc_pidinfo returned a different PID")
        require(info.start_seconds > 0 and info.start_microseconds < 1_000_000,
                "proc_pidinfo returned an invalid process start time")
        return {key: getattr(info, key) for key in
                ("pid", "uid", "ppid", "pgid", "start_seconds", "start_microseconds")}

    before = read_identity()
    path = ctypes.create_string_buffer(4096)
    ctypes.set_errno(0)
    count = lib.proc_pidpath(pid, path, len(path))
    if count <= 0:
        raise OSError(ctypes.get_errno(), "proc_pidpath")
    require(count <= len(path), "proc_pidpath returned an invalid buffer size")
    raw_path, terminator, _ = path.raw.partition(b"\0")
    require(bool(terminator) and raw_path.startswith(b"/"),
            "proc_pidpath returned an invalid executable path")
    after = read_identity()
    require(before == after, "process identity changed during native inspection")
    return {**before, "executable_path": os.fsdecode(raw_path)}


def own_process():
    snapshot = native_process_snapshot(os.getpid())
    require(snapshot["uid"] == os.geteuid(), "native UID did not match the owned process")
    require(snapshot["ppid"] == os.getppid(), "native parent PID did not match")
    require(snapshot["pgid"] == os.getpgrp(), "native process group did not match")
    return {"pid_matches": True, "uid_matches": True, "parent_matches": True,
            "process_group_matches": True, "start_time_available": True,
            "executable_path_available": True}


def _process_fingerprint(snapshot):
    return tuple(snapshot[key] for key in ("pid", "start_seconds", "start_microseconds"))


def _verify_reaped_process(snapshot):
    try:
        current = native_process_snapshot(snapshot["pid"])
    except OSError as error:
        # Access denial is not evidence that a process is gone.
        if error.errno != errno.ESRCH:
            raise
        return "not_found"
    require(_process_fingerprint(current) != _process_fingerprint(snapshot),
            "native inspection still found the reaped child identity")
    return "pid_reused"


def owned_child_process():
    if sys.platform != "darwin":
        raise OSError(errno.ENOTSUP, "this libproc check requires macOS")
    # Framework Python may expose a launcher in sys.executable; use this process's
    # actual interpreter image so the child's executable identity can be checked.
    interpreter = native_process_snapshot(os.getpid())["executable_path"]
    require(not os.stat(interpreter).st_mode & (stat.S_ISUID | stat.S_ISGID),
            "the owned-child fixture requires an ordinary interpreter")
    child = subprocess.Popen(
        [interpreter, "-I", "-S", "-u", "-c",
         "import os; os.write(1, b'ready\\n'); os.read(0, 1)"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    try:
        require(bool(select.select([child.stdout], [], [], 3)[0]),
                "owned interpreter readiness timed out")
        require(os.read(child.stdout.fileno(), 6) == b"ready\n",
                "owned interpreter did not announce readiness")
        require(child.poll() is None, "owned interpreter exited before inspection")
        first = native_process_snapshot(child.pid)
        require(first["uid"] == os.geteuid(), "child UID did not match its owner")
        require(first["ppid"] == os.getpid(), "child parent did not match its owner")
        require(first["pgid"] == os.getpgrp(), "child process group did not match")
        require(first["executable_path"] == interpreter, "child executable did not match")
        require(native_process_snapshot(child.pid) == first,
                "owned child identity changed between inspections")
        require(child.poll() is None, "owned interpreter exited during inspection")
    finally:
        # EOF normally ends this fixture. Always reap it, including failed checks.
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=2)
    require(child.returncode == 0, "owned interpreter did not exit normally")
    post_reap = _verify_reaped_process(first)
    return {"uid_matches": True, "parent_matches": True, "process_group_matches": True,
            "start_identity_stable": True, "executable_matches": True,
            "reaped": True, "post_reap": post_reap}


def system_ps():
    detail = {"executable": "/bin/ps", "mode": None, "setuid": None, "setgid": None}
    try:
        metadata = os.stat("/bin/ps")
        detail.update(mode=format(stat.S_IMODE(metadata.st_mode), "04o"),
                      setuid=bool(metadata.st_mode & stat.S_ISUID),
                      setgid=bool(metadata.st_mode & stat.S_ISGID))
    except OSError as error:
        detail["metadata_errno"] = error.errno
    stage = "spawn"
    try:
        result = subprocess.run(["/bin/ps", "-p", str(os.getpid()), "-o", "pid=,uid="],
                                capture_output=True, text=True, timeout=3, check=False)
        stage = "exit"
        detail["exit_code"] = result.returncode
        require(result.returncode == 0, "ps returned exit code " + str(result.returncode))
        stage = "parse"
        fields = result.stdout.split()
        require(len(fields) == 2, "ps returned an unexpected own-process record")
        pid, uid = map(int, fields)
        stage = "identity"
        require(pid == os.getpid() and uid == os.geteuid(), "ps returned a different process")
        return {**detail, "own_pid_and_uid": True}
    except Exception as error:
        if isinstance(error, subprocess.TimeoutExpired):
            stage = "exit"
        elif isinstance(error, UnicodeError):
            stage = "parse"
        # Keep the original exception type, filename and errno from spawn.
        error.probe_stage = stage
        error.probe_detail = detail
        raise


PROBES = {
    "loopback_http": loopback_http,
    "pty_io": pty_io,
    "descriptor_walk": descriptor_walk,
    "symlink_fixture": symlink_fixture,
    "hardlink_fixture": hardlink_fixture,
    "own_process": own_process,
    "owned_child_process": owned_child_process,
}


def observe(name, probe, required):
    try:
        return {"check": name, "required": required, "state": "passed", "detail": probe()}
    except Exception as error:
        report = {"check": name, "required": required, "state": "failed",
                  "error_type": type(error).__name__, "errno": getattr(error, "errno", None),
                  "component": str(getattr(error, "filename", None) or "")[:256],
                  "message": str(error)[:512]}
        if hasattr(error, "probe_stage"):
            report.update(stage=error.probe_stage, detail=error.probe_detail)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checks", nargs="+", choices=tuple(PROBES), default=list(PROBES))
    parser.add_argument("--include-system-ps", action="store_true")
    arguments = parser.parse_args()
    checks = [observe(name, PROBES[name], True) for name in dict.fromkeys(arguments.checks)]
    if arguments.include_system_ps:
        checks.append(observe("system_ps", system_ps, False))
    failed = sum(check["required"] and check["state"] == "failed" for check in checks)
    report = {"format": "chatsplice.development-capabilities.v1", "platform": sys.platform,
              "python_version": sys.version.split()[0], "checks": checks,
              "required_failed": failed}
    print(json.dumps(report, ensure_ascii=True), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
