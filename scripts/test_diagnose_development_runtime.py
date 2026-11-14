#!/usr/bin/env python3
"""Offline regressions for native-process identity and diagnostic failure reporting."""

import contextlib
import ctypes
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "development_runtime", Path(__file__).with_name("diagnose-development-runtime.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def snapshot(**changes):
    values = {"pid": 4242, "uid": os.geteuid(), "ppid": os.getpid(), "pgid": os.getpgrp(),
              "start_seconds": 1234, "start_microseconds": 5678,
              "executable_path": str(Path(sys.executable).resolve())}
    values.update(changes)
    return values


@contextlib.contextmanager
def native_library(records=None, info_count=None, info_errno=None, path_errno=None,
                   path=b"/usr/bin/python3"):
    records = list(records or [snapshot()])

    def info(pid, flavor, argument, pointer, size):
        if info_errno is not None:
            ctypes.set_errno(info_errno)
            return 0
        record = records.pop(0) if len(records) > 1 else records[0]
        target = ctypes.cast(pointer, ctypes.POINTER(runtime.BsdInfo)).contents
        for key, value in record.items():
            if key != "executable_path":
                setattr(target, key, value)
        return size if info_count is None else info_count

    def executable(pid, buffer, size):
        if path_errno is not None:
            ctypes.set_errno(path_errno)
            return 0
        ctypes.memmove(buffer, path + b"\0", len(path) + 1)
        return len(path)

    library = SimpleNamespace(proc_pidinfo=mock.Mock(side_effect=info),
                              proc_pidpath=mock.Mock(side_effect=executable))
    with mock.patch.object(runtime.sys, "platform", "darwin"), \
            mock.patch.object(runtime.ctypes, "CDLL", return_value=library):
        yield library


class NativeIdentityTests(unittest.TestCase):
    def test_native_identity_returns_requested_fields_with_stable_start_time(self):
        with native_library() as library:
            actual = runtime.native_process_snapshot(4242)
        self.assertEqual(actual, snapshot(executable_path="/usr/bin/python3"))
        self.assertEqual(library.proc_pidinfo.call_count, 2)

    def test_native_identity_rejects_partial_abi_and_wrong_identity(self):
        for count in (135, 137):
            with self.subTest(count=count), native_library(info_count=count):
                with self.assertRaisesRegex(RuntimeError, "ABI size"):
                    runtime.native_process_snapshot(4242)
        for changes in ({"pid": 4243}, {"start_seconds": 0},
                        {"start_microseconds": 1_000_000}):
            with self.subTest(changes=changes), native_library(records=[snapshot(**changes)]):
                with self.assertRaises(RuntimeError):
                    runtime.native_process_snapshot(4242)

    def test_native_permission_denial_retains_errno(self):
        for field in ("info_errno", "path_errno"):
            with self.subTest(field=field), native_library(**{field: errno.EPERM}):
                with self.assertRaises(OSError) as raised:
                    runtime.native_process_snapshot(4242)
                self.assertEqual(raised.exception.errno, errno.EPERM)

    def test_native_identity_rejects_pid_reuse_during_path_query(self):
        with native_library(records=[snapshot(), snapshot(start_microseconds=5679)]):
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                runtime.native_process_snapshot(4242)

    def test_native_identity_rejects_non_pid_and_nonabsolute_path(self):
        for value in (0, -1, 0x80000000, True, "4242"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.native_process_snapshot(value)
        with native_library(path=b"relative/python"):
            with self.assertRaisesRegex(RuntimeError, "executable path"):
                runtime.native_process_snapshot(4242)

    def test_reaped_check_does_not_convert_denial_or_same_identity_to_success(self):
        with mock.patch.object(runtime, "native_process_snapshot",
                               side_effect=OSError(errno.ESRCH, "gone")):
            self.assertEqual(runtime._verify_reaped_process(snapshot()), "not_found")
        for denied in (errno.EPERM, errno.EACCES, 0):
            with self.subTest(errno=denied), mock.patch.object(
                    runtime, "native_process_snapshot", side_effect=OSError(denied, "unknown")):
                with self.assertRaises(OSError):
                    runtime._verify_reaped_process(snapshot())
        with mock.patch.object(runtime, "native_process_snapshot", return_value=snapshot()):
            with self.assertRaisesRegex(RuntimeError, "reaped child identity"):
                runtime._verify_reaped_process(snapshot())
        with mock.patch.object(runtime, "native_process_snapshot",
                               return_value=snapshot(start_microseconds=5679)):
            self.assertEqual(runtime._verify_reaped_process(snapshot()), "pid_reused")

    @contextlib.contextmanager
    def child_fixture(self, records):
        child = mock.Mock(pid=4242, returncode=0)
        child.poll.return_value = None
        own = snapshot(pid=os.getpid(), ppid=os.getppid())
        with mock.patch.object(runtime.sys, "platform", "darwin"), \
                mock.patch.object(runtime.subprocess, "Popen", return_value=child) as spawn, \
                mock.patch.object(runtime.select, "select",
                                  return_value=([child.stdout], [], [])), \
                mock.patch.object(runtime.os, "read", return_value=b"ready\n"), \
                mock.patch.object(runtime, "native_process_snapshot", side_effect=[own, *records]):
            yield child, spawn

    def test_owned_child_is_inspected_alive_then_reaped_and_checked_again(self):
        self.assertIn("owned_child_process", runtime.PROBES)
        with self.child_fixture([snapshot(), snapshot(), OSError(errno.ESRCH, "gone")]) \
                as (child, spawn):
            result = runtime.owned_child_process()
        self.assertEqual(result["post_reap"], "not_found")
        self.assertTrue(result["start_identity_stable"])
        child.communicate.assert_called_once_with(timeout=3)
        child.terminate.assert_not_called()
        child.kill.assert_not_called()
        self.assertEqual(spawn.call_args.args[0][:4],
                         [str(Path(sys.executable).resolve()), "-I", "-S", "-u"])

    def test_owned_child_inspection_failure_still_terminates_and_reaps(self):
        denied = PermissionError(errno.EPERM, "proc_pidinfo")
        with self.child_fixture([denied]) as (child, _):
            child.communicate.side_effect = [
                subprocess.TimeoutExpired("owned-child", 3),
                subprocess.TimeoutExpired("owned-child", 2), (b"", b"")]
            with self.assertRaises(PermissionError) as raised:
                runtime.owned_child_process()
        self.assertIs(raised.exception, denied)
        child.terminate.assert_called_once_with()
        child.kill.assert_called_once_with()
        self.assertEqual(child.communicate.call_count, 3)

    def test_owned_child_rejects_wrong_owner_parent_or_executable(self):
        for changes in ({"uid": os.geteuid() + 1}, {"ppid": os.getpid() + 1},
                        {"executable_path": "/different/interpreter"}):
            with self.subTest(changes=changes), self.child_fixture([snapshot(**changes)]) \
                    as (child, _):
                with self.assertRaises(RuntimeError):
                    runtime.owned_child_process()
            child.communicate.assert_called_once_with(timeout=3)


class PsReportingTests(unittest.TestCase):
    metadata = SimpleNamespace(st_mode=stat.S_IFREG | stat.S_ISUID | 0o755)

    def observe_ps(self, outcome, metadata_error=None):
        with mock.patch.object(runtime.os, "stat", return_value=self.metadata,
                               side_effect=metadata_error), \
                mock.patch.object(runtime.subprocess, "run",
                                  side_effect=outcome if isinstance(outcome, Exception) else None,
                                  return_value=outcome):
            return runtime.observe("system_ps", runtime.system_ps, False)

    def test_ps_classifies_failure_stage_without_erasing_errno(self):
        completed = lambda code, text: subprocess.CompletedProcess(["/bin/ps"], code, text, "")
        cases = [
            (PermissionError(errno.EPERM, "Operation not permitted", "/bin/ps"), "spawn",
             errno.EPERM),
            (completed(1, ""), "exit", None),
            (subprocess.TimeoutExpired("/bin/ps", 3), "exit", None),
            (completed(0, "bad record extra"), "parse", None),
            (completed(0, "bad record"), "parse", None),
            (UnicodeDecodeError("utf8", b"\xff", 0, 1, "bad output"), "parse", None),
            (completed(0, "0 0"), "identity", None),
        ]
        for outcome, stage, code in cases:
            with self.subTest(stage=stage, outcome=type(outcome).__name__):
                report = self.observe_ps(outcome)
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report["required"])
                self.assertEqual(report["stage"], stage)
                self.assertEqual(report["errno"], code)
                self.assertEqual(report["detail"]["mode"], "4755")
                self.assertTrue(report["detail"]["setuid"])
                self.assertFalse(report["detail"]["setgid"])

    def test_ps_success_reports_actual_executable_metadata(self):
        report = self.observe_ps(subprocess.CompletedProcess(
            ["/bin/ps"], 0, f"{os.getpid()} {os.geteuid()}\n", ""))
        self.assertEqual(report["state"], "passed")
        self.assertTrue(report["detail"]["own_pid_and_uid"])
        self.assertEqual(report["detail"]["mode"], "4755")

    def test_ps_stat_failure_does_not_replace_spawn_errno(self):
        report = self.observe_ps(PermissionError(errno.EPERM, "spawn"),
                                 PermissionError(errno.EACCES, "stat"))
        self.assertEqual(report["errno"], errno.EPERM)
        self.assertEqual(report["stage"], "spawn")
        self.assertEqual(report["detail"]["metadata_errno"], errno.EACCES)
        self.assertIsNone(report["detail"]["mode"])

    def test_optional_ps_failure_preserves_successful_required_exit(self):
        failed = PermissionError(errno.EPERM, "spawn", "/bin/ps")
        failed.probe_stage = "spawn"
        failed.probe_detail = {"mode": "4755", "setuid": True, "setgid": False}
        output = io.StringIO()
        with mock.patch.dict(runtime.PROBES, {"owned_child_process": lambda: {"reaped": True}},
                             clear=True), \
                mock.patch.object(runtime, "system_ps", side_effect=failed), \
                mock.patch.object(sys, "argv", ["diagnose", "--include-system-ps"]), \
                contextlib.redirect_stdout(output):
            result = runtime.main()
        self.assertEqual(result, 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["required_failed"], 0)
        self.assertEqual(report["checks"][1]["state"], "failed")
        self.assertFalse(report["checks"][1]["required"])

    def test_owned_child_failure_remains_a_required_failure(self):
        def denied():
            raise PermissionError(errno.EPERM, "proc_pidinfo")
        output = io.StringIO()
        with mock.patch.dict(runtime.PROBES, {"owned_child_process": denied}, clear=True), \
                mock.patch.object(sys, "argv", ["diagnose"]), \
                contextlib.redirect_stdout(output):
            result = runtime.main()
        self.assertEqual(result, 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["required_failed"], 1)
        self.assertTrue(report["checks"][0]["required"])


if __name__ == "__main__":
    unittest.main()

