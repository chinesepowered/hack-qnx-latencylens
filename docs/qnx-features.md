# QNX technology used, and where

Every item below was checked against the QNX 8.0 documentation (links are to the pages we read) and then
exercised for real in this project: on QNX OS 8.0 running in QEMU x86_64, built with the QNX SDP 8.0
installed in the build session.

| QNX technology | Verified in | Used in |
| --- | --- | --- |
| QNX SDP 8.0 (installed with `qnxsoftwarecenter_clt`) | build session, see `docs/build-log.md` | whole project |
| `qcc` (gcc 12.2.0 for `x86_64`, `-Vgcc_ntox86_64`) | [qcc in the SDP](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/q/qcc.html) | `samples/Makefile` |
| `mkqnximage` (QEMU x86_64 image) | [mkqnximage](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkqnximage.html) | `scripts/qnx-vm.sh` (`image`) |
| `tracelogger` | [tracelogger](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/t/tracelogger.html), [Running tracelogger](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/datacapture_Running_tracelogger.html) | `samples/target/capture.sh`, `run-baseline.sh`, `run-stress.sh` |
| `.kev` trace format | [traceevent_t](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/datainterpretation_traceevent_t.html), [simple and combine events](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_Simple_combine.html), [fast and wide](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_Fast_wide.html), [timestamps](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/datainterpretation_Timestamps.html), [buffers](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/buffers.html) | `src/kev/reader.ts` |
| `traceprinter` | [traceprinter](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/t/traceprinter.html), [Using traceprinter](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/datainterpretation_Using_traceprinter.html) | `src/kev/traceprinter.ts`, `test/conformance.test.ts` |
| Trace event classes | [classes and events](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_Classes.html), [kernel call table](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/kercall_table.html) | `src/kev/constants.ts`, `src/model/model.ts` |
| `TraceEvent()` and `trace_logf()` user events | [TraceEvent()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/t/traceevent.html), [trace_logf()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/t/trace_logf.html), [user class](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_User_class.html) | `samples/src/*.c`, `src/detect/deadline.ts` |
| SCHED_FIFO priorities, `ThreadCtl()` runmask | [pthread_setschedparam()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_setschedparam.html), [ThreadCtl()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/t/threadctl.html) | `samples/src/ll_common.h` |
| Mutex protocols (priority inheritance) | [pthread_mutexattr_setprotocol()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprotocol.html), [pthread_mutexattr_init()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_init.html) | `samples/src/brakesim.c`, `src/detect/inversion.ts` |
| Interrupt service threads (no ISRs in 8.0) | [InterruptAttachThread()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/i/interruptattachthread.html), [InterruptWait()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/i/interruptwait.html), [interrupt class](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_Interrupt_class.html) | `samples/src/sensor_ist.c`, `src/detect/ist.ts` |
| Message passing | [MsgSend()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgsend.html), [name_attach()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/n/name_attach.html), [ChannelCreate()](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html), [communication class](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.sat/topic/events_Communication_class.html) | `samples/src/send_chain.c`, `src/detect/chain.ts` |

## SDP 8.0, `qcc` and `mkqnximage`

- The SDP was installed in the build session with the QNX Software Center command line
  (`qnxsoftwarecenter_clt -mirror -cleanInstall -installBaseline com.qnx.qnx800`), baseline 8.0.0.00141:
  microkernel 2.8.0, `qcc` 8.0.0 with gcc 12.2.0, `mkqnximage` 0.6.0. Nothing from the SDP is in the repo.
- `samples/Makefile` builds every sample with `qcc -Vgcc_ntox86_64`; `brakesim-fixed` is the same source
  built with `-DLOG_LOCK_PROTOCOL=PTHREAD_PRIO_INHERIT`.
- `scripts/qnx-vm.sh image` runs `mkqnximage --type=qemu --arch=x86_64 --hostname=latencylens --ssh-ident=...`
  unchanged; `scripts/qnx-vm.sh start` boots it in QEMU (TCG, user-mode networking, ssh on port 2222).
  The target reports `QNX latencylens 8.0.0 2026/10/30-09:10:05EDT x86pc x86_64`.

## Kernel event tracing: `tracelogger`, `.kev`, `traceprinter`

- **Capture.** `samples/target/capture.sh` starts `tracelogger -w -k 32 -b 128 -s <seconds> -f /dev/shmem/<name>.kev`
  and then the workload. Wide mode (`-w`) is what makes thread events carry priority and policy and kernel
  calls carry their arguments, which the detectors depend on. The stress capture uses `-k 96`: with 32
  kernel buffers the first attempt dropped 7 buffers, and the reader reports `CONTROL` drop events as a
  warning.
- **Binary reader.** `src/kev/reader.ts`, `readKev()`: the `TRACE_<KEY>::<value>` header attributes
  (`parseHeaderAttrs()`), the system page, then 16-byte `traceevent_t` slots in per-CPU buffers that are
  merged by 64-bit time (`CONTROL:TIME` supplies the high 32 bits). Combine events (`CB`, `CC`, `CE`) are
  reassembled; `decodeFields()` decodes per class and event the fields traceprinter shows. Event names and
  kernel call numbers are in `src/kev/constants.ts` (`kerCallName()`, `eventLabel()`).
