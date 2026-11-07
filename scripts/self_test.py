import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("opencode_bridge.py")
spec = importlib.util.spec_from_file_location("bridge", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
default_root = Path("E:/Claude Agent/wish-dev/runtime") if os.name == "nt" else Path(tempfile.gettempdir()) / "wish-dev"
SCRATCH = Path(os.environ.get("WISH_DEV_RUNTIME_ROOT", str(default_root))) / "self-tests"
SCRATCH.mkdir(parents=True, exist_ok=True)

FAKE = r'''
import json, pathlib, subprocess, sys, time
mode, receipt = sys.argv[1:3]
if mode == "eager":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    pathlib.Path(receipt + ".pid").write_text(str(child.pid))
    time.sleep(120)
prompt = sys.stdin.buffer.read().decode("utf-8")
pathlib.Path(receipt).write_text(json.dumps({"prompt":prompt,"args":sys.argv[3:]},ensure_ascii=False),encoding="utf-8")
if mode == "sleep":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    pathlib.Path(receipt + ".pid").write_text(str(child.pid))
    time.sleep(120)
elif mode == "blank":
    print("not-json")
else:
    print(json.dumps({"type":"text","sessionID":"ses_parent","part":{"type":"text","text":"中文工作结果"}}))
    print("diagnostic", file=sys.stderr)
    if mode == "error":
        print(json.dumps({"type":"error","sessionID":"ses_parent","error":{"name":"ProviderError"}}))
    if mode == "multi":
        print(json.dumps({"type":"step_finish","sessionID":"ses_other"}))
    if mode == "tool":
        print(json.dumps({"type":"tool_use","sessionID":"ses_parent","part":{"type":"tool","state":{"status":"error"}}}))
    if mode == "exit":
        sys.exit(7)
'''

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="中文 空格-", dir=SCRATCH)
        self.root = Path(self.tmp.name)
        self.fake = self.root / "fake cli.py"
        self.fake.write_text(FAKE, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def invoke(self, mode, timeout=10):
        run = self.root / ("run-" + mode)
        run.mkdir()
        receipt = self.root / (mode + ".json")
        args = ['literal & value', 'quote"test', '$() literal', chr(96) + 'literal']
        command = [sys.executable, str(self.fake), mode, str(receipt), *args]
        with contextlib.redirect_stdout(io.StringIO()):
            code = bridge.run_round(command, "ultrawork\n需求：保存后刷新仍能读取。\n", run, timeout)
        state = json.loads((run / "result.json").read_text(encoding="utf-8"))
        return code, state, receipt, args

    def preview(self, runtime=None, explicit=None):
        prompt = self.root / "任务.md"
        prompt.write_text("只做预演", encoding="utf-8")
        command = [sys.executable, "-B", str(SCRIPT), "--project", str(self.root),
                   "--prompt-file", str(prompt), "--executable", sys.executable, "--dry-run"]
        env = os.environ.copy()
        env.pop("WISH_DEV_RUNTIME_ROOT", None)
        if runtime is not None:
            env["WISH_DEV_RUNTIME_ROOT"] = str(runtime)
        if explicit is not None:
            command.extend(["--runtime-root", str(explicit)])
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout)
        return json.loads(result.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows default")
    def test_windows_preview_default_stays_in_authorized_e_drive(self):
        state = self.preview()
        self.assertEqual(Path(state["runtime_root"]), Path("E:/Claude Agent/wish-dev/runtime").resolve())
        self.assertFalse(state["model_called"])

    def test_explicit_runtime_overrides_environment_without_creating_it(self):
        explicit = self.root / "chosen-runtime"
        state = self.preview(self.root / "env-runtime", explicit)
        self.assertEqual(Path(state["runtime_root"]), explicit.resolve())
        self.assertFalse(explicit.exists())

    def test_environment_runtime_overrides_default(self):
        runtime = self.root / "environment-runtime"
        state = self.preview(runtime)
        self.assertEqual(Path(state["runtime_root"]), runtime.resolve())
        self.assertFalse(runtime.exists())

    def test_utf8_stdin_args_logs_session_and_no_delivery_claim(self):
        code, state, receipt, args = self.invoke("success")
        self.assertEqual(code, 0)
        data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertIn("保存后刷新", data["prompt"])
        self.assertEqual(data["args"], args)
        self.assertEqual(state["session_id"], "ses_parent")
        self.assertFalse(state["delivery_verified"])
        self.assertIn("中文工作结果", Path(state["text_path"]).read_text(encoding="utf-8"))
        self.assertIn("diagnostic", Path(state["stderr_path"]).read_text())

    def test_error_event_overrides_zero_exit(self):
        code, state, _, _ = self.invoke("error")
        self.assertEqual(code, 2)
        self.assertEqual(state["returncode"], 0)
        self.assertEqual(state["error_events"], 1)

    def test_nonzero_process_exit(self):
        code, state, _, _ = self.invoke("exit")
        self.assertEqual(code, 2)
        self.assertEqual(state["returncode"], 7)

    def test_non_json_output_is_unverified(self):
        code, state, _, _ = self.invoke("blank")
        self.assertEqual(code, 2)
        self.assertEqual(state["status"], "unverified_output")

    def test_multiple_sessions_are_not_guessed(self):
        code, state, _, _ = self.invoke("multi")
        self.assertEqual(code, 0)
        self.assertIsNone(state["session_id"])

    def test_tool_failure_retained_for_host_review(self):
        code, state, _, _ = self.invoke("tool")
        self.assertEqual(code, 0)
        self.assertEqual(state["tool_errors"], 1)
        self.assertFalse(state["delivery_verified"])

    def test_timeout_stops_owned_process_tree(self):
        code, state, receipt, _ = self.invoke("sleep", timeout=2)
        self.assertEqual(code, 124)
        self.assertEqual(state["status"], "timed_out")
        child_pid = int(Path(str(receipt) + ".pid").read_text())
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            api = ctypes.WinDLL("kernel32", use_last_error=True)
            api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            api.OpenProcess.restype = wintypes.HANDLE
            api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            api.WaitForSingleObject.restype = wintypes.DWORD
            api.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = api.OpenProcess(0x100000, False, child_pid)
            if handle:
                try:
                    self.assertEqual(api.WaitForSingleObject(handle, 1000), 0)
                finally:
                    api.CloseHandle(handle)
            else:
                self.assertEqual(ctypes.get_last_error(), 87)

    @unittest.skipUnless(os.name == "nt", "Windows job startup")
    def test_child_cannot_spawn_before_job_assignment(self):
        import ctypes
        import time
        from ctypes import wintypes
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.WaitForSingleObject.restype = wintypes.DWORD
        api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        original = bridge.WindowsJob.assign
        premature = []
        escaped_handle = None
        child_pid_file = self.root / "eager.json.pid"

        def delayed_assign(job, process):
            nonlocal escaped_handle
            time.sleep(0.7)
            premature.append(child_pid_file.exists())
            if child_pid_file.exists():
                # Hold the exact test descendant handle before timeout, to clean RED safely.
                escaped_handle = api.OpenProcess(0x100001, False, int(child_pid_file.read_text()))
            original(job, process)

        try:
            with mock.patch.object(bridge.WindowsJob, "assign", delayed_assign):
                code, state, _, _ = self.invoke("eager", timeout=2)
            self.assertEqual(code, 124)
            self.assertEqual(state["status"], "timed_out")
            self.assertEqual(premature, [False], "CLI ran before its process job owned it")
            self.assertTrue(child_pid_file.exists(), "eager child must actually run after resume")
            handle = api.OpenProcess(0x100000, False, int(child_pid_file.read_text()))
            if handle:
                try:
                    self.assertEqual(api.WaitForSingleObject(handle, 1000), 0)
                finally:
                    api.CloseHandle(handle)
            else:
                self.assertEqual(ctypes.get_last_error(), 87)
        finally:
            if escaped_handle:
                if api.WaitForSingleObject(escaped_handle, 0) == 258:
                    api.TerminateProcess(escaped_handle, 1)
                    api.WaitForSingleObject(escaped_handle, 1000)
                api.CloseHandle(escaped_handle)


    def test_launch_failure_is_recorded(self):
        run = self.root / "launch-fail"
        run.mkdir()
        with contextlib.redirect_stdout(io.StringIO()):
            code = bridge.run_round([str(self.root / "absent.exe")], "task", run, 3)
        state = json.loads((run / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 2)
        self.assertEqual(state["status"], "launch_error")

if __name__ == "__main__":
    unittest.main(verbosity=2)
