// Constants of the QNX OS 8.0 kernel trace format, as documented in the System Analysis Toolkit
// User's Guide ("Current Trace Events and Data") and checked against the SDP 8.0 traceprinter.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

/** Internal ("C-class") class numbers stored in bits 10..14 of every event header. */
export const Cls = {
  EMPTY: 0,
  CONTROL: 1,
  KERCALL: 2,
  INT: 3,
  PR_TH: 4, // process and thread events
  SYSTEM: 5,
  USER: 6,
  COMM: 7,
  QUIP: 8,
  SEC: 9,
  QVM: 10,
  PMU: 11,
} as const;

/** Header layout: [31:30] slot structure, [29:24] CPU, [14:10] class, [9:0] event. */
export const STRUCT_S = 0; // simple event, one slot
export const STRUCT_CB = 1; // first slot of a combine event
export const STRUCT_CC = 2; // continuation slot
export const STRUCT_CE = 3; // last slot

export const Control = { TIME: 1, BUFFER: 2, BUFFER_END: 4, DROPPED: 8 } as const;
export const TRACE_COOKIE = 0xe6e6e6e6;

/** Kernel call event codes: bits 0..6 call number, bit 7 exit, bit 9 64-bit argument layout. */
export const KC_EXIT = 0x80;
export const KC_64 = 0x200;
export const KC_NUM_MASK = 0x7f;

/** Thread states (sys/states.h, QNX 8.0). The THREAD class event code is the state entered. */
export const ThreadState = {
  DEAD: 0,
  RUNNING: 1,
  READY: 2,
  STOPPED: 3,
  SEND: 4,
  RECEIVE: 5,
  REPLY: 6,
  MQ_SEND: 7,
  MQ_RECEIVE: 8,
  WAITPAGE: 9,
  SIGSUSPEND: 10,
  SIGWAITINFO: 11,
  NANOSLEEP: 12,
  MUTEX: 13,
  CONDVAR: 14,
  JOIN: 15,
  INTR: 16,
  SEM: 17,
  WAITCTX: 18,
  RWLOCK_READ: 19,
  RWLOCK_WRITE: 20,
  BARRIER: 21,
  PIPE: 22,
  CREATE: 24,
  DESTROY: 25,
  MUON_MUTEX: 26,
  TRACEBUFFER: 27,
  INTR_ATTACH_EV: 28,
  TIMER_DELEGATE: 29,
  SEND_NOTIFY: 30,
} as const;

export const STATE_NAMES: string[] = (() => {
  const names: string[] = [];
  for (const [k, v] of Object.entries(ThreadState)) names[v] = k;
  for (let i = 0; i < 64; i++) if (!names[i]) names[i] = `STATE${i}`;
  return names;
})();

/** Process class events share the PR_TH class with thread states; they use multiples of 64. */
export const Proc = {
  CREATE: 1 << 6,
  DESTROY: 2 << 6,
  CREATE_NAME: 3 << 6,
  DESTROY_NAME: 4 << 6,
  THREAD_NAME: 5 << 6,
} as const;

export const Comm = {
  SMSG: 0,
  SPULSE: 1,
  RMSG: 2,
  RPULSE: 3,
  SPULSE_EXE: 4,
  SPULSE_DIS: 5,
  SPULSE_DEA: 6,
  SPULSE_UN: 7,
  SPULSE_QUN: 8,
  SIGNAL: 9,
  REPLY: 10,
  ERROR: 11,
} as const;

export const COMM_LABELS: Record<number, string> = {
  0: 'SND_MESSAGE',
  1: 'SND_PULSE',
  2: 'REC_MESSAGE',
  3: 'REC_PULSE',
  4: 'SND_PULSE_EXE',
  5: 'SND_PULSE_DIS',
  6: 'SND_PULSE_DEA',
  7: 'SND_PULSE_UN',
  8: 'SND_PULSE_QUN',
  9: 'SIGNAL',
  10: 'REPLY_MESSAGE',
  11: 'MSG_ERROR',
};

export const Sys = {
  PATHMGR: 0x02,
  MMAP: 0x06,
  MUNMAP: 0x07,
  MAPNAME: 0x08,
  ADDRESS: 0x09,
  FUNC_ENTER: 0x0a,
  FUNC_EXIT: 0x0b,
  SLOG: 0x0c,
  RUNSTATE: 0x0e,
  POWER: 0x0f,
  IPI: 0x10,
  PAGEWAIT: 0x11,
  TIMER: 0x12,
  PROFILE: 0x14,
  MAPNAME_64: 0x15,
  IST_ATTACH: 0x1d,
  IST_DETACH: 0x1e,
  SEND_IPI: 0x20,
} as const;

