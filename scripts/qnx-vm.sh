#!/usr/bin/env bash
# qnx-vm.sh: build and drive a QNX OS 8.0 x86_64 virtual machine in QEMU for capturing kernel traces.
#
# The image itself is produced by the SDP's own mkqnximage. We only replace the run step: the stock
# runimage script wants a host network bridge (root, brctl, dnsmasq), so we start QEMU with user-mode
# networking and forward a host port to the guest's sshd instead. That works on any Linux host,
# inside containers, and without KVM (QEMU falls back to TCG).
#
# Usage:
#   scripts/qnx-vm.sh image          build the image in $QNX_VM_DIR with mkqnximage
#   scripts/qnx-vm.sh start          boot the VM in the background and wait for ssh
#   scripts/qnx-vm.sh stop           power the VM off
#   scripts/qnx-vm.sh status         print whether the VM is running
#   scripts/qnx-vm.sh ssh [cmd...]   run a command on the target as root (interactive without cmd)
#   scripts/qnx-vm.sh put <local> <remote>   copy a file to the target
#   scripts/qnx-vm.sh get <remote> <local>   copy a file from the target
#
# Environment:
#   QNX_SDP      SDP install dir (default ~/qnx800); its qnxsdp-env.sh is sourced for mkqnximage
#   QNX_VM_DIR   image directory (default ~/qnxvm)
#   QNX_VM_PORT  host port forwarded to the guest's port 22 (default 2222)
#   QNX_VM_CPUS  virtual CPUs (default 2), QNX_VM_RAM (default 1G)
#   QNX_VM_KEY   ssh private key whose .pub is baked into the image (default ~/.ssh/qnxvm_ed25519)
#   QNX_VM_CPU_MODEL  QEMU -cpu model when running under TCG (default max,-avx,-avx2)
#   QNX_VM_ICOUNT=1   run TCG with -icount (deterministic guest timing, see cmd_start)
set -euo pipefail

QNX_SDP="${QNX_SDP:-$HOME/qnx800}"
QNX_VM_DIR="${QNX_VM_DIR:-$HOME/qnxvm}"
QNX_VM_PORT="${QNX_VM_PORT:-2222}"
QNX_VM_CPUS="${QNX_VM_CPUS:-2}"
QNX_VM_RAM="${QNX_VM_RAM:-1G}"
QNX_VM_KEY="${QNX_VM_KEY:-$HOME/.ssh/qnxvm_ed25519}"
# CPU model for TCG. Plain "max" advertises AVX2, and OpenSSL's AVX2 code path faults under TCG, which
# kills sshd at boot. The 8.0 startup code needs x2APIC-era features, so older models (Nehalem) hang.
QNX_VM_CPU_MODEL="${QNX_VM_CPU_MODEL:-max,-avx,-avx2}"

