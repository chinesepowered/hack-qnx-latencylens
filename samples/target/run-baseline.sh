#!/bin/sh
# run-baseline.sh: the clean baseline. The same kinds of work as the problem samples, designed
# correctly and running together on both CPUs. Latency Lens must report nothing on its trace.
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
#   CPU 0: brakesim-fixed      brake_ctl 63, telemetry 30, logger 10, log_lock PTHREAD_PRIO_INHERIT
#   CPU 0: sensor_ist -p 75    the IST outranks every sample thread (the mains run at 70) on CPU 0,
#                              where the RTC interrupt is delivered, so there is no cross-CPU wakeup
#   CPU 1: send_chain -f       a fast server chain; hmi at 20 stays below io-sock's IST (21)
secs=${1:-3}
cd "$(dirname "$0")"
./sensor_ist -p 75 -c 0 -s "$secs" &
./send_chain -f 1 -c 1 -s "$secs" &
./brakesim-fixed -s "$secs"
wait
