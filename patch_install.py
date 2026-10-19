# -*- coding: utf-8 -*-
"""Patch ZCode's app.asar with the composer-predictions loader.

Usage:
  python patch_install.py install [--finalize]
  python patch_install.py remove
  python patch_install.py check

The loader is a single dynamic-import line appended to out/main/index.js.
Install/remove only touch this tool's own line; other tools' injections are
preserved.  No full asar backup is kept: uninstalling strips the line from the
current archive, so an official ZCode upgrade is never rolled back.

The asar read/write approach follows the MIT-licensed
xhwxt/zcode-token-usage-statusbar project.
"""

import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

if IS_WIN:
    ASAR_DEFAULT = Path(r"D:\ZCode\resources\app.asar")
elif IS_MAC:
    ASAR_DEFAULT = Path("/Applications/ZCode.app/Contents/Resources/app.asar")
else:
    ASAR_DEFAULT = Path("app.asar")

ASAR = ASAR_DEFAULT
TMP = ASAR.with_name("app.asar.zcp.tmp")
HERE = Path(__file__).parent.resolve()
RUNTIME = HERE
LOADER = RUNTIME / "inject-main.cjs"
ENTRY = "out/main/index.js"

INJECT_LINE_TMPL = (
    '\n;import("{url}").then(() => null, (e) => console.error("[zcp] load failed", e));'
)
INJECT_LINE = INJECT_LINE_TMPL.format(url=(RUNTIME / "inject-main.cjs").as_uri())

# Match any composer-predictions injection line, regardless of the directory it
# points at.  The marker keeps the token-usage tool's line untouched.
ZCP_LINE_RE = re.compile(
    rb'\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[zcp\] load failed", e\)\);'
)

ALIGN = 4
BLOCK = 4194304


def set_runtime(path):
    global RUNTIME, LOADER, INJECT_LINE
    RUNTIME = Path(path)
    LOADER = RUNTIME / "inject-main.cjs"
    INJECT_LINE = INJECT_LINE_TMPL.format(url=LOADER.as_uri())


def set_target(asar_path):
    global ASAR, TMP
    ASAR = Path(asar_path)
    TMP = ASAR.with_name("app.asar.zcp.tmp")


def client_running():
    try:
        if IS_WIN:
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq ZCode.exe"],
                capture_output=True,
                text=True,
                encoding="gbk",
                errors="replace",
            ).stdout
            return "ZCode.exe" in out
        if IS_MAC:
            return subprocess.run(["pgrep", "-x", "ZCode"], capture_output=True).returncode == 0
        return subprocess.run(["pgrep", "-x", "zcode"], capture_output=True).returncode == 0
    except Exception:
        return True


# ---------------------------------------------------------------------------
# asar read / write
# ---------------------------------------------------------------------------


def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    if a != 4:
        raise ValueError("unexpected asar pickle prefix %r" % a)
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node, path=""):
    for name, child in node.get("files", {}).items():
        current = "%s/%s" % (path, name)
        if "files" in child:
            yield from iter_files(child, current)
        else:
            yield current, child


def compute_integrity(data):
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": [
            hashlib.sha256(data[i : i + BLOCK]).hexdigest()
            for i in range(0, len(data), BLOCK)
        ],
    }


