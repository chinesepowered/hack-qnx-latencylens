# Latency Lens: Devpost submission

Text for the QNX Global Hackathon form. Category: **Developer Tooling & Host Tools**; also entered for
**Best Codelab / Tutorial**.

- **Project name:** Latency Lens
- **Tagline:** Find why a QNX real-time thread missed its deadline: a kernel trace timeline, five
  deterministic detectors, and AI explanations checked against the trace.
- **Video:** VIDEO_URL (the file is `demo/video.mp4` in the repository, 2:22)
- **Codelab URL:** https://chinesepowered.github.io/hack-qnx-latencylens/
- **Repository:** https://github.com/chinesepowered/hack-qnx-latencylens (AGPL-3.0)

---

## About the project

Latency Lens reads QNX OS 8.0 kernel event traces (`.kev` files from `tracelogger`) and tells you why a
real-time deadline was missed: a priority inversion, an interrupt service thread held off its CPU, a
request stuck in a chain of message-passing servers, or a thread hogging a core, each with the exact
kernel events as evidence. It shows the trace as a timeline that zooms from seconds to microseconds,
smoothly even with a million events, and can ask an LLM to explain a finding in plain words while code
checks every thread, priority and duration the model mentions against the trace. It runs on the host as
a web UI and a CI-friendly CLI, needs no QNX installation to open a trace, and works fully without an
API key; every trace in the repository was captured on QNX OS 8.0 in QEMU with the QNX SDP 8.0.

Video: VIDEO_URL

### The problem

When a real-time system on QNX misses a deadline, engineers capture a kernel event trace with
`tracelogger` and then scroll through tens of thousands of events looking for the moment a
high-priority thread waited. The answer is in the trace, but finding it takes hours and a solid mental
model of the QNX scheduler, mutex protocols, interrupt service threads and message passing. The classic
bugs are easy to write and hard to see: a lock ported from Linux with `PTHREAD_PRIO_NONE`, an IST that a
busier thread outranks, a client blocked behind a server that is itself blocked on another server.
Automotive, medical and industrial systems on QNX live by these deadlines.

### What Latency Lens does

- **Reads the trace itself**: a native reader for the QNX 8.0 `.kev` format, verified event by event and
  field by field against the SDP's `traceprinter` on every committed trace; it can also read
  traceprinter text directly.
- **Models what the kernel did**: thread states with priorities, CPU occupancy, mutex waits with their
  holder, `MsgSend`/`MsgReceive`/`MsgReply` transactions, interrupt deliveries and the IST each one woke,
  job markers from `TraceEvent()`.
- **Five deterministic detectors** (deadline miss, priority inversion, IST latency, send-blocked chain,
  CPU hog) report findings with evidence events, the worst occurrence and every other occurrence, and
  tell scheduling problems apart from platform latency (an emulator or firmware stall).
- **A timeline UI** (`latencylens open trace.kev`): lanes per CPU and per thread, states, interrupts,
  message arrows; click a finding to jump to its worst occurrence. 16 to 24 ms per frame for the whole
  1.27 million-event trace at 1920x1080, under 1 ms zoomed in.
- **Checked AI explanations**: "Explain this" sends one finding and only its evidence to W&B Inference
  (`Qwen/Qwen3.8-27B`, fallback `zai-org/GLM-5.3-Flash`); code checks every thread name, priority,
  duration, CPU, time and mutex-protocol statement in the answer against the trace and strikes out
  contradictions.
- **A CLI for CI**: `latencylens report trace.kev --deadlines deadlines.yaml --format md` exits with
  status 1 when a deadline was missed.

### QNX technologies used

