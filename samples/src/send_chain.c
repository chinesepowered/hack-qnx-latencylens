/*
 * send_chain.c: a request that waits on a chain of servers (Neutrino message passing sample).
 *
 * Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Five processes talk with MsgSend()/MsgReceive()/MsgReply() over channels found with
 * name_attach()/name_open():
 *
 *   hmi            priority 20  every 50 ms asks nav_server for a route        (the parent process)
 *   nav_server     priority 10  plans the route, asks map_db for the tiles
 *   map_db         priority 10  single-threaded; asks flash_io for the raw tiles, then decodes them
 *   flash_io       priority 10  reads the tiles (CPU work standing in for a slow flash read)
 *   route_planner  priority 15  every 50 ms, 1 ms before hmi, asks map_db for a long prefetch
 *
 * When hmi sends, map_db is still busy with route_planner's prefetch, so the request is stuck:
 *   hmi REPLY-blocked on nav_server, nav_server SEND-blocked on map_db,
 *   map_db REPLY-blocked on flash_io, flash_io running.
 * Servers receive at their client's priority (Neutrino's priority inheritance for messages), so
 * the whole chain runs at the hmi's priority once it gets the CPU. Run with -f for a fast system
 * (50 us of work per hop, no prefetch) where no chain lasts long enough to matter.
 *
 * Usage: send_chain [-f 1] [-c cpu] [-s seconds] [-P hmi_priority] [-t period_ms]
 *   -P  priority of the hmi client (default 20); servers inherit it while they work for hmi
 *   -t  hmi request period in ms (default 50)
 */
#include "ll_common.h"

#include <signal.h>
#include <sys/dispatch.h>
#include <sys/iomsg.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHAIN_MSG (_IO_MAX + 0x100)

typedef struct {
    uint16_t type;
    uint16_t hops;
    uint32_t seq;
    uint32_t work_us; /* how much work the next server should do */
} chain_msg_t;

static int cpu = 1;
static int fast;
static int hmi_prio = 20;

static int open_retry(const char *name) {
    for (int i = 0; i < 200; i++) {
        int coid = name_open(name, 0);
        if (coid != -1) return coid;
        ll_sleep_until(ll_now_ns() + LL_MS(10));
    }
    fprintf(stderr, "name_open(%s): %s\n", name, strerror(errno));
    exit(1);
}

/* A minimal name_attach() server loop: answers the connect message, ignores pulses, and calls
 * handle() for our own requests. */
static void serve(const char *name, const char *thread, void (*handle)(int rcvid, chain_msg_t *m)) {
    ll_self(thread, 10);
    ll_pin_cpu(cpu);
    ll_warmup();
    name_attach_t *att = name_attach(NULL, name, 0);
    if (!att) {
        perror("name_attach");
        exit(1);
    }
    for (;;) {
        union {
            uint16_t type;
            chain_msg_t m;
            struct _pulse p;
            char raw[512];
        } u;
        int rcvid = MsgReceive(att->chid, &u, sizeof u, NULL);
        if (rcvid == -1) break;
        if (rcvid == 0) {
            if (u.p.code == _PULSE_CODE_DISCONNECT) ConnectDetach(u.p.scoid);
            continue;
        }
        if (u.type == _IO_CONNECT) {
            MsgReply(rcvid, EOK, NULL, 0);
            continue;
        }
        if (u.type != CHAIN_MSG) {
            MsgError(rcvid, ENOSYS);
            continue;
        }
        handle(rcvid, &u.m);
    }
}

static int map_coid = -1, flash_coid = -1;

static void flash_handle(int rcvid, chain_msg_t *m) {
    ll_burn_ns(LL_US(m->work_us)); /* read the raw tiles */
    m->hops++;
    MsgReply(rcvid, EOK, m, sizeof *m);
}

static void map_handle(int rcvid, chain_msg_t *m) {
    if (flash_coid == -1) flash_coid = open_retry("ll_flash_io");
    chain_msg_t q = {CHAIN_MSG, 0, m->seq, m->work_us / 2};
    MsgSend(flash_coid, &q, sizeof q, &q, sizeof q);
    ll_burn_ns(LL_US(m->work_us / 2)); /* decode the tiles */
    m->hops = (uint16_t)(q.hops + 1);
    MsgReply(rcvid, EOK, m, sizeof *m);
}

