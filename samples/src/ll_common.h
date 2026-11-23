/*
 * ll_common.h: small helpers shared by the Latency Lens sample workloads (QNX OS 8.0).
 *
 * Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Every sample is a real-time program in miniature: SCHED_FIFO threads with explicit priorities,
 * pinned to a CPU with a runmask, doing a measured amount of CPU work per job. The helpers keep the
 * samples short and make their timing independent of how fast the CPU (or the emulator) is.
 */
#ifndef LL_COMMON_H
#define LL_COMMON_H

#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/neutrino.h>
#include <sys/syspage.h>
#include <sys/trace.h>

/* User trace event codes (class _NTO_TRACE_USER). Latency Lens reads these as job markers. */
#define LL_EV_JOB_BEGIN 100 /* d1 = job sequence number, d2 = relative deadline in us */
#define LL_EV_JOB_END 101   /* d1 = job sequence number, d2 = response time measured by the job, us */
#define LL_EV_NOTE 110      /* string event: what the program is doing (shown as a marker) */

#define LL_WARMUP_NS 2000000ull

static inline uint64_t ll_cycles_per_sec(void) { return SYSPAGE_ENTRY(qtime)->cycles_per_sec; }

static inline uint64_t ll_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static inline void ll_sleep_until(uint64_t abs_ns) {
    struct timespec ts = {(time_t)(abs_ns / 1000000000ull), (long)(abs_ns % 1000000000ull)};
    while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR) {
    }
}

/*
 * Burn `ns` of this thread's own CPU time. We poll ClockCycles() (a plain RDTSC, no kernel call, so
 * no trace events) and only count short steps: a long gap between two polls means we were preempted
 * and that time belongs to someone else. This keeps a "4 ms critical section" at 4 ms of CPU work
 * even when a higher-priority thread interrupts it, which is what a real computation does.
 *
 * Between polls we do a little arithmetic (about 1 us under emulation, far less on hardware):
 * QEMU's TCG serialises guest RDTSC on a global lock, and two CPUs polling back to back stall each
 * other for up to half their time. With the arithmetic in between that drops to about 1%.
 */
static inline void ll_burn_ns(uint64_t ns) {
    const uint64_t cps = ll_cycles_per_sec();
    const uint64_t target = ns * cps / 1000000000ull;
    const uint64_t max_step = cps / 20000; /* 50 us: longer than any uninterrupted poll */
    volatile uint32_t sink = 0;
    uint64_t used = 0, prev = ClockCycles();
    while (used < target) {
        for (uint32_t i = 0; i < 256; i++) sink += i * 2654435761u;
        uint64_t now = ClockCycles();
        uint64_t step = now - prev;
        if (step < max_step) used += step;
        prev = now;
    }
}

/*
 * Run the job code once before the first release. Under emulation the first execution of a code
 * path is slow (it is translated on first use) and the first touch of a page faults; real systems
 * warm up the same way before entering their control loop.
 */
static inline void ll_warmup(void) { ll_burn_ns(LL_WARMUP_NS); }

/* Pin the calling thread to one CPU. */
static inline void ll_pin_cpu(int cpu) {
    if (ThreadCtl(_NTO_TCTL_RUNMASK, (void *)(uintptr_t)(1u << cpu)) == -1) {
        perror("ThreadCtl(_NTO_TCTL_RUNMASK)");
        exit(1);
    }
}

/* Give the calling thread a SCHED_FIFO priority and a name (the name lands in the trace). */
static inline void ll_self(const char *name, int prio) {
    struct sched_param sp = {.sched_priority = prio};
    int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
    if (rc != EOK) {
        fprintf(stderr, "pthread_setschedparam(%d): %s\n", prio, strerror(rc));
        exit(1);
    }
    pthread_setname_np(pthread_self(), name);
}

/* Start a SCHED_FIFO thread at `prio`. The thread names itself with ll_self() when it starts. */
static inline pthread_t ll_spawn(void *(*fn)(void *), void *arg, int prio) {
    pthread_attr_t a;
    struct sched_param sp = {.sched_priority = prio};
    pthread_t t;
    pthread_attr_init(&a);
    pthread_attr_setinheritsched(&a, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&a, SCHED_FIFO);
    pthread_attr_setschedparam(&a, &sp);
    int rc = pthread_create(&t, &a, fn, arg);
    if (rc != EOK) {
        fprintf(stderr, "pthread_create: %s\n", strerror(rc));
        exit(1);
    }
    pthread_attr_destroy(&a);
    return t;
}

/* Parse "-s seconds" style integer options without pulling in getopt everywhere. */
static inline long ll_opt(int argc, char **argv, const char *flag, long dflt) {
    for (int i = 1; i + 1 < argc; i++)
        if (strcmp(argv[i], flag) == 0) return strtol(argv[i + 1], NULL, 0);
    return dflt;
}

#define LL_MS(x) ((uint64_t)(x) * 1000000ull)
#define LL_US(x) ((uint64_t)(x) * 1000ull)

#endif
