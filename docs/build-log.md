# Build log

Decisions and problems, newest first. Everything here happened in one cloud session on an x86_64
Linux container (4 vCPUs, no KVM) with QNX SDP 8.0 installed through the QNX Software Center CLI.

## 2026-11-23: detectors, and what real traces taught them

- **Mutex holder from the owner word.** `SyncMutexLock` enter logs the mutex's owner word; on 8.0 it
  is `((pid & 0x7fff) << 16) | tid` with bit 31 set when there are waiters. The holder's own
  `SyncMutexUnlock` confirms it. Condvar waiters re-acquire their mutex inside the kernel (no
  `SyncMutexLock`), so the mutex address comes from `SyncCondvarWait`.
- **Message matching.** rcvids are local to the server process: keying by rcvid alone mixed up
  map_db's and nav_server's requests. Now keyed by (server pid, rcvid), oldest first. `info->pid/tid`
  in the `MsgReceive` exit are 0 when the server passes no info buffer (our samples, and many real
  servers), so they are only used when non-zero. A client that leaves SEND/REPLY without being
  received or replied to (timeout, unblock) closes its transaction, otherwise the next request on the
  same rcvid matched the abandoned one (that produced a phantom 1 s "deadlock" in the USB stack).
- **Deferred replies end a chain.** procnto keeps the rcvid of a `waitpid()` and replies when the
  child exits; between its `MsgReceive` calls it serves others. A REPLY-blocked client waits on the
  server thread only until that thread calls `MsgReceive` again.
- **Chains are reported from 3 occurrences per client** (`chain_min_count`). Every trace has one-off
  chains while programs start (procnto loading an executable from devb-eide). They are listed in the
  report's notes, not hidden.
- **IST bindings.** procnto's clock ISTs attach with `_NTO_INTR_FLAGS_CPU_LOCAL` (0x80): only
  deliveries on their own CPU count. A sample counts only if the delivery actually woke the IST
  (within 200 us), and inference of IST bindings skips kernel threads.
- **Platform latency is not blamed on threads.** Under strict priority scheduling a lower-priority
  thread cannot keep a higher-priority one off the same CPU. When a ready IST or job "waited" while
  only lower-priority threads (or nothing) ran, the delay is outside the schedule (an emulator stall
  here). Those cases are notes, and the deadline detector names a late timer that starts a backlog.
- **The detectors found three design flaws in my own first baseline**, which is now fixed:
  the IST ran on CPU 1 while the RTC interrupt is delivered on CPU 0 (every wakeup needed an IPI,
  up to 3.1 ms under TCG); the IST at 70 queued behind the samples' main threads, also at 70
  (equal-priority FIFO); and hmi at 55 delayed io-sock's network IST at 21. The baseline now runs the
  IST at 75 on CPU 0 and hmi at 20. One capture in between hit a 44.5 ms timer stall of the emulator;
  the detector traced brake_ctl's three misses to it and said so.
- Analysis of the 20k to 63k event sample traces takes 40 to 170 ms in total (parse, model, detect).

## 2026-11-23: million-event stress trace

- `samples/target/run-stress.sh` runs the inversion, the IST and a 1 ms request loop through the server
  chain for 18 s. Captured with `tracelogger -w -k 96`: **1,268,250 events, 0 dropped**, 49 MB raw,
  12.2 MB gzipped (`samples/traces/stress.kev.gz`). The first attempt with `-k 32` dropped 7 buffers
  (`CONTROL:DROPPED`), so the reader reports drops as a trace-quality warning.
- Too large to keep traceprinter's text (about 170 MB), so `scripts/traceprinter-summary.mjs` stores
  per-event-type counts from traceprinter; the reader's counts must match them exactly.

## 2026-11-23: emulation noise, and how the samples and detectors deal with it

Measured inside the guest with small probes (QEMU 8.2 TCG, no KVM, inside a Firecracker microVM):

- **Guest RDTSC is serialised by TCG.** Two CPUs polling `ClockCycles()` back to back stalled each
  other 48.8% of the time (gaps over 20 us). Doing about 1 us of arithmetic between polls drops that to
  1.3%. `ll_burn_ns()` in `samples/src/ll_common.h` does exactly that.
