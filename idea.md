# Latency Lens: project brief

Build **Latency Lens**, a host-side tool that turns QNX kernel event traces into a timeline you can read and finds why a
real-time deadline was missed (priority inversion, a long interrupt, a blocked send), then explains it in plain words with
evidence. Entry for the QNX Global Hackathon, plus a codelab for the tutorial bonus. Read this whole brief first; it is the
only context you get. Do everything in this session: install the QNX toolchain, build, boot QNX in QEMU to capture real
traces, test, record and render the video.

## 1. The hackathon

- QNX Global Hackathon (Devpost `qnx`). Deadline **Tue Dec 15 2026, 11:00 AM PT**. Category: **Developer Tooling &
  Host Tools** ($4,000 best, $2,000 runner-up). Also targets the bonus **Best Codelab / Tutorial ($3,500)**. Grand prize
  $10,000; 3 honorable mentions at $1,000.
- Judging criteria (equal weight):
  - **Technological Implementation**: how well it is built and how effectively it uses QNX 8.0; real engineering, a
    working non-trivial implementation that genuinely builds for or supports QNX.
  - **Design**: a complete, coherent product experience, not just a proof of concept.
  - **Potential Impact**: a credible case for a real problem in a market QNX serves, and why real-time matters.
  - **Innovation & AI Creativity**: a creative, non-obvious approach and genuine understanding of the problem space.
- Host tools are explicitly eligible when they clearly support QNX 8.0 development: the submission must point reviewers
  to the QNX-specific inputs, outputs and code.
- Submission needs: a public repo with an open-source license (AGPL-3.0) and build and run instructions naming the QNX
  version, the target (QEMU) and the toolchain; a public YouTube video under 3 minutes; the codelab URL in its own field.
- Serious, engineer-grade tone in the tool and README. The codelab may be friendlier (see 2.5).

## 2. The product

**The problem.** When a real-time system on QNX misses a deadline, engineers capture a kernel event trace and then
spend hours scrolling through thousands of events to find the cause. The trace has the answer; reading it is the hard
part.

### 2.1 Input

- Traces captured on QNX 8.0 with `tracelogger` (`.kev` files). Parse them either through `traceprinter` output from
  the SDP's host tools or with your own parser of the documented binary format; prefer whichever the QNX 8.0 docs
  describe as stable, and record the choice in `docs/build-log.md`.
- An optional `deadlines.yaml` naming the periodic threads and their periods and deadlines.

### 2.2 The timeline

A local web UI (`latencylens open trace.kev`): one lane per CPU and per thread, thread states (running, ready,
blocked on send, receive, reply, mutex), interrupts, and message-passing arrows from `MsgSend` to `MsgReceive` to
`MsgReply`. Zoom from seconds to microseconds smoothly, even on a trace with a million events.

### 2.3 The detectives (deterministic code)

Each detector outputs findings with the exact event range as evidence:

- **Deadline miss**: a periodic thread finished late; show its period, release, start and finish.
- **Priority inversion**: a high-priority thread blocked on a mutex or a reply held by a lower-priority thread that was
  preempted by a medium one.
- **Long interrupt or IST latency**: from interrupt to the handling thread running.
- **Send-blocked chains**: thread A waits on B, which waits on C, and so on.
- **CPU hog**: a thread that monopolised a core during the window.

Click a finding to jump the timeline to it and highlight the involved threads.

### 2.4 The explanation (Innovation & AI Creativity)

"Explain this" sends the finding and only its evidence events to an LLM (W&B Inference, OpenAI-compatible, model
`Qwen/Qwen3.8-27B`, fallback `zai-org/GLM-5.3-Flash`) and shows a plain-language cause and a suggested fix, for
example "the logger thread (priority 10) held `/dev/shmem` lock 4.1 ms while the brake thread (priority 63) waited;
use a priority-inheritance mutex or move logging off the hot path". Every thread name, priority and duration the model
mentions is checked against the evidence by code, and the UI marks any claim that does not match. The tool works fully
without a key; the AI is an addition.

Also a CLI: `latencylens report trace.kev --deadlines deadlines.yaml --format md` for CI pipelines, with a non-zero exit
code when a deadline is missed.

### 2.5 The codelab (bonus prize)

`codelab/`: a step-by-step tutorial in the style of https://qnx.github.io/codelabs/, published to the repo's GitHub
Pages: "Find a priority inversion on QNX in 20 minutes". The reader builds a small bug-ridden program, captures a trace
with `tracelogger` on QNX in QEMU, opens it in Latency Lens, finds the inversion, fixes it with a priority-inheritance
mutex, and captures a clean trace. Each step has the exact commands and expected output. A small friendly capybara
illustration (drawn as SVG in code) may guide the reader in the codelab only; nowhere else.

### 2.6 Sample workloads

`samples/` holds small QNX programs that reproduce each problem the detectors find (inversion, long ISR-style latency,
send chains, CPU hog, a clean baseline). Run them on QNX 8.0 in QEMU in this session, capture real traces with
`tracelogger`, and commit the `.kev` files (they are your own output, not SDP files) so judges can open them without
QNX.

## 3. QNX technology to use (and show)