| QNX technology | What it does here | Files |
| --- | --- | --- |
| QNX SDP 8.0 (`qnxsoftwarecenter_clt`) | Toolchain, image tools and trace tools, installed in the build session | `docs/build-log.md` |
| `qcc` (gcc 12.2.0, `-Vgcc_ntox86_64`) | Builds the five sample workloads for QNX OS 8.0 x86_64 | `samples/Makefile`, `samples/src/*.c` |
| `mkqnximage` and QEMU x86_64 | Builds and boots the QNX OS 8.0 target the traces were captured on | `scripts/qnx-vm.sh` |
| `tracelogger` | Records wide-mode kernel traces of each workload | `samples/target/capture.sh` |
| `.kev` format, trace event classes | Native binary reader and the model of kernel activity | `src/kev/reader.ts`, `src/model/model.ts` |
| `traceprinter` | Reference decoder: alternative input and conformance tests | `src/kev/traceprinter.ts`, `test/conformance.test.ts` |
| `TraceEvent()`, `trace_logf()` | Job markers and run notes | `samples/src/brakesim.c`, `src/detect/deadline.ts` |
| SCHED_FIFO, `ThreadCtl()` runmask | Deterministic real-time scenarios | `samples/src/ll_common.h` |
| Mutex protocols (`PTHREAD_PRIO_INHERIT`) | The planted inversion, its fix, the inversion detector | `samples/src/brakesim.c`, `src/detect/inversion.ts` |
| ISTs (`InterruptAttachThread()`, `InterruptWait()`) | A real IST on the RTC interrupt, the IST detector | `samples/src/sensor_ist.c`, `src/detect/ist.ts` |
| Message passing (`MsgSend()`, `MsgReceive()`, `MsgReply()`, `name_attach()`) | A five-process server chain, the send-chain detector | `samples/src/send_chain.c`, `src/detect/chain.ts` |

**SDP 8.0, qcc, mkqnximage, QEMU.** `samples/Makefile` builds every sample with `qcc -Vgcc_ntox86_64`;
`scripts/qnx-vm.sh image` runs `mkqnximage --type=qemu --arch=x86_64`, `start` boots it in QEMU (TCG
here, KVM when available) with ssh forwarded, `put`/`get`/`ssh` drive it.

**tracelogger and .kev.** `samples/target/capture.sh` runs `tracelogger -w -k 32 -b 128 -s N -f ...`
around a workload. `readKev()` (`src/kev/reader.ts`) parses the header attributes, the system page and
the per-CPU buffers of 16-byte events, merges CPUs by time, reassembles combine events and decodes each
class (`decodeFields()`); 1,268,250 events decode in about 0.55 s.

**traceprinter.** `readTraceprinter()` (`src/kev/traceprinter.ts`) reads its text; `--decoder
traceprinter` runs the SDP tool (`findTraceprinter()`, `src/kev/load.ts`); `test/conformance.test.ts`
compares the native reader with traceprinter on every committed trace.

**Kernel events.** `buildModel()` (`src/model/model.ts`) turns `THREAD` events into state runs with
priorities, `SyncMutexLock`/`SyncMutexUnlock`/`SyncCondvarWait` into mutex waits with their holder (owner
word `((pid & 0x7fff) << 16) | tid`), `MsgSendv`/`MsgReceivev`/`MsgReplyv` into transactions, `INT` events
into deliveries, `InterruptAttachThread` into IST bindings.

**TraceEvent().** `brake_ctl()` in `samples/src/brakesim.c` emits user events 100 and 101 around each
job; `jobsForThread()` in `src/detect/deadline.ts` measures every job from them.

**SCHED_FIFO, mutexes, ISTs, messages.** `ll_self()`/`ll_pin_cpu()` set priorities and runmasks;
`brakesim.c` sets its mutex protocol with `pthread_mutexattr_setprotocol()`; `adc_ist()` in
`sensor_ist.c` uses `InterruptAttachThread()` and `InterruptWait()` on IRQ 8; `send_chain.c` uses
`name_attach()`, `name_open()`, `MsgSend()`, `MsgReceive()`, `MsgReply()`.

### Architecture

