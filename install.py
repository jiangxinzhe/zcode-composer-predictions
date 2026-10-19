#!/usr/bin/env python3
"""Install the ZCode composer predictions overlay.

Typical use:
  python install.py            # detect ZCode, deploy runtime, patch app.asar
  python install.py --remove   # strip the injection line
  python install.py --check    # show detection and current state

This is an unofficial client-side mod, not a marketplace plugin: it patches
app.asar, so ZCode upgrades require re-running the installer.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

VERSION = "0.1.0"
HERE = Path(__file__).resolve().parent
DEFAULT_RUNTIME = Path.home() / ".zcode" / "zcode-composer-predictions"

RUNTIME_FILES = [
    "inject-main.cjs",
    "overlay.js",
    "predict_helper.py",
    "patch_install.py",
    "finalize_on_exit.py",
    "install.py",
    "config.example.json",
    "README.md",
    "LICENSE",
]

DEFAULT_CONFIG = {
    "version": VERSION,
    "enabled": True,
    "pythonPath": sys.executable or "python",
    "dbDir": "",
    "activityDebounceMs": 500,
    "heartbeatMs": 15000,
    "predictTimeoutMs": 45000,
    "statusTimeoutMs": 6000,
    "helperRestartMs": 1000,
    "hotReload": True,
    "debug": False,
    "predict": {
        "providerId": "",
        "modelId": "",
        "maxChars": 160,
        "maxTranscriptChars": 12000,
        "maxMessageChars": 4000,
        "maxMessages": 16,
        "timeoutMs": 30000,
        "maxTokens": 400,
    },
}


def merge(defaults, override):
    out = dict(defaults)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def candidate_asars(root=None):
    out = []
    env_asar = os.environ.get("ZCODE_ASAR")
    if env_asar:
        out.append(Path(env_asar))
    env_root = os.environ.get("ZCODE_ROOT")
    if env_root:
        out.append(Path(env_root) / "resources" / "app.asar")
    if root:
        root_path = Path(root)
        out.append(root_path if root_path.name.lower() == "app.asar" else root_path / "resources" / "app.asar")

    home = Path.home()
    out.extend(
        [
            Path(r"D:\ZCode\resources\app.asar"),
            Path(r"C:\Program Files\ZCode\resources\app.asar"),
            Path(r"C:\Program Files (x86)\ZCode\resources\app.asar"),
            home / "AppData" / "Local" / "Programs" / "ZCode" / "resources" / "app.asar",
            home / "AppData" / "Local" / "ZCode" / "resources" / "app.asar",
            Path("/Applications/ZCode.app/Contents/Resources/app.asar"),
            Path("/opt/ZCode/resources/app.asar"),
        ]
    )
    seen = set()
    unique = []
    for path in out:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            unique.append(path)
    return unique


def validate_asar(path: Path) -> bool:
    try:
        import patch_install

        name = patch_install.asar_package_name(path).lower()
    except Exception:
        name = ""
    exe = path.parent.parent / ("ZCode.exe" if sys.platform == "win32" else "ZCode")
    return "zcode" in name or exe.is_file()


def detect_asar(explicit=None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    candidates.extend(candidate_asars())
    for path in candidates:
        if path.is_file() and validate_asar(path):
            return path
    return None


def deploy_runtime(runtime: Path):
    runtime.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in RUNTIME_FILES:
        src = HERE / name
        dst = runtime / name
        if not src.is_file():
            continue
        if src.resolve() == dst.resolve():
            continue
        shutil.copy2(src, dst)
        copied.append(name)

    config_path = runtime / "config.json"
    existing = {}
    if config_path.is_file():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8"))
        except ValueError:
            existing = {}
    merged = merge(DEFAULT_CONFIG, existing if isinstance(existing, dict) else {})
    merged["version"] = VERSION
    if not merged.get("pythonPath") or not Path(str(merged["pythonPath"])).exists():
        merged["pythonPath"] = sys.executable or "python"
    config_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return copied, config_path


def write_finalize_cmd(runtime: Path, asar: Path):
    cmd = runtime / "finalize.cmd"
    content = (
        "@echo off\r\n"
        "echo Finishing the ZCode composer-predictions patch...\r\n"
        '"%s" "%s" install --finalize --asar "%s"\r\n'
        "pause\r\n" % (sys.executable, runtime / "patch_install.py", asar)
    )
    try:
        cmd.write_text(content, encoding="utf-8")
    except OSError:
        pass
    return cmd


def launch_finalizer(runtime: Path, asar: Path):
    """Run the pending-replace watcher detached so it survives ZCode exit."""
    script = runtime / "finalize_on_exit.py"
    if not script.is_file():
        return None
    tmp = asar.with_name("app.asar.zcp.tmp")
    log = runtime / "finalize.log"
    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")
    exe = pythonw if pythonw.is_file() else python
    try:
        if sys.platform == "win32":
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            return subprocess.Popen(
                [str(exe), str(script), str(asar), str(tmp), str(log)],
                cwd=str(runtime),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
                close_fds=True,
            )
        return subprocess.Popen(
            [str(exe), str(script), str(asar), str(tmp), str(log)],
            cwd=str(runtime),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
        return None


def print_status(asar: Path, runtime: Path):
    import patch_install

    patch_install.set_target(asar)
    patch_install.set_runtime(runtime)
    injected = False
    try:
        injected = bool(patch_install.ZCP_LINE_RE.search(patch_install.entry_bytes_of(asar)))
    except Exception as exc:
        print("  asar read error: %s" % exc)
    print("  ZCode asar : %s" % asar)
    print("  runtime    : %s" % runtime)
    print("  config     : %s" % (runtime / "config.json"))
    print("  injection  : %s" % ("present" if injected else "absent"))
    pending = asar.with_name("app.asar.zcp.tmp")
    print("  pending tmp: %s" % ("present" if pending.exists() else "absent"))


def main():
    parser = argparse.ArgumentParser(description="Install ZCode composer predictions")
    parser.add_argument("--asar", help="path to ZCode app.asar")
    parser.add_argument("--root", help="ZCode installation directory")
    parser.add_argument("--runtime", help="runtime directory (default: ~/.zcode/zcode-composer-predictions)")
    parser.add_argument("--dev", action="store_true", help="run from this source directory; do not copy")
    parser.add_argument("--remove", action="store_true", help="strip the injection line")
    parser.add_argument("--purge", action="store_true", help="with --remove, delete the runtime directory")
    parser.add_argument("--check", action="store_true", help="show state without changing anything")
    parser.add_argument("--no-patch", action="store_true", help="deploy runtime but do not touch app.asar")
    parser.add_argument("--dry-run", action="store_true", help="print intended actions only")
    args = parser.parse_args()

    runtime = HERE if args.dev else Path(args.runtime).expanduser() if args.runtime else DEFAULT_RUNTIME
    asar = detect_asar(args.asar or args.root)

    if args.remove:
        if not asar:
            print("ZCode app.asar not found; pass --asar or --root.")
            return 1
        print("Removing composer-predictions from: %s" % asar)
        if args.dry_run:
            print_status(asar, runtime)
            return 0
        sys.path.insert(0, str(HERE))
        import patch_install

        patch_install.set_target(asar)
        patch_install.set_runtime(runtime)
        ok = patch_install.remove()
        if ok:
            pending = asar.with_name("app.asar.zcp.tmp")
            if pending.exists():
                try:
                    pending.unlink()
                    print("removed pending archive: %s" % pending)
                except OSError as exc:
                    print("could not remove pending archive: %s" % exc)
            if args.purge and runtime != HERE and runtime.is_dir():
                shutil.rmtree(runtime)
                print("removed runtime: %s" % runtime)
        return 0 if ok else 1

    if not asar:
        print("ZCode app.asar not found. Pass --asar <path> or --root <ZCode dir>.")
        print("Searched:")
        for path in candidate_asars(args.root):
            print("  -", path)
        return 1

    print("ZCode asar : %s" % asar)
    print("runtime    : %s" % runtime)
    if args.check or args.dry_run:
        print_status(asar, runtime)
        return 0

    sys.path.insert(0, str(HERE))
    import patch_install

    patch_install.set_target(asar)
    patch_install.set_runtime(runtime)

    copied, config_path = deploy_runtime(runtime)
    if copied:
        print("runtime deployed (%d files copied)" % len(copied))
    else:
        print("runtime already up to date")
    print("config     : %s" % config_path)
    print("python     : %s" % json.loads(config_path.read_text(encoding="utf-8")).get("pythonPath"))

    if args.no_patch:
        print("asar patch skipped (--no-patch).")
        return 0

    ok = patch_install.install()
    if not ok:
        print("\nThe runtime is deployed but the archive was not patched yet.")
        cmd = write_finalize_cmd(runtime, asar)
        watcher = launch_finalizer(runtime, asar)
        if watcher:
            print("A detached finalizer is watching for ZCode to quit.")
            print("Quit ZCode normally, wait a few seconds, then reopen it.")
        else:
            print("Automatic finalizer could not start.")
            print("Quit ZCode completely, then run:")
            print("  python \"%s\" install --finalize" % (runtime / "patch_install.py"))
        print("Manual fallback: %s" % cmd)
        return 1

    print("\nInstalled. Restart ZCode completely to load the overlay.")
    print("First check after restart:")
    print("  1. send a short message and wait for the reply;")
    print("  2. click the empty composer - a gray suggestion should appear;")
    print("  3. Tab accepts, Esc dismisses, typing dismisses.")
    print("Logs: %s" % (runtime / "zcp.log"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