const SYS_LABELS: Record<number, string> = {
  0x02: 'PATHMGR_OPEN',
  0x03: 'APS_NAME',
  0x04: 'APS_BUDGETS',
  0x05: 'APS_BNKR',
  0x06: 'MMAP',
  0x07: 'MUNMAP',
  0x08: 'MAPNAME',
  0x09: 'ADDRESS',
  0x0a: 'FUNC_ENTER',
  0x0b: 'FUNC_EXIT',
  0x0c: 'SLOG2',
  0x0d: 'DEFRAG_START',
  0x0e: 'RUNSTATE',
  0x0f: 'POWER',
  0x10: 'IPI',
  0x11: 'PAGEWAIT',
  0x12: 'TIMER',
  0x13: 'DEFRAG_END',
  0x14: 'PROFILE',
  0x15: 'MAPNAME_64',
  0x1c: 'SCHED_CONF',
  0x1d: 'IST_ATTACH',
  0x1e: 'IST_DETACH',
  0x20: 'SEND_IPI',
};

/** Kernel call numbers (QNX 8.0 sys/kercalls.h). Names are what traceprinter prints. */
export const KER_CALLS: Record<number, string> = {
  0: 'NOP',
  1: 'TRACE_EVENT',
  2: 'RING0',
  3: 'CACHE_CONTROL',
  4: 'SYS_SRANDOM',
  5: 'MSG_REGISTER_EVENT',
  6: 'MSG_SEND_PULSEPTR',
  7: 'SYS_CPUPAGE_GET',
  8: 'SYS_CPUPAGE_SET',
  9: 'MSG_PAUSE',
  10: 'MSG_CURRENT',
  11: 'MSG_SENDV',
  12: 'MSG_SENDVNC',
  13: 'MSG_ERROR',
  14: 'MSG_RECEIVEV',
  15: 'MSG_REPLYV',
  16: 'MSG_READV',
  17: 'MSG_WRITEV',
  19: 'MSG_INFO',
  20: 'MSG_SEND_PULSE',
  21: 'MSG_DELIVER_EVENT',
  24: 'MSG_RECEIVEPULSEV',
  25: 'MSG_VERIFY_EVENT',
  26: 'SIGNAL_KILL',
  27: 'SIGNAL_RETURN',
  29: 'SIGNAL_ACTION',
  30: 'SIGNAL_PROCMASK',
  31: 'SIGNAL_SUSPEND',
  32: 'SIGNAL_WAITINFO',
  33: 'SIGNAL_KILL_SIGVAL',
  35: 'CHANNEL_CREATE',
  36: 'CHANNEL_DESTROY',
  37: 'CHANNEL_CTL',
  39: 'CONNECT_ATTACH',
  40: 'CONNECT_DETACH',
  41: 'CONNECT_SERVER_INFO',
  42: 'CONNECT_CLIENT_INFO',
  43: 'CONNECT_FLAGS',
  44: 'CONNECT_DUPFD',
  46: 'THREAD_CREATE',
  47: 'THREAD_DESTROY',
  49: 'THREAD_DETACH',
  50: 'THREAD_JOIN',
  51: 'THREAD_CANCEL',
  52: 'THREAD_CTL',
  53: 'THREAD_CTLEXT',
  55: 'INTERRUPT_ATTACH',
  56: 'INTERRUPT_QUERY',
  57: 'INTERRUPT_DETACH',
  58: 'INTERRUPT_WAIT',
  59: 'INTERRUPT_MASK',
  60: 'INTERRUPT_UNMASK',
  61: 'INTERRUPT_UNBLOCK',
  62: 'INTERRUPT_CTL',
  65: 'CLOCK_TIME',
  66: 'CLOCK_ADJUST',
  67: 'CLOCK_PERIOD',
  68: 'CLOCK_ID',
  70: 'TIMER_CREATE',
  71: 'TIMER_DESTROY',
  72: 'TIMER_SETTIME',
  73: 'TIMER_INFO',
  74: 'TIMER_ALARM',
  75: 'TIMER_TIMEOUT',
  76: 'TIMER_DELEGATE',
  77: 'SYNC_RWLOCK',
  78: 'SYNC_CREATE',
  79: 'SYNC_DESTROY',
  80: 'SYNC_MUTEX_LOCK',
  81: 'SYNC_MUTEX_UNLOCK',
  82: 'SYNC_CONDVAR_WAIT',
  83: 'SYNC_CONDVAR_SIGNAL',
  84: 'SYNC_SEM_POST',
  85: 'SYNC_SEM_WAIT',
  86: 'SYNC_CTL',
  87: 'SYNC_BARRIER_WAIT',
  88: 'SCHED_GET',
  89: 'SCHED_SET',
  90: 'SCHED_YIELD',
  91: 'SCHED_INFO',
  92: 'SCHED_CTL',
  93: 'MSG_QUEUE_OPEN',
  94: 'MSG_QUEUE_SEND',
  95: 'MSG_QUEUE_RECEIVE',
  96: 'MSG_QUEUE_CLOSE',
  97: 'MSG_QUEUE_CTL',
  98: 'PIPE_OPEN',
  99: 'PIPE_CTL',
  100: 'PIPE_CLOSE',
  104: 'SYNC_TYPE_DESTROY',
  105: 'TEST',
  106: 'SYS_CUSTOM',
  107: 'BAD',
};

