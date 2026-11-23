#!/usr/bin/env python3
"""Run shell commands on the QNX VM's serial console (the unix socket that scripts/qnx-vm.sh creates).

The serial console needs no network, so it is the fallback when sshd is unavailable and the way the
demo recording drives the target. Each command's output is framed with unique markers so we read
exactly that command's output.

Usage: qnx-serial.py [--sock PATH] [--timeout SEC] [--record FILE.cast] 'cmd1' 'cmd2' ...
"""
import argparse
import json
import os
import socket
import sys
import time
import uuid

ap = argparse.ArgumentParser()
ap.add_argument("--sock", default=os.path.expanduser(os.environ.get("QNX_VM_DIR", "~/qnxvm")) + "/output/serial.sock")
ap.add_argument("--timeout", type=float, default=120.0)
ap.add_argument("--record", help="append an asciicast v2 recording of the session to this file")
ap.add_argument("--echo", action="store_true", help="print raw console bytes as they arrive")
ap.add_argument("cmds", nargs="+")
args = ap.parse_args()

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(args.sock)
s.settimeout(0.2)
t_start = time.time()
cast = None
if args.record:
    new = not os.path.exists(args.record)
    cast = open(args.record, "a")
    if new:
        cast.write(json.dumps({"version": 2, "width": 110, "height": 30, "timestamp": int(t_start)}) + "\n")


def rec(kind, data):
    if cast:
        cast.write(json.dumps([round(time.time() - t_start, 4), kind, data]) + "\n")


def read_until(token, timeout):
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
        text = chunk.decode("utf-8", "replace")
        rec("o", text)
        if args.echo:
            sys.stdout.write(text)
            sys.stdout.flush()
        if token.encode() in buf:
            return buf.decode("utf-8", "replace")
    raise TimeoutError(f"timed out waiting for {token!r}; got: {buf[-400:]!r}")


# Wake the console, cancel any half-typed line, and drain whatever is pending.
s.sendall(b"\x03\n")
time.sleep(0.5)
try:
    while s.recv(65536):
        pass
except socket.timeout:
    pass

rc = 0
for cmd in args.cmds:
    tag = uuid.uuid4().hex[:8]
    begin, end = f"__B{tag}__", f"__E{tag}__"
    # The markers are split with quotes so the echoed command line does not match them.
    line = f"echo '__B''{tag}__'; {cmd}; echo \"__E{tag[:4]}\"\"{tag[4:]}__ rc=$?\"\n"
    s.sendall(line.encode())
    out = read_until(end, args.timeout)
    body = out.split(begin, 1)[-1].split(end, 1)[0]
    tail = out.split(end, 1)[1] if end in out else ""
    status = tail.split("rc=", 1)[1].split()[0] if "rc=" in tail else "?"
    sys.stdout.write(body.lstrip("\r\n"))
    if not args.echo:
        sys.stdout.flush()
    if status not in ("0", "?"):
        rc = int(status) if status.isdigit() else 1
s.close()
sys.exit(rc)