static void nav_handle(int rcvid, chain_msg_t *m) {
    if (map_coid == -1) map_coid = open_retry("ll_map_db");
    ll_burn_ns(LL_US(fast ? 50 : 200)); /* plan the route */
    chain_msg_t q = {CHAIN_MSG, 0, m->seq, fast ? 100 : 6000};
    MsgSend(map_coid, &q, sizeof q, &q, sizeof q);
    m->hops = (uint16_t)(q.hops + 1);
    MsgReply(rcvid, EOK, m, sizeof *m);
}

static void run_route_planner(uint64_t epoch, uint64_t stop_at) {
    ll_self("route_planner", 15);
    ll_pin_cpu(cpu);
    ll_warmup();
    int coid = open_retry("ll_map_db");
    for (uint64_t release = epoch + LL_MS(49); release < stop_at; release += LL_MS(50)) {
        ll_sleep_until(release);
        chain_msg_t m = {CHAIN_MSG, 0, 0, 8000}; /* prefetch the next map region */
        MsgSend(coid, &m, sizeof m, &m, sizeof m);
    }
}

int main(int argc, char **argv) {
    fast = (int)ll_opt(argc, argv, "-f", 0);
    cpu = (int)ll_opt(argc, argv, "-c", 1);
    long seconds = ll_opt(argc, argv, "-s", 3);
    hmi_prio = (int)ll_opt(argc, argv, "-P", 20);
    uint64_t period = LL_MS(ll_opt(argc, argv, "-t", 50));
    uint64_t epoch = (ll_now_ns() / LL_MS(100) + 5) * LL_MS(100);
    uint64_t stop_at = epoch + (uint64_t)seconds * 1000000000ull;
    pid_t kids[4];
    int nk = 0;

    if ((kids[nk++] = fork()) == 0) serve("ll_flash_io", "flash_io", flash_handle), _exit(0);
    if ((kids[nk++] = fork()) == 0) serve("ll_map_db", "map_db", map_handle), _exit(0);
    if ((kids[nk++] = fork()) == 0) serve("ll_nav", "nav_server", nav_handle), _exit(0);
    if (!fast && (kids[nk++] = fork()) == 0) run_route_planner(epoch, stop_at), _exit(0);

    ll_self("hmi", hmi_prio);
    ll_pin_cpu(cpu);
    ll_warmup();
    int nav = open_retry("ll_nav");
    trace_logf(LL_EV_NOTE, "send_chain start fast=%d cpu=%d hmi_prio=%d", fast, cpu, hmi_prio);
    uint64_t worst = 0, total = 0;
    unsigned n = 0;
    for (uint64_t release = epoch + LL_MS(50); release < stop_at; release += period) {
        ll_sleep_until(release);
        uint64_t t0 = ll_now_ns();
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_BEGIN, (int)n, (int)((t0 - release) / 1000));
        chain_msg_t m = {CHAIN_MSG, 0, n, 0};
        MsgSend(nav, &m, sizeof m, &m, sizeof m);
        uint64_t rt = ll_now_ns() - t0;
        TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, LL_EV_JOB_END, (int)n, (int)((ll_now_ns() - release) / 1000));
        total += rt;
        if (rt > worst) worst = rt;
        n++;
    }
    trace_logf(LL_EV_NOTE, "send_chain done requests=%u", n);
    for (int i = 0; i < nk; i++) kill(kids[i], SIGTERM);
    for (int i = 0; i < nk; i++) waitpid(kids[i], NULL, 0);
    printf("send_chain: fast=%d cpu=%d hmi priority %d\n", fast, cpu, hmi_prio);
    printf("hmi: %u route requests, average round trip %.2f ms, worst %.2f ms\n", n, n ? total / 1e6 / n : 0.0,
           worst / 1e6);
    return 0;
}
