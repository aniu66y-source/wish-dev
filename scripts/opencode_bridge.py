#!/usr/bin/env python3
"""One observable OpenCode round. No installer, shell interpolation or auto-approval."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
import uuid


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def resolve_executable(explicit=None):
    if explicit:
        candidate = Path(explicit).expanduser().resolve()
        if not candidate.is_file():
            raise ValueError("Explicit OpenCode executable does not exist")
        if os.name == "nt" and candidate.suffix.lower() != ".exe":
            raise ValueError("On Windows supply a native .exe, not a .cmd/.ps1 shim")
        return str(candidate)
    if os.name != "nt":
        found = shutil.which("opencode")
        if found:
            return found
    else:
        found = shutil.which("opencode.exe")
        if found:
            return found
        # npm shims are not native executables. Resolve the observed npm layout.
        for name in ("opencode", "opencode.cmd", "opencode.ps1"):
            shim = shutil.which(name)
            if shim:
                native = Path(shim).parent / "node_modules/opencode-ai/bin/opencode.exe"
                if native.is_file():
                    return str(native)
    raise ValueError("OpenCode native executable not found; pass --executable explicitly")


def probe(executable):
    outputs = []
    for args in ([executable, "--version"], [executable, "run", "--help"]):
        result = subprocess.run(args, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=30)
        if result.returncode != 0:
            raise ValueError("OpenCode version/help probe failed; inspect executable locally")
        outputs.append(result.stdout + "\n" + result.stderr)
    missing = [flag for flag in ("--format", "--dir", "--session")
               if flag not in outputs[1]]
    if missing:
        raise ValueError("Required run flags unavailable: " + ", ".join(missing))
    return {"executable": executable, "version": outputs[0].strip(),
            "cli_flags_checked": True, "omo_runtime_verified": False}


def build_command(executable, project, session=None, agent=None):
    command = [executable, "run", "--format", "json", "--dir", str(project)]
    if session:
        command.extend(["--session", session])
    if agent:
        command.extend(["--agent", agent])
    return command


class WindowsJob:
    """Native process grouping; does not rely on taskkill/tasklist credentials."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
            "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int,
                                          ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.c_void_p], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            fn = getattr(self.api, name)
            fn.argtypes, fn.restype = arguments, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def assign(self, process):
        if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise self.ctypes.WinError(self.ctypes.get_last_error())

    def resume(self, process):
        """Resume the single initial thread only after assigning its suspended process."""
        from ctypes import wintypes
        ctypes = self.ctypes

        class ThreadEntry(ctypes.Structure):
            _fields_ = [(name, wintypes.DWORD) for name in
                        ("size", "usage", "thread_id", "owner_pid")] + [
                        ("base_priority", wintypes.LONG), ("delta_priority", wintypes.LONG),
                        ("flags", wintypes.DWORD)]

        signatures = {
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Thread32First": ([wintypes.HANDLE, ctypes.POINTER(ThreadEntry)], wintypes.BOOL),
            "Thread32Next": ([wintypes.HANDLE, ctypes.POINTER(ThreadEntry)], wintypes.BOOL),
            "OpenThread": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "ResumeThread": ([wintypes.HANDLE], wintypes.DWORD),
        }
        for name, (arguments, result) in signatures.items():
            fn = getattr(self.api, name)
            fn.argtypes, fn.restype = arguments, result
        snapshot = self.api.CreateToolhelp32Snapshot(0x4, 0)  # TH32CS_SNAPTHREAD
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        threads = []
        try:
            entry = ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            found = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if entry.owner_pid == process.pid:
                    threads.append(entry.thread_id)
                found = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            self.api.CloseHandle(snapshot)
        if len(threads) != 1:
            raise OSError("Cannot identify the suspended initial process thread")
        thread = self.api.OpenThread(0x2, False, threads[0])  # THREAD_SUSPEND_RESUME
        if not thread:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            count = self.api.ResumeThread(thread)
            if count == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
            if count != 1:
                raise OSError("Unexpected initial thread suspend count")
        finally:
            self.api.CloseHandle(thread)

    def terminate(self):
        import time
        if not self.api.TerminateJobObject(self.handle, 1):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        for _ in range(100):
            accounting = self.ctypes.create_string_buffer(48)
            if not self.api.QueryInformationJobObject(self.handle, 1, accounting, 48, None):
                raise self.ctypes.WinError(self.ctypes.get_last_error())
            # JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses at offset 40.
            if int.from_bytes(accounting.raw[40:44], "little") == 0:
                return
            time.sleep(0.05)
        raise TimeoutError("Owned Windows process job has not terminated")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def stop_owned_process(process, job=None):
    if job is not None:
        job.terminate()
    elif os.name == "nt":
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            # The parent may exit before a descendant that ignored SIGTERM.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def summarize_events(path, text_path):
    sessions, error_count, tool_errors, event_count, non_json = [], 0, 0, 0, 0
    with Path(path).open(encoding="utf-8", errors="replace") as stream, \
            Path(text_path).open("w", encoding="utf-8") as text_out:
        for line in stream:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                non_json += 1
                continue
            if not isinstance(event, dict):
                non_json += 1
                continue
            event_count += 1
            session = event.get("sessionID")
            if isinstance(session, str) and session not in sessions:
                sessions.append(session)
            if event.get("type") == "error":
                error_count += 1
            part = event.get("part")
            if isinstance(part, dict):
                state = part.get("state")
                if part.get("type") == "tool" and isinstance(state, dict):
                    tool_errors += int(state.get("status") == "error")
                if event.get("type") == "text" and isinstance(part.get("text"), str):
                    text_out.write(part["text"] + "\n")
    return {"session_ids_observed": sessions,
            "session_id": sessions[0] if len(sessions) == 1 else None,
            "event_count": event_count, "error_events": error_count,
            "tool_errors": tool_errors, "non_json_lines": non_json}