- **Timer wakeups have a tail.** Timers round up to the next 1 ms tick (the tick phase against
  CLOCK_MONOTONIC changes from boot to boot; `ClockPeriod()` cannot change it on 8.0: "Not
  supported"). On top of that about 5% of wakeups arrive 0.5 to 7 ms late. Same with 1 vCPU, with QEMU
  at SCHED_FIFO on the host, and with no host load, so it is not contention we can remove. The host
  shows 0.2 to 0.3% steal time from the outer hypervisor. `-icount shift=auto` was worse (spread up to
  16 ms, 15x slower), so we stay on multi-threaded TCG.
- **Decision: a job's response time starts at the later of its nominal release and its actual
  wakeup.** Timer lateness belongs to the platform, not to the job; a job that starts late because
  its predecessor overran keeps its nominal release. `brakesim` measures itself the same way, so its
  own printout agrees with Latency Lens. The begin marker still records the lateness.
- **Decision: planted problems are large compared to the noise.** `brakesim` became a 50 Hz loop with
  a 15 ms deadline against a 30 ms telemetry burst. Six fixed runs: 0 misses, worst 3.8 to 11.3 ms.
  Buggy runs: 31 to 39 misses per 150 jobs, worst 35 to 50 ms.
- A warm-up pass (`ll_warmup()`) before the first release removes the first-execution penalty of TCG.

## 2026-11-23: QEMU without a bridge, and a CPU model that boots and runs sshd

- mkqnximage's `runimage` wants a host bridge (root, brctl, dnsmasq). `scripts/qnx-vm.sh` keeps the
  mkqnximage image unchanged and starts QEMU itself with user-mode networking and a forwarded ssh port,
  plus the serial console on a unix socket (`scripts/qnx-serial.py` drives it).
- With `-cpu max` (what runimage uses without KVM) sshd died at boot with "Memory fault". Debugging
  from the serial console: `sshd -d` died right after printing the OpenSSL version, and
  `OPENSSL_ia32cap=~0x0:~0x20` (mask AVX2) fixed it, so OpenSSL's AVX2 path faults under TCG. The VM
  now uses `-cpu max,-avx,-avx2`. `-cpu Nehalem` never printed anything (the 8.0 startup needs newer
  features).

## 2026-11-23: what the .kev file looks like on QNX 8.0 (and which reader is "the" reader)

- Reverse-checked against the SDP's own `traceprinter` on our first capture:
  `TRACE_<KEY>::<value>` header strings back to back (tracelogger forbids `TRACE_` and `::` in
  values, which makes this unambiguous), then `TRACE_SYSPAGE_LEN` bytes of system page, then 16-byte
  `traceevent_t` slots. Slots come in per-CPU 16 KB buffers (`CONTROL:TIME`, `CONTROL:BUFFER`, ...,
  `CONTROL:BUFFER_END` with the 0xe6e6e6e6 cookie), written in completion order, so the reader merges
  the CPUs by 64-bit time. Combine events (CB, CC, CE) share one timestamp; wide thread events are a
  CB (pid, tid) and CE (priority, policy) pair. Kernel call events: bits 0-6 call number, bit 7 exit,
  bit 9 64-bit argument layout.
- **Decision.** The QNX 8.0 SAT guide calls `traceevent_t` "partly opaque" and points custom parsers
  at libtraceparser, with traceprinter as the plain-text interface. We treat traceprinter's output as
  the contract: (1) Latency Lens reads traceprinter text directly (`--decoder traceprinter`, or a
  `.txt` file), and (2) the built-in binary reader, which lets anyone open the committed traces
  without the SDP and is several times faster, is tested event by event against traceprinter's
  rendering of every committed trace (`samples/traces/*.traceprinter.txt.gz`). If they ever
  disagree, traceprinter wins and the test fails.

## 2026-11-23: SDP 8.0 install with qnxsoftwarecenter_clt

- Steps 1 to 4 of the brief worked as written (installer MD5 matched; license activated).
- `-installBaseline com.qnx.qnx800` alone failed ("run with -mirrorBaseline first"); after
  `-mirrorBaseline com.qnx.qnx800` it failed again (`com.qnx.qnx800.target` missing: only 19 root
  units were mirrored). `-mirror -cleanInstall -installBaseline com.qnx.qnx800 -destination ~/qnx800`
  in one invocation mirrored the full metadata and installed 3.6 GB in 101 s.
- Installed: baseline 8.0.0.00141 with auto-applied updates; microkernel core 2.8.0 (built
  2026-10-30), qcc 8.0.0 with gcc 12.2.0, mkqnximage 0.6.0. Target reports
  `QNX 8.0.0 2026/10/30-09:10:05EDT x86pc x86_64`.
- `-listAccessible` and `-list` fail with a NullPointerException until something has been mirrored.