Verify each item in the QNX 8.0 docs (https://www.qnx.com/developers/docs/8.0/) before relying on it, and record what
you used and where in `docs/qnx-features.md`.

- QNX kernel event tracing: `tracelogger`, the trace event classes and the `.kev` format, `traceprinter`, and the
  trace control API (`TraceEvent()`) for user events in the samples.
- Neutrino message passing, mutexes (including priority inheritance), interrupt service threads (ISRs are gone in
  8.0), SCHED_FIFO priorities: in the sample workloads and as the vocabulary of the detectors.
- `qcc` for the samples; `mkqnximage` for the QEMU x86_64 image used to capture traces.
- Optional stretch: a panel in the QNX Toolkit for VS Code workflow (an extension command "Open in Latency Lens"),
  only after everything else works.

## 4. Setting up QNX in this session

Credentials for the free non-commercial license are in your environment as `MYQNX_USER` and `MYQNX_PASSWORD` (see the
paste message). The license is already deployed to that account. Verified install steps on Linux:

1. `curl --cookie-jar ~/.qnx/myqnxcookies.auth --form "userlogin=$MYQNX_USER" --form "password=$MYQNX_PASSWORD" -X POST https://www.qnx.com/account/login.html -o /dev/null`
2. `curl -L --cookie ~/.qnx/myqnxcookies.auth https://www.qnx.com/download/download/79441/qnx-setup-2.0.4-202501021438-linux.run -o qnx-setup-lin.run`
   (MD5 must be `bca161a97ab3e14189cf8e7c8227fb7d`)
3. `chmod a+x qnx-setup-lin.run && ./qnx-setup-lin.run force-override disable-auto-start agree-to-license-terms ~/qnxinstall`
4. `~/qnxinstall/qnxsoftwarecenter/qnxsoftwarecenter_clt -syncLicenseKeys -myqnx.user="$MYQNX_USER" -myqnx.password="$MYQNX_PASSWORD" -activateAll -listLicenseKeys`
5. Install the SDP 8.0 baseline with `qnxsoftwarecenter_clt -installBaseline <id> -destination ~/qnx800` (the baseline
   id is probably `com.qnx.qnx800`; confirm it with the tool) plus what `mkqnximage`, QEMU and tracing need. Then
   `source ~/qnx800/qnxsdp-env.sh`.

**License rules you must follow:**
- The license allows **at most two activated machines at a time**, and another session may be using one. **Before
  you end this session, run `qnxsoftwarecenter_clt -myqnx.user=... -myqnx.password=... -deactivateAll`**, and
  reactivate next time. If activation fails because the limit is reached, say so in your reply and stop.
- Never commit anything from the SDP (headers, libraries, binaries, images) or the license key. `.kev` traces you
  captured and your own source are fine.
- Use the software only for this non-commercial hackathon project.

Install QEMU in the session (`apt-get install qemu-system-x86`); use KVM if `/dev/kvm` exists, otherwise TCG.

## 5. Engineering rules

- The tool in TypeScript (pnpm) or Rust, your choice; the samples in C with `qcc`. Parsing and detectors must be fast
  (a million-event trace analysed in seconds).
- Tests: parser tests against the committed sample traces; one test per detector that must find its planted problem
  and must not fire on the clean baseline; a test that the AI claim checker rejects a wrong number.
- Git identity `chinesepowered <22500229+chinesepowered@users.noreply.github.com>`, no Co-Authored-By lines; commit
  and push to `main` after every working milestone. Add `LICENSE` (AGPL-3.0).
- No em dashes anywhere. Keys only in `.env` (git-ignored); check the full history for keys before the final push.
- Keep `docs/build-log.md` (decisions, problems, newest first) and `docs/needs-user.md` (only what truly needs the
  owner).

## 6. Deliverables

1. The tool (web UI and CLI), the samples, the captured traces and tests.
2. `README.md` written for judges in this order: a 3-4 sentence summary with the video link on its own line; the
   problem and our solution; a table of the QNX technologies used (technology, what it does here, file); a short
   section per technology pointing to files and functions; an architecture diagram (Mermaid); build and run
   instructions (QNX SDP 8.0, QEMU x86_64, `qcc` toolchain); what each detector finds in the sample traces. Never open
   with "Inspiration".
3. `docs/devpost.md` in the same order (text diagram instead of Mermaid), plus answers for the form: build and run
   instructions; "how the project meets the main technology requirement" naming each QNX product and the exact files,
   functions and outputs; AI tools used (Claude Code, W&B Inference with Qwen, ElevenLabs).
4. The codelab, published to GitHub Pages from `codelab/` (the owner turns Pages on when the repo goes public; put
   the expected URL in `docs/devpost.md`).
5. `demo/video.mp4`: under 2:45, 1920x1080, H.264, recorded in this session: capture on QNX in QEMU, open in Latency
   Lens, the finding, the explanation, the fix, the clean trace. Narration by ElevenLabs voice **Jessica**
   (`cgSgspJ2msm6clMCkdW9`, model `eleven_multilingual_v2`, a young female voice); keep ElevenLabs use under 6,000
   characters. No copyrighted music.
6. `demo/thumb.png` and 5 or 6 stills in `docs/screenshots/`.

## 7. Timeline

Real traces captured and the timeline working by **Mon Dec 7**; detectors, AI explanation and codelab by **Thu Dec
10**; video and docs by **Fri Dec 11**. The owner submits by Dec 14.