def run_round(command, prompt, run_dir, timeout):
    run_dir = Path(run_dir)
    tmp = run_dir / "tmp"
    tmp.mkdir()
    events, stderr = run_dir / "events.jsonl", run_dir / "stderr.log"
    text_path, result_path = run_dir / "assistant-text.txt", run_dir / "result.json"
    env = os.environ.copy()
    for name in ("TEMP", "TMP", "TMPDIR"):
        env[name] = str(tmp)
    env["PYTHONIOENCODING"] = "utf-8"
    # Create suspended so no child code can spawn outside our job before assignment.
    options = {"creationflags": subprocess.CREATE_NO_WINDOW | 0x4} if os.name == "nt" else \
              {"start_new_session": True}
    state = {"status": "starting", "command": command, "run_dir": str(run_dir),
             "events_path": str(events), "stderr_path": str(stderr),
             "text_path": str(text_path), "delivery_verified": False}

    def save():
        # result.json is a snapshot; read status before interpreting returncode.
        result_path.write_text(json.dumps(state, ensure_ascii=False, indent=2),
                               encoding="utf-8")

    save()
    process = None
    job = None
    try:
        job = WindowsJob() if os.name == "nt" else None
        with events.open("wb") as out, stderr.open("wb") as err:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out,
                                       stderr=err, env=env, shell=False, **options)
            if job is not None:
                job.assign(process)
                job.resume(process)
            state.update(status="running", pid=process.pid)
            save()
            emit({"status": "running", "pid": process.pid,
                  "result_path": str(result_path), "events_path": str(events)})
            try:
                process.communicate(input=prompt.encode("utf-8"), timeout=timeout)
                state["status"] = "cli_returned"
            except subprocess.TimeoutExpired:
                state["status"] = "timed_out"
                stop_owned_process(process, job)
            except KeyboardInterrupt:
                state["status"] = "interrupted"
                stop_owned_process(process, job)
    except OSError as error:
        state.update(status="launch_error", launch_error_type=type(error).__name__)
    finally:
        if process is not None and process.poll() is None:
            stop_owned_process(process, job)
        if job is not None:
            job.close()
        state["returncode"] = process.returncode if process else None
        if events.exists():
            state.update(summarize_events(events, text_path))
        if state["status"] == "cli_returned":
            if state["returncode"] != 0 or state.get("error_events", 0):
                state["status"] = "cli_error"
            elif state.get("event_count", 0) == 0:
                state["status"] = "unverified_output"
        save()
    emit(state)
    if state["status"] == "timed_out":
        return 124
    if state["status"] == "interrupted":
        return 130
    return 0 if state["status"] == "cli_returned" else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Version/help only; no model call")
    parser.add_argument("--dry-run", action="store_true", help="Show invocation without launching")
    parser.add_argument("--project", type=Path)
    parser.add_argument("--prompt-file", type=Path, help="UTF-8 complete authorized task bundle")
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--session", help="Explicit parent session ID for continuation")
    parser.add_argument("--agent", help="Verified primary agent; otherwise keep configured default")
    parser.add_argument("--executable", help="Native OpenCode executable path")
    parser.add_argument("--timeout", type=int, default=1800, help="Seconds per round, default 1800")
    args = parser.parse_args()
    if args.check and args.dry_run:
        parser.error("--check and --dry-run are mutually exclusive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        executable = resolve_executable(args.executable)
        if args.check:
            emit(probe(executable))
            return 0
        if args.project is None or args.prompt_file is None:
            parser.error("--project and --prompt-file are required")
        project = args.project.expanduser().resolve()
        if not project.is_dir():
            raise ValueError("Project directory does not exist")
        prompt = args.prompt_file.expanduser().resolve().read_text(encoding="utf-8-sig")
        if not prompt.strip():
            raise ValueError("Task bundle must not be empty")
        command = build_command(executable, project, args.session, args.agent)
        default_root = Path("E:/Claude Agent/wish-dev/runtime") if os.name == "nt" else \
                       Path(tempfile.gettempdir()) / "wish-dev"
        root = (args.runtime_root or Path(os.environ.get("WISH_DEV_RUNTIME_ROOT",
                                                       str(default_root)))).resolve()
        if args.dry_run:
            emit({"command": command, "stdin_file": str(args.prompt_file.resolve()),
                  "runtime_root": str(root), "timeout": args.timeout,
                  "model_called": False, "delivery_verified": False})
            return 0
        # Real execution must be authorized by the host before invoking this script.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run_dir = root / (stamp + "-" + uuid.uuid4().hex[:10])
        run_dir.mkdir(parents=True, exist_ok=False)
        (run_dir / "task-bundle.md").write_text(prompt, encoding="utf-8")
        return run_round(command, prompt, run_dir, args.timeout)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        emit({"status": "bridge_error", "error_type": type(error).__name__,
              "message": str(error), "delivery_verified": False})
        return 2


if __name__ == "__main__":
    sys.exit(main())
