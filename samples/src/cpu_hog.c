/*
 * cpu_hog.c: a diagnostic task that monopolises a core and starves the periodic threads on it.
 *
 * Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *   diag_scan    priority 40  every 500 ms scans the flash for errors: 400 ms of CPU work
 *   can_rx       priority 25  every 10 ms drains the CAN mailbox: 0.3 ms of work
 *   sensor_poll  priority 20  every 5 ms polls the sensors: 0.2 ms of work
 *
 * All three are pinned to the same CPU. SCHED_FIFO never time-slices between priorities, so while
 * diag_scan runs, can_rx and sensor_poll stay READY and miss every release for 400 ms. The fix is
 * to run the scan below the control threads (or as SCHED_SPORADIC with a budget).
 *
 * Usage: cpu_hog [-c cpu] [-s seconds]
 */
#include "ll_common.h"

static int cpu;
static uint64_t epoch, stop_at;

struct periodic {
    const char *name;
    int prio;
    uint64_t period, work;
    unsigned jobs, late;
};

static void *periodic_thread(void *arg) {
    struct periodic *p = arg;
    ll_self(p->name, p->prio);
    ll_pin_cpu(cpu);
    ll_warmup();
    uint64_t release = epoch;
    for (unsigned seq = 1; release < stop_at; seq++, release += p->period) {
        ll_sleep_until(release);
        uint64_t start = ll_now_ns();
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_BEGIN, (int)seq, (int)((start - release) / 1000));
        ll_burn_ns(p->work);
        uint64_t resp = ll_now_ns() - release;
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_END, (int)seq, (int)(resp / 1000));
        p->jobs++;
        if (resp > p->period) p->late++;
    }
    return NULL;
}

static void *diag_scan(void *arg) {
    (void)arg;
    ll_self("diag_scan", 40);
    ll_pin_cpu(cpu);
    ll_warmup();
    for (uint64_t release = epoch + LL_MS(50); release < stop_at; release += LL_MS(500)) {
        ll_sleep_until(release);
        ll_burn_ns(LL_MS(400)); /* checksum every flash block */
    }
    return NULL;
}

int main(int argc, char **argv) {
    cpu = (int)ll_opt(argc, argv, "-c", 0);
    long seconds = ll_opt(argc, argv, "-s", 3);
    ll_self("main", 70);
    epoch = (ll_now_ns() / LL_MS(100) + 2) * LL_MS(100);
    stop_at = epoch + (uint64_t)seconds * 1000000000ull;
    trace_logf(LL_EV_NOTE, "cpu_hog start cpu=%d", cpu);
    struct periodic can = {"can_rx", 25, LL_MS(10), LL_US(300), 0, 0};
    struct periodic sensor = {"sensor_poll", 20, LL_MS(5), LL_US(200), 0, 0};
    pthread_t t[3];
    t[0] = ll_spawn(periodic_thread, &can, can.prio);
    t[1] = ll_spawn(periodic_thread, &sensor, sensor.prio);
    t[2] = ll_spawn(diag_scan, NULL, 40);
    for (int i = 0; i < 3; i++) pthread_join(t[i], NULL);
    trace_logf(LL_EV_NOTE, "cpu_hog done");
    printf("cpu_hog: cpu %d\n", cpu);
    printf("can_rx: %u jobs, %u finished after their period\n", can.jobs, can.late);
    printf("sensor_poll: %u jobs, %u finished after their period\n", sensor.jobs, sensor.late);
    return 0;
}
