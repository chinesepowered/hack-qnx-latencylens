#!/bin/sh
# run-baseline.sh: the clean baseline. The same kinds of work as the problem samples, designed
# correctly and running together on both CPUs. Latency Lens must report nothing on its trace.
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
#   CPU 0: brakesim-fixed      brake_ctl 63, telemetry 30, logger 10, log_lock PTHREAD_PRIO_INHERIT
#   CPU 1: sensor_ist -p 60    the IST outranks video_enc (50)
#   CPU 1: send_chain -f -P 55 a fast server chain whose client outranks video_enc
secs=${1:-3}
cd "$(dirname "$0")"
./sensor_ist -p 60 -c 1 -s "$secs" &
./send_chain -f 1 -c 1 -P 55 -s "$secs" &
./brakesim-fixed -s "$secs"
wait