SSH_OPTS=(-i "$QNX_VM_KEY" -p "$QNX_VM_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15)
SCP_OPTS=(-i "$QNX_VM_KEY" -P "$QNX_VM_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=10)

die() { echo "qnx-vm: $*" >&2; exit 1; }

pidfile() { echo "$QNX_VM_DIR/output/qemu.pid"; }

running() {
  local pf; pf="$(pidfile)"
  [[ -f "$pf" ]] && kill -0 "$(cat "$pf")" 2>/dev/null
}

cmd_image() {
  [[ -f "$QNX_SDP/qnxsdp-env.sh" ]] || die "no SDP at $QNX_SDP (set QNX_SDP)"
  # shellcheck disable=SC1091
  source "$QNX_SDP/qnxsdp-env.sh" >/dev/null
  if [[ ! -f "$QNX_VM_KEY" ]]; then
    mkdir -p "$(dirname "$QNX_VM_KEY")"
    ssh-keygen -q -t ed25519 -N '' -f "$QNX_VM_KEY"
  fi
  mkdir -p "$QNX_VM_DIR"
  cd "$QNX_VM_DIR"
  mkqnximage --type=qemu --arch=x86_64 --cpu="$QNX_VM_CPUS" --ram="$QNX_VM_RAM" \
    --hostname=latencylens --ssh-ident="$QNX_VM_KEY.pub" --data-size=512 --noprompt
}

cmd_start() {
  [[ -f "$QNX_VM_DIR/output/ifs.bin" ]] || die "no image in $QNX_VM_DIR, run: $0 image"
  if running; then echo "qnx-vm: already running (pid $(cat "$(pidfile)"))"; return 0; fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$QNX_VM_PORT") 2>/dev/null; then
    die "port $QNX_VM_PORT is already in use (another VM?); stop it or set QNX_VM_PORT"
  fi
  local accel=(-accel tcg,thread=multi -cpu "$QNX_VM_CPU_MODEL")
  if [[ "${QNX_VM_ICOUNT:-0}" != 0 ]]; then
    # Instruction counting: guest time advances with executed instructions, so host scheduling
    # hiccups never show up as guest latency. Single-threaded TCG, but timing is reproducible.
    accel=(-accel tcg,thread=single -icount "shift=${QNX_VM_ICOUNT_SHIFT:-auto},sleep=on" -cpu "$QNX_VM_CPU_MODEL")
  fi
  if [[ -w /dev/kvm ]]; then accel=(-enable-kvm -cpu host); fi
  cd "$QNX_VM_DIR"
  rm -f output/serial.log
  qemu-system-x86_64 "${accel[@]}" -smp "$QNX_VM_CPUS" -m "$QNX_VM_RAM" \
    -drive file=output/disk-qemu.vmdk,if=ide,id=drv0 \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${QNX_VM_PORT}-:22" \
    -device virtio-net-pci,netdev=net0,mac="$(grep -oP "^OPT_MACADDR='\K[^']+" output/options || echo 52:54:00:12:34:56)" \
    -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0 \
    -kernel output/ifs.bin \
    -display none \
    -chardev socket,id=ser0,path=output/serial.sock,server=on,wait=off,logfile=output/serial.log \
    -serial chardev:ser0 \
    -monitor unix:output/monitor.sock,server=on,wait=off \
    -pidfile output/qemu.pid -daemonize
  echo "qnx-vm: booting (pid $(cat "$(pidfile)")), serial log: $QNX_VM_DIR/output/serial.log"
  local t0=$SECONDS
  until ssh "${SSH_OPTS[@]}" root@127.0.0.1 true 2>/dev/null; do
    (( SECONDS - t0 > 600 )) && die "timed out waiting for ssh; see $QNX_VM_DIR/output/serial.log"
    sleep 3
  done
  echo "qnx-vm: ssh ready after $((SECONDS - t0)) s"
}

cmd_stop() {
  if ! running; then echo "qnx-vm: not running"; return 0; fi
  ssh "${SSH_OPTS[@]}" root@127.0.0.1 'shutdown -b' >/dev/null 2>&1 || true
  sleep 5
  if running; then
    # monitor 'quit' powers QEMU off immediately
    if command -v socat >/dev/null; then echo quit | socat - "UNIX-CONNECT:$QNX_VM_DIR/output/monitor.sock" >/dev/null 2>&1 || true; fi
    sleep 1
    running && kill "$(cat "$(pidfile)")" 2>/dev/null || true
  fi
  rm -f "$(pidfile)"
  echo "qnx-vm: stopped"
}

cmd_status() { if running; then echo "running (pid $(cat "$(pidfile)"))"; else echo "stopped"; fi; }

cmd_ssh() { exec ssh "${SSH_OPTS[@]}" root@127.0.0.1 "$@"; }

cmd_put() { [[ $# -eq 2 ]] || die "usage: put <local> <remote>"; scp -q -O "${SCP_OPTS[@]}" "$1" "root@127.0.0.1:$2"; }

cmd_get() { [[ $# -eq 2 ]] || die "usage: get <remote> <local>"; scp -q -O "${SCP_OPTS[@]}" "root@127.0.0.1:$1" "$2"; }

sub="${1:-}"; shift || true
case "$sub" in
  image) cmd_image "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  ssh) cmd_ssh "$@" ;;
  put) cmd_put "$@" ;;
  get) cmd_get "$@" ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac
