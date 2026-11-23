#!/usr/bin/env python3
"""Record a real terminal session as an asciicast v2 file, typing each command like a person.

Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

The demo video's terminal scenes are this recording replayed: every line of output is what the
QNX target and the host tools really printed. Long waits (tracelogger capturing for 5 s) are
compressed to `--idle` seconds, the way asciinema's idle_time_limit does.

Usage: term_session.py script.json out.cast [--cols 110 --rows 30 --idle 0.8]
script.json: [{"cmd": "...", "prompt": "regex for the next prompt", "timeout": 60, "pause": 0.6}, ...]
"""
import argparse
import json
import os
import pty
import random
import re
import select
import subprocess
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("script")
ap.add_argument("out")
ap.add_argument("--cols", type=int, default=110)
ap.add_argument("--rows", type=int, default=30)
ap.add_argument("--idle", type=float, default=0.8)
ap.add_argument("--cwd", default=os.getcwd())
args = ap.parse_args()
steps = json.load(open(args.script))
random.seed(7)

master, slave = pty.openpty()
os.set_blocking(master, False)
import fcntl, struct, termios  # noqa: E401

fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
import tempfile  # noqa: E402

fd, inputrc = tempfile.mkstemp(prefix="term_session_", suffix=".inputrc")
with os.fdopen(fd, "w") as f:
    f.write("set enable-bracketed-paste off\n")
env = dict(os.environ, TERM="xterm-256color", PS1="\\[\\e[1;32m\\]$\\[\\e[0m\\] ", COLUMNS=str(args.cols), LINES=str(args.rows), INPUTRC=inputrc)
HOST_PROMPT = r"\$(\x1b\[0m)? $"
proc = subprocess.Popen(["bash", "--noprofile", "--norc", "-i"], stdin=slave, stdout=slave, stderr=slave, cwd=args.cwd, env=env, start_new_session=True)
os.close(slave)

events = []  # (virtual time, data)
vt = 0.0  # virtual (compressed) clock
last_real = time.monotonic()
buf = ""


def pump(timeout):
    """Read whatever arrives within `timeout` s, recording it on the compressed clock."""
    global vt, last_real, buf
    end = time.monotonic() + timeout
    got = False
    while time.monotonic() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if not r:
            continue
        try:
            data = os.read(master, 65536).decode("utf-8", "replace")
        except (BlockingIOError, OSError):
            continue
        if not data:
            break
        now = time.monotonic()
        vt += min(now - last_real, args.idle)
        last_real = now
        events.append([round(vt, 4), "o", data])
        buf += data
        got = True
    return got


def wait_for(pattern, timeout):
    global buf
    rx = re.compile(pattern)
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump(0.1)
        if rx.search(buf[-400:]):
            return True
    raise TimeoutError(f"timed out waiting for {pattern!r}; tail: {buf[-300:]!r}")


def type_text(text):
    """Send one character at a time with human-ish pauses (recorded via the shell's echo)."""
    global vt, last_real
    for ch in text:
        os.write(master, ch.encode())
        delay = random.uniform(0.035, 0.085) if ch != " " else random.uniform(0.06, 0.12)
        time.sleep(delay)
        pump(0.0)
        # typing time counts in full on the virtual clock
    return


wait_for(HOST_PROMPT, 10)
buf = ""
events.clear()
vt = 0.0
last_real = time.monotonic()
events.append([0.0, "o", "\x1b[1;32m$\x1b[0m "])
for st in steps:
    if "pause" in st and "cmd" not in st:
        time.sleep(st["pause"])
        vt += st["pause"]
        last_real = time.monotonic()
        continue
    buf = ""
    time.sleep(st.get("think", 0.35))
    vt += st.get("think", 0.35)
    last_real = time.monotonic()
    type_text(st["cmd"])
    time.sleep(0.25)
    os.write(master, b"\r")
    wait_for(st.get("prompt", HOST_PROMPT), st.get("timeout", 60))
    pump(0.2)
    if st.get("pause"):
        time.sleep(st["pause"])
        vt += st["pause"]
        last_real = time.monotonic()

proc.terminate()
os.unlink(inputrc)
with open(args.out, "w") as f:
    f.write(json.dumps({"version": 2, "width": args.cols, "height": args.rows, "timestamp": int(time.time()), "env": {"TERM": "xterm-256color"}}) + "\n")
    for t, kind, data in events:
        f.write(json.dumps([t, kind, data]) + "\n")
print(f"recorded {len(events)} events, {vt:.1f} s (compressed) -> {args.out}")