- **traceprinter as the contract.** The SAT guide calls `traceevent_t` partly opaque and points to
  libtraceparser and traceprinter. `src/kev/traceprinter.ts`, `readTraceprinter()`, reads traceprinter's
  text directly (`latencylens ... --decoder traceprinter` runs the SDP tool via `findTraceprinter()` in
  `src/kev/load.ts`). `test/conformance.test.ts` checks the binary reader against the stored traceprinter
  output of every committed trace, event by event and field by field; `test/stress.test.ts` checks the
  1,268,250-event capture against traceprinter's per-type counts.
- **Classes used** (all in `src/model/model.ts`, `buildModel()`): `THREAD` state changes (with priority),
  `KER_CALL`/`KER_EXIT` (`SyncMutexLock`, `SyncMutexUnlock`, `SyncCondvarWait`, `MsgSendv`, `MsgReceivev`,
  `MsgReplyv`, `MsgError`, `InterruptAttachThread`, `InterruptWait`, `TimerTimeout`), `COMM` (message and
  pulse events), `INT` (interrupt entry and exit per CPU), `PROCESS` (process and thread names), `CONTROL`
  (time, buffers, drops), `SYSTEM` (IPIs) and `USER` (job markers and notes).

## `TraceEvent()` user events

- The samples mark each periodic job: `TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, 100, seq, late_us)` when a
  job starts and `TraceEvent(_NTO_TRACE_INSERTSUSEREVENT, 101, seq, resp_us)` when it ends
  (`brake_ctl()` in `samples/src/brakesim.c`, `periodic_thread()` in `samples/src/cpu_hog.c`, the request
  loop in `samples/src/send_chain.c`). `trace_logf(110, ...)` notes record the run's settings.
- `src/detect/deadline.ts`, `jobsForThread()`: jobs come from these markers when a thread logs them, else
  from the thread's own state changes; `deadlines.yaml` can rename the marker codes.

## SCHED_FIFO, `ThreadCtl()`, mutex protocols

- `ll_self()` in `samples/src/ll_common.h` sets `SCHED_FIFO` and a priority with `pthread_setschedparam()`
  and names the thread (the name reaches the trace); `ll_pin_cpu()` pins a thread with
  `ThreadCtl(_NTO_TCTL_RUNMASK, ...)` so the scenarios are deterministic.
- `samples/src/brakesim.c`: brake_ctl (63), telemetry (30) and logger (10) share CPU 0; the log mutex is
  created with `pthread_mutexattr_setprotocol(&ma, LOG_LOCK_PROTOCOL)`. `PTHREAD_PRIO_NONE` plants the
  inversion; `PTHREAD_PRIO_INHERIT` (the QNX default) fixes it.
- `src/detect/inversion.ts`, `detectInversions()`: a high-priority waiter in `STATE_MUTEX` (or REPLY), the
  holder taken from the owner word that `SyncMutexLock` logs (`((pid & 0x7fff) << 16) | tid` on 8.0,
  `ownerKey()` in `src/model/model.ts`), and a medium-priority thread running on the holder's CPU while the
  holder was ready. In the fixed trace the logger runs at 63 while brake_ctl waits: the inheritance itself
  is visible in the `THREAD` events' priority field.

## Interrupt service threads

- `adc_ist()` in `samples/src/sensor_ist.c`: `ThreadCtl(_NTO_TCTL_IO_LEVEL, ...)`,
  `InterruptAttachThread(8, _NTO_INTR_FLAGS_END)` on the RTC interrupt (programmed for 512 Hz through the
  CMOS ports), then `InterruptWait(_NTO_INTR_WAIT_FLAGS_UNMASK, NULL)` in a loop. QNX OS 8.0 has no ISRs;
  the IST is the handler.
- `src/detect/ist.ts`, `detectIstLatency()`: binds each IST to its interrupt from the
  `InterruptAttachThread` kernel call (or infers it from consistent wakeups), then measures interrupt entry
  on a CPU to the IST running, and names the threads that held the CPU. procnto's clock ISTs attach with
  `_NTO_INTR_FLAGS_CPU_LOCAL`, so only deliveries on their own CPU count.

## Message passing

- `samples/src/send_chain.c`: hmi, route_planner, nav_server, map_db and flash_io are separate processes;
  servers use `name_attach()` and `MsgReceive()`/`MsgReply()` (`serve()`), clients `name_open()` and
  `MsgSend()` (`run_route_planner()`, `nav_handle()`, `map_handle()`).
- `src/model/model.ts` matches `MsgSendv` to the server's `MsgReceivev` and `MsgReplyv` by
  (server pid, rcvid); the timeline draws the send-to-receive and reply arrows (`web/src/timeline.ts`).
  `src/detect/chain.ts`, `detectChains()`, follows SEND/REPLY-blocked waits from client to server to the
  server's own server and reports the chain and where the time went.

## What the tool outputs for QNX

- `latencylens report trace.kev --deadlines deadlines.yaml --format md|json|text|summary` (exit status 1
  on a missed deadline, for CI), `latencylens open trace.kev` (timeline and findings in the browser),
  `latencylens explain` (checked AI explanation), `latencylens info` and `latencylens dump` (the decoded
  events, in traceprinter's vocabulary).
