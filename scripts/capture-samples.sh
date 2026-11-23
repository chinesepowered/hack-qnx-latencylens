#!/usr/bin/env bash
# capture-samples.sh: build the samples, run each one on the QNX VM under tracelogger, and pull the
# traces back into samples/traces/. Also stores the SDP's own traceprinter rendering of every trace
# (gzipped) as the reference our .kev reader is tested against.
#
#   scripts/qnx-vm.sh start            # boot the VM first
#   scripts/capture-samples.sh [name...]   # default: all
#
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
cd "$(dirname "$0")/.."
V=scripts/qnx-vm.sh
# shellcheck disable=SC1091
source "${QNX_SDP:-$HOME/qnx800}/qnxsdp-env.sh" >/dev/null
make -C samples >/dev/null
mkdir -p samples/traces
$V ssh 'mkdir -p /data/ll'
for f in samples/build/x86_64/* samples/target/*.sh; do $V put "$f" "/data/ll/$(basename "$f")"; done
$V ssh 'chmod +x /data/ll/*'

capture() {
  local name=$1 secs=$2; shift 2
  echo "== $name: $*"
  $V ssh "cd /data/ll && TL_KBUF=${TL_KBUF:-32} ./capture.sh $name $secs $*" | tee "samples/traces/$name.run.txt"
  $V get "/dev/shmem/$name.kev" "samples/traces/$name.kev"
  if [[ "$name" == stress* ]]; then
    # The full traceprinter text of a million events is large; keep its per-event-type counts.
    traceprinter -f "samples/traces/$name.kev" | node scripts/traceprinter-summary.mjs \
      > "samples/traces/$name.traceprinter-summary.json"
    gzip -9 -n -f "samples/traces/$name.kev"
  else
    traceprinter -f "samples/traces/$name.kev" | gzip -9 -n > "samples/traces/$name.traceprinter.txt.gz"
  fi
}

SELECTED=("$@")
sel() { # true when no names were given, or when $1 is one of them
  [[ ${#SELECTED[@]} -eq 0 ]] && return 0
  local n; for n in "${SELECTED[@]}"; do [[ "$n" == "$1" ]] && return 0; done; return 1
}

sel inversion       && capture inversion       5 ./brakesim -s 3
sel inversion-fixed && capture inversion-fixed 5 ./brakesim-fixed -s 3
sel ist-latency     && capture ist-latency     5 ./sensor_ist -s 3
sel send-chain      && capture send-chain      5 ./send_chain -s 3
sel cpu-hog         && capture cpu-hog         5 ./cpu_hog -s 3
sel baseline        && capture baseline        5 ./run-baseline.sh 3
sel stress          && TL_KBUF=96 capture stress 21 ./run-stress.sh 18
ls -la samples/traces
