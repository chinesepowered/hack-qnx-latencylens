/*
 * brakesim.c: a brake controller that misses deadlines because of a priority inversion.
 *
 * Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Three SCHED_FIFO threads share CPU 0 (pinned with a runmask so the schedule is deterministic):
 *
 *   brake_ctl  priority 63  50 Hz control loop (every 20 ms): compute (0.5 ms), append a record to
 *                           the log ring under log_lock, finish (0.2 ms). Deadline: 15 ms.
 *   telemetry  priority 30  every 100 ms: a 30 ms burst of CPU work (packing CAN frames).
 *   logger     priority 10  every 100 ms: takes log_lock and formats the ring (2 ms of work), then
 *                           writes the block to /dev/shmem/brakesim.log outside the lock.
 *
 * The phases line up so that telemetry wakes while the logger holds log_lock, and brake_ctl wakes
 * while telemetry runs. brake_ctl then blocks on log_lock, the logger (10) cannot run because
 * telemetry (30) is running, and brake_ctl (63) waits for the whole 30 ms burst: a priority
 * inversion. The fix is one line, see LOG_LOCK_PROTOCOL below.
 *
 * Every brake_ctl job emits two user trace events (Latency Lens job markers):
 *   TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, 100, seq, late_us)  at job start, late_us = how long
 *                                                               after its nominal release it began
 *   TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, 101, seq, resp_us)  at job end, resp_us = response time
 *                                         from the nominal release, or from the wakeup when the timer
 *                                         itself was late (the same rule Latency Lens applies)
 *
 * Usage: brakesim [-s seconds]     (default 3)
 * Build: qcc -Vgcc_ntox86_64 -O2 -o brakesim brakesim.c       (the bug as shipped)
 *        or fix LOG_LOCK_PROTOCOL below, or build with -DLOG_LOCK_PROTOCOL=PTHREAD_PRIO_INHERIT
 */
#include "ll_common.h"

#include <fcntl.h>
#include <unistd.h>

/* The protocol of log_lock. BUG: this line came over from a Linux port, where PTHREAD_PRIO_NONE is
 * the default. QNX's own default is PTHREAD_PRIO_INHERIT: the owner of the lock runs at the priority
 * of the highest-priority thread waiting for it. Change this line to fix the sample. */
#ifndef LOG_LOCK_PROTOCOL
#define LOG_LOCK_PROTOCOL PTHREAD_PRIO_NONE
#endif

#define BRAKE_PERIOD LL_MS(20)
#define BRAKE_DEADLINE LL_MS(15)
#define FRAME LL_MS(100)

static pthread_mutex_t log_lock;
static uint32_t log_ring[1024];
static unsigned log_head;
static volatile int running = 1;
static uint64_t epoch; /* CLOCK_MONOTONIC ns of the first frame */
static uint64_t stop_at;

static unsigned brake_jobs, brake_misses;
static uint64_t brake_worst_ns;

static void *brake_ctl(void *arg) {
    (void)arg;
    ll_self("brake_ctl", 63);
    ll_pin_cpu(0);
    ll_warmup();
    uint64_t release = epoch + LL_MS(2);
    for (unsigned seq = 1; running && release < stop_at; seq++, release += BRAKE_PERIOD) {
        int slept = ll_now_ns() < release;
        ll_sleep_until(release);
        uint64_t start = ll_now_ns();
        /* The response clock starts at the nominal release, or at the wakeup if the timer delivered
         * it late: timer lateness belongs to the platform (it is large under QEMU's TCG), not to this
         * program. A job that starts late because the previous one overran keeps its nominal release. */
        uint64_t eff_release = slept ? start : release;
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_BEGIN, (int)seq, (int)((start - release) / 1000));
        ll_burn_ns(LL_US(500)); /* read wheel speeds, compute the brake pressure */
        pthread_mutex_lock(&log_lock);
        log_ring[log_head++ % 1024] = seq;
        ll_burn_ns(LL_US(50));
        pthread_mutex_unlock(&log_lock);
        ll_burn_ns(LL_US(200)); /* write the actuator command */
        uint64_t resp = ll_now_ns() - eff_release;
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_END, (int)seq, (int)(resp / 1000));
        brake_jobs++;
        if (resp > BRAKE_DEADLINE) brake_misses++;
        if (resp > brake_worst_ns) brake_worst_ns = resp;
    }
    return NULL;
}

static void *telemetry(void *arg) {
    (void)arg;
    ll_self("telemetry", 30);
    ll_pin_cpu(0);
    ll_warmup();
    for (uint64_t release = epoch + LL_MS(1); running && release < stop_at; release += FRAME) {
        ll_sleep_until(release);
        ll_burn_ns(LL_MS(30)); /* pack and checksum CAN frames for the uplink */
    }
    return NULL;
}

static void *logger(void *arg) {
    (void)arg;
    ll_self("logger", 10);
    ll_pin_cpu(0);
    ll_warmup();
    int fd = open("/dev/shmem/brakesim.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    char block[256];
    for (uint64_t release = epoch; running && release < stop_at; release += FRAME) {
        ll_sleep_until(release);
        pthread_mutex_lock(&log_lock);
        int n = snprintf(block, sizeof block, "brake records up to %u\n", log_head);
        ll_burn_ns(LL_MS(2)); /* format and compress the ring while holding the lock */
        pthread_mutex_unlock(&log_lock);
        if (fd >= 0) (void)write(fd, block, (size_t)n);
    }
    if (fd >= 0) close(fd);
    return NULL;
}

int main(int argc, char **argv) {
    long seconds = ll_opt(argc, argv, "-s", 3);
    pthread_mutexattr_t ma;
    pthread_mutexattr_init(&ma);
    pthread_mutexattr_setprotocol(&ma, LOG_LOCK_PROTOCOL);
    pthread_mutex_init(&log_lock, &ma);
    pthread_mutexattr_destroy(&ma);
    pthread_mutex_lock(&log_lock); /* touch the lock once so the first real use is warm */
    pthread_mutex_unlock(&log_lock);

    ll_self("main", 70);
    epoch = (ll_now_ns() / LL_MS(100) + 2) * LL_MS(100);
    stop_at = epoch + (uint64_t)seconds * 1000000000ull;
    trace_logf(LL_EV_NOTE, "brakesim start protocol=%s seconds=%ld",
               LOG_LOCK_PROTOCOL == PTHREAD_PRIO_INHERIT ? "PTHREAD_PRIO_INHERIT" : "PTHREAD_PRIO_NONE", seconds);

    pthread_t t[3];
    t[0] = ll_spawn(logger, NULL, 10);
    t[1] = ll_spawn(telemetry, NULL, 30);
    t[2] = ll_spawn(brake_ctl, NULL, 63);
    ll_sleep_until(stop_at + LL_MS(60));
    running = 0;
    for (int i = 0; i < 3; i++) pthread_join(t[i], NULL);

    trace_logf(LL_EV_NOTE, "brakesim done jobs=%u misses=%u", brake_jobs, brake_misses);
    printf("brakesim: protocol=%s\n", LOG_LOCK_PROTOCOL == PTHREAD_PRIO_INHERIT ? "PTHREAD_PRIO_INHERIT" : "PTHREAD_PRIO_NONE");
    printf("brake_ctl: %u jobs, %u deadline misses (deadline %.1f ms), worst response %.2f ms\n", brake_jobs,
           brake_misses, BRAKE_DEADLINE / 1e6, brake_worst_ns / 1e6);
    return brake_misses ? 1 : 0;
}