```
QNX OS 8.0 target (QEMU x86_64, image built by mkqnximage)
  sample workloads (qcc) --> procnto-smp-instr --> tracelogger -w --> trace.kev
                                                                        |
                                                              qnx-vm get (scp)
                                                                        v
Host: latencylens (TypeScript, Node.js)
  src/kev/reader.ts   native .kev reader  <-- conformance tests -- SDP traceprinter
          |                                                         (src/kev/traceprinter.ts)
  src/model/model.ts  thread states, mutex waits, messages, IST bindings, jobs
          |
  src/detect/         deadline miss, priority inversion, IST latency, send chain, CPU hog
          |                                          |
  latencylens report (md/json/text, exit 1)   latencylens open --> web/ timeline and findings
                                                                      |
                                                        "Explain this" --> W&B Inference (Qwen)
                                                                      --> claim checker (src/explain/claims.ts)
```

### Build and run

See the form answer below.

### What each detector finds in the sample traces

| Trace | Findings |
| --- | --- |
| `inversion.kev` | deadline miss (brake_ctl, 35 of 150 at 15 ms) and priority inversion: brake_ctl (63) waited on logger (10) while telemetry (30) ran |
| `inversion-fixed.kev` | none (`PTHREAD_PRIO_INHERIT`) |
| `ist-latency.kev` | IST latency: adc_ist (40) ran up to 10.8 ms after interrupt 8, held off by video_enc (50) |
| `send-chain.kev` | send-blocked chains: hmi -> nav_server -> map_db -> flash_io (33.0 ms), route_planner -> map_db -> flash_io (13.4 ms) |
| `cpu-hog.kev` | CPU hog: diag_scan (40) held CPU 0 for 430 ms (98%); deadline misses of sensor_poll and can_rx linked to it |
| `baseline.kev` | none |
| `stress.kev.gz` (1,268,250 events) | deadline miss, priority inversion, two send-blocked chains; kernel and platform delays as notes |
| `demo/traces/brakesim.kev` | deadline miss (46 of 150, worst 75.4 ms), priority inversion (29 times, worst 74.4 ms), IST latency of the virtio network IST |
| `demo/traces/fixed.kev` | none: 0 misses, worst 4.56 ms, logger at priority 63 during every wait |

### Challenges

- QEMU without KVM adds timer and stall noise of several milliseconds. We measured it inside the guest,
  sized the planted problems well above it, and taught the detectors to report platform latency as such
  instead of blaming a thread. The detectors also found three real design flaws in our first "clean"
  baseline, which we fixed.
- The `.kev` format is only partly documented, so traceprinter's output became the contract: the native
  reader is tested against it event by event, and traceprinter text is accepted as input.
- LLM answers sound right even when a number is wrong. The claim checker turned that from a risk into a
  visible, testable property.

### What's next

A QNX Toolkit for VS Code command "Open in Latency Lens", SCHED_SPORADIC budget analysis, and traces
from real hardware.

---

## Form answers

### Build and run instructions

Requirements: Node.js 20+ and pnpm. To capture traces: QNX SDP 8.0 (free non-commercial license), QEMU
x86_64, and the SDP's `qcc` toolchain (gcc 12.2.0 for `x86_64`). Target: QNX OS 8.0 x86_64 in QEMU.

```bash
git clone https://github.com/chinesepowered/hack-qnx-latencylens.git
cd hack-qnx-latencylens
pnpm install && pnpm build
node bin/latencylens.mjs open samples/traces/inversion.kev                  # timeline UI, http://127.0.0.1:7878/
node bin/latencylens.mjs report samples/traces/inversion.kev --format md    # exit status 1: deadline missed
pnpm test                                                                   # 36 tests
```

Capture new traces on QNX OS 8.0 in QEMU:

```bash
source ~/qnx800/qnxsdp-env.sh
make -C samples                 # qcc -Vgcc_ntox86_64
scripts/qnx-vm.sh image         # mkqnximage --type=qemu --arch=x86_64
scripts/qnx-vm.sh start         # QEMU x86_64, ssh on port 2222
scripts/capture-samples.sh      # tracelogger -w around each sample, traces back to samples/traces/
```

