# Build the Latency Lens sample workloads for QNX OS 8.0 (x86_64 target) with the SDP's qcc.
#   source ~/qnx800/qnxsdp-env.sh && make -C samples
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

QCC ?= qcc
TARGET ?= gcc_ntox86_64
CFLAGS ?= -O2 -g -Wall -Wextra -std=gnu11
OUT := build/x86_64

PROGRAMS := brakesim brakesim-fixed sensor_ist send_chain cpu_hog
BINS := $(addprefix $(OUT)/,$(PROGRAMS))

all: $(BINS)

$(OUT):
	mkdir -p $@

$(OUT)/brakesim: src/brakesim.c src/ll_common.h | $(OUT)
	$(QCC) -V$(TARGET) $(CFLAGS) -o $@ $<

$(OUT)/brakesim-fixed: src/brakesim.c src/ll_common.h | $(OUT)
	$(QCC) -V$(TARGET) $(CFLAGS) -DBRAKESIM_FIXED -o $@ $<

$(OUT)/%: src/%.c src/ll_common.h | $(OUT)
	$(QCC) -V$(TARGET) $(CFLAGS) -o $@ $<

clean:
	rm -rf build

.PHONY: all clean
