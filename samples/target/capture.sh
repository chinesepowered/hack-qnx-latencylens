#!/bin/sh
# capture.sh: run a workload on the QNX target while tracelogger records a wide-mode kernel trace.
# Runs on QNX OS 8.0 (as root). Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
#
#   capture.sh <name> <seconds> <command> [args...]
#
# Writes /dev/shmem/<name>.kev. tracelogger starts first and logs for <seconds>; the workload is
# expected to finish inside that window (the samples start their first period ~200 ms after launch).
#   -w      wide mode: thread events carry priority and policy, kernel calls carry their arguments
#   -k 32   kernel buffers per CPU (16 KB each) so bursts are not dropped (override: TL_KBUF=64)
#   -b 128  tracelogger buffers between the kernel and the file
name=$1; secs=$2; shift 2
out=/dev/shmem/$name.kev
rm -f "$out"
tracelogger -w -k "${TL_KBUF:-32}" -b 128 -s "$secs" -f "$out" >/dev/shmem/$name.tracelogger.log 2>&1 &
tl=$!
sleep 1
"$@"
rc=$?
wait $tl
ls -l "$out"
echo "workload exit status: $rc"
