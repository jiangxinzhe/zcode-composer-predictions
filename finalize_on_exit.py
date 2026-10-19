#!/usr/bin/env python3
"""Replace app.asar with the pending .tmp after ZCode exits.

Launched detached by install.py when ZCode is running and the archive cannot be
replaced.  It polls tasklist, waits for the client to quit, then performs the
atomic replace.  Logs only its own result.
"""

import os
import subprocess
import sys
import time
from pathlib import Path


def zcode_running():
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ZCode.exe"],
            capture_output=True,
            text=True,
            encoding="gbk",
            errors="replace",
        ).stdout
        return "ZCode.exe" in out
    except Exception:
        return True


def main():
    if len(sys.argv) < 4:
        return 2
    asar = Path(sys.argv[1])
    tmp = Path(sys.argv[2])
    log_path = Path(sys.argv[3])

    def write(message):
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
        except OSError:
            pass

    if not tmp.exists():
        write("pending tmp missing: %s" % tmp)
        return 1

    write("watching for ZCode exit (tmp=%s)" % tmp)
    deadline = time.time() + 24 * 3600
    while time.time() < deadline:
        if not zcode_running():
            for attempt in range(60):
                try:
                    os.replace(tmp, asar)
                    write("patched app.asar successfully")
                    return 0
                except OSError as exc:
                    write("attempt %d failed: %s" % (attempt + 1, exc))
                    time.sleep(0.5)
            write("gave up after 30s; run patch_install.py install --finalize manually")
            return 1
        time.sleep(1)

    write("24h timeout")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
