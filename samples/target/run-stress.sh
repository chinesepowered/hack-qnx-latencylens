#!/bin/sh
# run-stress.sh: a busy system for the million-event trace (parser and timeline performance).
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
# Everything at once: the inversion, the IST, a 1 ms request loop through the server chain.
secs=${1:-18}
cd "$(dirname "$0")"
./sensor_ist -p 60 -c 1 -s "$secs" &
./send_chain -f 1 -c 1 -P 55 -t 1 -s "$secs" &
./brakesim -s "$secs"
wait