/** traceprinter labels the exit of a few calls differently from their entry. */
const KER_EXIT_LABELS: Record<number, string> = { 83: 'SYNC_CONDVAR_SIG' };

export const Ker = {
  MSG_SENDV: 11,
  MSG_SENDVNC: 12,
  MSG_ERROR: 13,
  MSG_RECEIVEV: 14,
  MSG_REPLYV: 15,
  MSG_RECEIVEPULSEV: 24,
  INTERRUPT_ATTACH: 55,
  INTERRUPT_WAIT: 58,
  SYNC_MUTEX_LOCK: 80,
  SYNC_MUTEX_UNLOCK: 81,
  SYNC_CONDVAR_WAIT: 82,
  SYNC_CONDVAR_SIGNAL: 83,
  SYNC_SEM_POST: 84,
  SYNC_SEM_WAIT: 85,
  TIMER_TIMEOUT: 75,
  SCHED_SET: 89,
} as const;

export function kerCallName(num: number): string {
  return KER_CALLS[num] ?? `KER_${num}`;
}

/** The class column traceprinter prints for an event. */
export function classLabel(cls: number, code: number): string {
  switch (cls) {
    case Cls.CONTROL:
      return 'CONTROL';
    case Cls.KERCALL:
      return code & KC_EXIT ? 'KER_EXIT' : 'KER_CALL';
    case Cls.INT:
      return 'INTERRUPT';
    case Cls.PR_TH:
      return code >= 64 ? 'PROCESS' : 'THREAD';
    case Cls.SYSTEM:
      return 'SYSTEM';
    case Cls.USER:
      return 'USREVENT';
    case Cls.COMM:
      return 'COMM';
    case Cls.QUIP:
      return 'QUIP';
    case Cls.SEC:
      return 'SECURITY';
    case Cls.QVM:
      return 'QVM';
    case Cls.PMU:
      return 'PMU';
    default:
      return 'EMPTY';
  }
}

/** The event column traceprinter prints (without the class). */
export function eventLabel(cls: number, code: number): string {
  switch (cls) {
    case Cls.CONTROL:
      return code === Control.TIME
        ? 'TIME'
        : code === Control.BUFFER
          ? 'BUFFER'
          : code === Control.BUFFER_END
            ? 'BUFFER_END'
            : code === Control.DROPPED
              ? 'DROPPED'
              : `CONTROL${code}`;
    case Cls.KERCALL: {
      const num = code & KC_NUM_MASK;
      const name = code & KC_EXIT ? (KER_EXIT_LABELS[num] ?? kerCallName(num)) : kerCallName(num);
      return `${name}/${String(num).padStart(2, '0')}`;
    }
    case Cls.INT:
      return code === 7 ? 'INT_DELIVER' : `INT${code}`;
    case Cls.PR_TH:
      if (code < 64) return 'TH' + STATE_NAMES[code];
      switch (code) {
        case Proc.CREATE:
          return 'PROCCREATE';
        case Proc.DESTROY:
          return 'PROCDESTROY';
        case Proc.CREATE_NAME:
          return 'PROCCREATE_NAME';
        case Proc.DESTROY_NAME:
          return 'PROCDESTROY_NAME';
        case Proc.THREAD_NAME:
          return 'PROCTHREAD_NAME';
        default:
          return `PR_TH${code}`;
      }
    case Cls.SYSTEM: {
      const base = SYS_LABELS[code & 0x1ff] ?? `SYS${code & 0x1ff}`;
      return code & KC_64 ? `${base}_64` : base;
    }
    case Cls.USER:
      return `EVENT:${code}`;
    case Cls.COMM:
      return COMM_LABELS[code] ?? `COMM${code}`;
    default:
      return `EV${code}`;
  }
}

/** Scheduling policies. QNX 8.0 also reports policy 8 for some kernel threads. */
export function policyName(p: number): string {
  switch (p) {
    case 1:
      return 'FIFO';
    case 2:
      return 'RR';
    case 3:
      return 'OTHER';
    case 4:
      return 'SPORADIC';
    default:
      return `policy ${p}`;
  }
}