Optional AI explanations: `OPENAI_BASE_URL=https://api.inference.wandb.ai/v1`, `OPENAI_API_KEY`,
`OPENAI_MODEL=Qwen/Qwen3.8-27B` in `.env`. The codelab gives every step with its expected output.

### How the project meets the main technology requirement

Latency Lens is a host tool for QNX OS 8.0 development: its input is the QNX kernel's own trace format
and every concept it reports is a QNX scheduling concept.

- **QNX SDP 8.0**: installed with `qnxsoftwarecenter_clt` (baseline `com.qnx.qnx800`, 8.0.0.00141);
  steps and problems in `docs/build-log.md`.
- **qcc**: `samples/Makefile` builds `brakesim`, `brakesim-fixed`, `sensor_ist`, `send_chain` and
  `cpu_hog` with `qcc -Vgcc_ntox86_64`.
- **mkqnximage + QEMU x86_64**: `scripts/qnx-vm.sh` (`cmd_image`, `cmd_start`); target output
  `QNX latencylens 8.0.0 2026/10/30-09:10:05EDT x86pc x86_64`.
- **tracelogger**: `samples/target/capture.sh`; outputs are the committed traces in `samples/traces/*.kev`
  and `demo/traces/*.kev` (20k to 55k events each, plus a 1,268,250-event stress capture).
- **.kev format and trace event classes**: `readKev()` and `decodeFields()` in `src/kev/reader.ts`, event
  tables in `src/kev/constants.ts`, the model in `buildModel()` in `src/model/model.ts`.
- **traceprinter**: `readTraceprinter()` in `src/kev/traceprinter.ts`, `findTraceprinter()` in
  `src/kev/load.ts`; reference outputs `samples/traces/*.traceprinter.txt.gz`; `test/conformance.test.ts`
  and `test/stress.test.ts`.
- **TraceEvent() / trace_logf()**: `brake_ctl()` in `samples/src/brakesim.c` (user events 100 and 101),
  consumed by `jobsForThread()` in `src/detect/deadline.ts`.
- **Neutrino priorities, mutexes, ISTs, message passing**: `samples/src/ll_common.h` (`ll_self()`,
  `ll_pin_cpu()`), `samples/src/brakesim.c` (`pthread_mutexattr_setprotocol()`),
  `samples/src/sensor_ist.c` (`adc_ist()`: `InterruptAttachThread()`, `InterruptWait()`),
  `samples/src/send_chain.c` (`serve()`, `MsgSend()`/`MsgReceive()`/`MsgReply()`); detected by
  `detectInversions()` (`src/detect/inversion.ts`), `detectIstLatency()` (`src/detect/ist.ts`),
  `detectChains()` (`src/detect/chain.ts`), `detectHogs()` (`src/detect/hog.ts`) and
  `detectDeadlineMisses()` (`src/detect/deadline.ts`).
- **Outputs**: `latencylens report` (Markdown, JSON, text, one-line summary; exit status 1 on a missed
  deadline), `latencylens open` (timeline and findings), `latencylens explain` (checked explanation).
  `docs/qnx-features.md` links every item to the QNX 8.0 documentation page it was verified against.

### AI tools used

- **Claude Code** built the project in one cloud session: installing the QNX SDP 8.0, booting QNX in
  QEMU, writing the samples, the reader, the detectors, the UI, the tests, the codelab, and recording
  and rendering the video.
- **W&B Inference with Qwen** (`Qwen/Qwen3.8-27B`, fallback `zai-org/GLM-5.3-Flash`) writes the
  plain-language cause and fix behind "Explain this"; Latency Lens checks its claims against the trace.
- **ElevenLabs** (voice Jessica, `eleven_multilingual_v2`) narrates the demo video: 1,936 characters.

### Built with

typescript, node.js, pnpm, html5-canvas, esbuild, vitest, c, qnx-sdp-8.0, qcc, qnx-os-8.0, tracelogger,
traceprinter, mkqnximage, qemu, w&b-inference, qwen, elevenlabs, playwright, ffmpeg