def repack(src_path, modify, dst_path):
    with open(src_path, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        if missing:
            raise ValueError("paths not in asar: %s" % sorted(missing))

        data_parts = []
        offset = 0
        for name, node in nodes.items():
            if node.get("unpacked"):
                node["offset"] = "0"
                continue
            if name in modify:
                data = modify[name]
                node["size"] = len(data)
                node["integrity"] = compute_integrity(data)
            else:
                src.seek(base + int(node["offset"]))
                data = src.read(node["size"])
            node["offset"] = str(offset)
            data_parts.append(data)
            offset += len(data)

        payload = b"".join(data_parts)
        header_bytes = json.dumps(
            header, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4
        with open(dst_path, "wb") as out:
            out.write(struct.pack("<4I", 4, b_total, c, d))
            out.write(header_bytes)
            out.write(b"\0" * (c - d - 4))
            if out.tell() != 8 + b_total:
                raise ValueError("header pad mismatch")
            out.write(payload)
    return dst_path


def entry_bytes_of(asar_path):
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        node = nodes["/" + ENTRY]
        f.seek(base + int(node["offset"]))
        return f.read(node["size"])


def asar_package_name(asar_path):
    try:
        with open(asar_path, "rb") as f:
            header, base = read_header(f)
            nodes = dict(iter_files(header))
            node = nodes.get("/package.json")
            if not node:
                return ""
            f.seek(base + int(node["offset"]))
            data = json.loads(f.read(node["size"]).decode("utf-8", "replace"))
            return str(data.get("name") or "")
    except Exception:
        return ""


def self_check(asar_path, expect=True):
    with open(asar_path, "rb") as f:
        header, _ = read_header(f)
        count = sum(1 for _ in iter_files(header))
    has = INJECT_LINE.encode() in entry_bytes_of(asar_path)
    ok = has == expect
    print(
        "  [check] header ok, files=%d, injection %s (expected %s)"
        % (count, "present" if has else "absent", "present" if expect else "absent")
    )
    return ok


def syntax_check(asar_path):
    """Use ZCode itself as node to check the modified entry when available."""
    root = asar_path.parent.parent
    exe = root / "ZCode.exe" if IS_WIN else None
    if not exe or not exe.is_file():
        print("  [check] ZCode executable not found; syntax check skipped")
        return True
    src = entry_bytes_of(asar_path)
    tmp_js = HERE / ".entry-check.js"
    tmp_js.write_bytes(src)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    try:
        result = subprocess.run(
            [str(exe), "--check", str(tmp_js)],
            capture_output=True,
            text=True,
            env=env,
        )
    except OSError as exc:
        print("  [check] syntax check could not run (%s); skipped" % exc)
        return True
    finally:
        try:
            tmp_js.unlink()
        except OSError:
            pass
    print("  [check] syntax exit=%s %s" % (result.returncode, result.stderr.strip()[:200]))
    return result.returncode == 0


# ---------------------------------------------------------------------------
# install / remove
# ---------------------------------------------------------------------------


def finalize_pending():
    """Replace app.asar with the already-built .tmp (after ZCode exits)."""
    if not TMP.exists():
        print("no pending TMP; nothing to finalize")
        return False
    print("finalizing pending archive: %s" % TMP)
    if not (self_check(TMP) and syntax_check(TMP)):
        print("self-check failed; TMP kept: %s" % TMP)
        return False
    try:
        os.replace(TMP, ASAR)
    except OSError as exc:
        print("replace failed (%s)" % exc)
        return False
    print("done. Start ZCode to load the overlay.")
    return True


def install(finalize=False):
    if not LOADER.exists():
        print("loader missing: %s" % LOADER)
        return False
    if not os.access(ASAR, os.W_OK) or not os.access(ASAR.parent, os.W_OK):
        print("app.asar or its directory is not writable: %s" % ASAR)
        return False

    if finalize and TMP.exists():
        return finalize_pending()

    entry = entry_bytes_of(ASAR)
    stripped = ZCP_LINE_RE.sub(b"", entry)
    if stripped + INJECT_LINE.encode() == entry:
        print("already installed; the injection line points at %s" % RUNTIME)
        return True

    new_entry = stripped + INJECT_LINE.encode()
    if stripped != entry:
        print("replacing an older injection line")
    print("repacking app.asar (~325 MB, this can take 10-30 seconds)...")
    repack(ASAR, {"/" + ENTRY: new_entry}, TMP)
    print("self-check:")
    if not (self_check(TMP) and syntax_check(TMP)):
        print("self-check failed; not replaced. TMP kept for inspection: %s" % TMP)
        return False

    running = client_running()
    try:
        os.replace(TMP, ASAR)
    except OSError as exc:
        print("replace failed (%s)." % exc)
        print("Quit ZCode completely, then run:")
        print("  python %s install --finalize" % Path(__file__).resolve())
        return False

    if running:
        print("patched while ZCode was running; the running process keeps the old archive.")
    print("done. Restart ZCode to load the overlay.")
    return True


def remove():
    old = entry_bytes_of(ASAR)
    stripped = ZCP_LINE_RE.sub(b"", old)
    if stripped == old:
        print("no composer-predictions injection line found.")
        return True

    print("repacking app.asar to strip the injection line...")
    repack(ASAR, {"/" + ENTRY: stripped}, TMP)
    print("self-check:")
    if not (self_check(TMP, expect=False) and syntax_check(TMP)):
        print("self-check failed; not replaced. TMP kept: %s" % TMP)
        return False
    try:
        os.replace(TMP, ASAR)
    except OSError as exc:
        print("replace failed (%s). Quit ZCode, then run remove again." % exc)
        return False
    print("removed. Restart ZCode for the change to take effect.")
    return True


def check():
    injected = bool(ZCP_LINE_RE.search(entry_bytes_of(ASAR)))
    print("asar:", ASAR, ASAR.stat().st_size, "bytes")
    print("package:", asar_package_name(ASAR) or "(unknown)")
    print("injection:", "present" if injected else "absent")
    print("runtime:", RUNTIME)
    if injected:
        syntax_check(ASAR)
    if TMP.exists():
        print("pending TMP:", TMP)


def main():
    args = sys.argv[1:]
    command = args[0] if args else "check"
    finalize = "--finalize" in args

    asar = None
    runtime = None
    for index, arg in enumerate(args):
        if arg == "--asar" and index + 1 < len(args):
            asar = args[index + 1]
        if arg == "--runtime" and index + 1 < len(args):
            runtime = args[index + 1]
    if asar:
        set_target(asar)
    if runtime:
        set_runtime(runtime)

    if command == "install":
        raise SystemExit(0 if install(finalize=finalize) else 1)
    if command == "remove":
        raise SystemExit(0 if remove() else 1)
    check()
    raise SystemExit(0)


if __name__ == "__main__":
    main()
