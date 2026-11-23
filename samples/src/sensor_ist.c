/*
 * sensor_ist.c: an interrupt service thread (IST) that is starved by a higher-priority thread.
 *
 * Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * QNX OS 8.0 has no ISRs: a driver attaches a thread to the interrupt with InterruptAttachThread()
 * and that thread (the IST) blocks in InterruptWait() until the kernel delivers the interrupt. The
 * interrupt latency a driver sees is therefore "interrupt delivered" to "IST running", and that is
 * decided by the scheduler: the IST runs only when it is the highest-priority ready thread.
 *
 * The interrupt source is real (emulated) hardware: the CMOS RTC's periodic interrupt on IRQ 8,
 * programmed to 512 Hz, standing in for an ADC "sample ready" line. The IST acknowledges the RTC
 * (reads register C) and processes the sample.
 *
 *   adc_ist    priority -p (default 40)  IST on IRQ 8, 30 us of work per interrupt
 *   video_enc  priority 50               every 40 ms encodes a frame: 8 ms of CPU work
 *
 * Both are pinned to the same CPU. With the default priorities the encoder outranks the IST, so
 * every frame delays the sensor interrupt by up to 8 ms. Run with -p 60 for the correct design.
 *
 * Usage: sensor_ist [-p ist_priority] [-c cpu] [-s seconds] [-e 0]   (-e 0: no video_enc thread)
 */
#include "ll_common.h"

#include <hw/inout.h>

#define RTC_IRQ 8
#define RTC_RATE 7 /* 32768 >> (7 - 1) = 512 Hz */

static volatile int running = 1;
static int cpu;
static uint64_t stop_at;
static unsigned interrupts;
static uint64_t worst_gap_cycles;

static uint8_t cmos_read(uint8_t reg) {
    out8(0x70, 0x80 | reg);
    return in8(0x71);
}
static void cmos_write(uint8_t reg, uint8_t v) {
    out8(0x70, 0x80 | reg);
    out8(0x71, v);
}

static void *adc_ist(void *arg) {
    int prio = (int)(intptr_t)arg;
    ll_self("adc_ist", prio);
    ll_pin_cpu(cpu);
    ll_warmup();
    if (ThreadCtl(_NTO_TCTL_IO_LEVEL, (void *)_NTO_IO_LEVEL_1) == -1) {
        perror("ThreadCtl(_NTO_TCTL_IO_LEVEL)");
        exit(1);
    }
    int id = InterruptAttachThread(RTC_IRQ, _NTO_INTR_FLAGS_END);
    if (id == -1) {
        perror("InterruptAttachThread");
        exit(1);
    }
    cmos_write(0x0A, (uint8_t)((cmos_read(0x0A) & 0xF0) | RTC_RATE));
    cmos_write(0x0B, cmos_read(0x0B) | 0x40); /* periodic interrupt enable */
    (void)cmos_read(0x0C);
    uint64_t last = ClockCycles();
    while (running && ll_now_ns() < stop_at) {
        if (InterruptWait(_NTO_INTR_WAIT_FLAGS_UNMASK, NULL) == -1) break;
        (void)cmos_read(0x0C); /* acknowledge the RTC */
        uint64_t now = ClockCycles();
        if (now - last > worst_gap_cycles) worst_gap_cycles = now - last;
        last = now;
        ll_burn_ns(LL_US(30)); /* convert and filter the sample */
        interrupts++;
    }
    cmos_write(0x0B, cmos_read(0x0B) & (uint8_t)~0x40);
    InterruptDetach(id);
    return NULL;
}

static void *video_enc(void *arg) {
    (void)arg;
    ll_self("video_enc", 50);
    ll_pin_cpu(cpu);
    ll_warmup();
    uint64_t release = (ll_now_ns() / LL_MS(10) + 5) * LL_MS(10);
    for (; running && release < stop_at; release += LL_MS(40)) {
        ll_sleep_until(release);
        ll_burn_ns(LL_MS(8)); /* encode one frame */
    }
    return NULL;
}

int main(int argc, char **argv) {
    int ist_prio = (int)ll_opt(argc, argv, "-p", 40);
    cpu = (int)ll_opt(argc, argv, "-c", 0);
    long seconds = ll_opt(argc, argv, "-s", 3);
    int encoder = (int)ll_opt(argc, argv, "-e", 1);
    ll_self("main", 70);
    stop_at = ll_now_ns() + LL_MS(100) + (uint64_t)seconds * 1000000000ull;
    trace_logf(LL_EV_NOTE, "sensor_ist start ist_prio=%d video_enc_prio=50 cpu=%d", ist_prio, cpu);
    pthread_t a = ll_spawn(adc_ist, (void *)(intptr_t)ist_prio, ist_prio);
    if (encoder) {
        pthread_t b = ll_spawn(video_enc, NULL, 50);
        pthread_join(b, NULL);
    } else {
        ll_sleep_until(stop_at);
    }
    running = 0;
    pthread_join(a, NULL);
    trace_logf(LL_EV_NOTE, "sensor_ist done interrupts=%u", interrupts);
    printf("sensor_ist: adc_ist priority %d, video_enc priority 50, cpu %d\n", ist_prio, cpu);
    printf("adc_ist: %u interrupts serviced, worst gap between services %.2f ms (nominal %.2f ms)\n", interrupts,
           (double)worst_gap_cycles * 1000.0 / ll_cycles_per_sec(), 1000.0 / (32768 >> (RTC_RATE - 1)));
    return 0;
}
