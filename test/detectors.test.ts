// Each detector must find the problem planted in its sample trace and stay silent on the clean
// baseline. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultConfig, findConfigFor, loadConfig } from '../src/config/deadlines.js';
import { analyse, type Analysis, type Finding } from '../src/detect/index.js';
import { readTraceprinter } from '../src/kev/traceprinter.js';
import { buildModel, type Model } from '../src/model/model.js';
import { sampleTrace, tracePath } from './helpers.js';

const cache = new Map<string, { m: Model; a: Analysis }>();
function run(name: string): { m: Model; a: Analysis } {
  let r = cache.get(name);
  if (!r) {
    const m = buildModel(sampleTrace(name));
    const cfgPath = findConfigFor(tracePath(`${name}.kev`));
    r = { m, a: analyse(m, cfgPath ? loadConfig(cfgPath) : defaultConfig()) };
    cache.set(name, r);
  }
  return r;
}
const fact = (f: Finding, key: string) => f.facts.find((x) => x.key === key)?.value;
const names = (m: Model, f: Finding) => f.threads.map((t) => m.threads[t].name);

describe('deadline-miss detector', () => {
  it('finds brake_ctl missing its 15 ms deadline in the inversion trace', () => {
    const { m, a } = run('inversion');
    const d = a.findings.find((f) => f.kind === 'deadline-miss');
    expect(d).toBeDefined();
    expect(m.threads[d!.threads[0]].name).toBe('brake_ctl');
    expect(fact(d!, 'deadline')).toBe(15e6);
    expect(fact(d!, 'period')).toBe(20e6);
    expect(Number(fact(d!, 'misses'))).toBeGreaterThanOrEqual(20);
    expect(Number(fact(d!, 'worstResponse'))).toBeGreaterThan(25e6);
    // The miss is explained by the inversion.
    expect(d!.related.some((id) => id.startsWith('priority-inversion'))).toBe(true);
  });

  it("agrees with brakesim's own measurement of every late job", () => {
    const { m, a } = run('inversion');
    const d = a.findings.find((f) => f.kind === 'deadline-miss')!;
    const brake = d.threads[0];
    // brakesim logs its own response time (us) in the job-end marker (TraceEvent code 101).
    const own = new Map<number, number>();
    for (const x of m.markers) if (x.thread === brake && x.code === 101) own.set(x.d0, x.d1 * 1000);
    const late = [...own.values()].filter((ns) => ns > 15e6).length;
    expect(d.instances.length).toBe(late);
    for (const ins of d.instances) {
      const seq = Number(/job (\d+)/.exec(ins.text)![1]);
      // Our response starts at the wakeup, the program's at its first instruction: within 0.5 ms.
      expect(Math.abs(ins.value - own.get(seq)!)).toBeLessThan(0.5e6);
    }
  });

  it('finds the periodic threads starved by the CPU hog', () => {
    const { m, a } = run('cpu-hog');
    const misses = a.findings.filter((f) => f.kind === 'deadline-miss').map((f) => m.threads[f.threads[0]].name);
    expect(misses.sort()).toEqual(['can_rx', 'sensor_poll']);
  });

  it('does not fire on the fixed program or the clean baseline', () => {
    expect(run('inversion-fixed').a.findings.filter((f) => f.kind === 'deadline-miss')).toEqual([]);
    expect(run('baseline').a.findings.filter((f) => f.kind === 'deadline-miss')).toEqual([]);
  });
});

describe('priority-inversion detector', () => {
  it('finds brake_ctl (63) blocked on logger (10) while telemetry (30) runs', () => {
    const { m, a } = run('inversion');
    const f = a.findings.find((x) => x.kind === 'priority-inversion');
    expect(f).toBeDefined();
    expect(names(m, f!).slice(0, 3)).toEqual(['brake_ctl', 'logger', 'telemetry']);
    expect(fact(f!, 'waiterPrio')).toBe(63);
    expect(fact(f!, 'holderPrio')).toBe(10);
    expect(fact(f!, 'mediumPrio')).toBe(30);
    expect(Number(fact(f!, 'wait'))).toBeGreaterThan(25e6);
    expect(Number(fact(f!, 'occurrences'))).toBeGreaterThanOrEqual(20);
    expect(f!.hint).toContain('PTHREAD_PRIO_INHERIT');
  });

  it('does not fire once the mutex uses PTHREAD_PRIO_INHERIT, nor on the baseline', () => {
    // With inheritance the logger runs at 63 while brake_ctl waits: the wait is short and nothing
    // of medium priority runs in it.
    const fixed = run('inversion-fixed');
    expect(fixed.a.findings.filter((f) => f.kind === 'priority-inversion')).toEqual([]);
    const waits = fixed.m.mutexWaits.filter((w) => fixed.m.threads[w.waiter].name === 'brake_ctl');
    expect(waits.length).toBeGreaterThan(10);
    expect(Math.max(...waits.map((w) => w.tWake - w.tBlock))).toBeLessThan(5e6);
    expect(run('baseline').a.findings.filter((f) => f.kind === 'priority-inversion')).toEqual([]);
  });
});

describe('IST latency detector', () => {
  it('finds adc_ist (40) held off by video_enc (50) after interrupt 8', () => {
    const { m, a } = run('ist-latency');
    const f = a.findings.find((x) => x.kind === 'ist-latency');
    expect(f).toBeDefined();
    expect(m.threads[f!.threads[0]].name).toBe('adc_ist');
    expect(fact(f!, 'intr')).toBe('8');
    expect(fact(f!, 'istPrio')).toBe(40);
    expect(Number(fact(f!, 'worst'))).toBeGreaterThan(5e6);
    expect(m.threads[f!.threads[1]].name).toBe('video_enc');
  });

  it('does not fire on the baseline, where the IST outranks its CPU', () => {
    expect(run('baseline').a.findings.filter((f) => f.kind === 'ist-latency')).toEqual([]);
  });
});

describe('send-blocked chain detector', () => {
  it('finds hmi -> nav_server -> map_db -> flash_io', () => {
    const { m, a } = run('send-chain');
    const f = a.findings.find((x) => x.kind === 'send-chain' && m.threads[x.threads[0]].name === 'hmi');
    expect(f).toBeDefined();
    expect(names(m, f!)).toEqual(expect.arrayContaining(['hmi', 'nav_server', 'map_db', 'flash_io']));
    expect(Number(fact(f!, 'depth'))).toBeGreaterThanOrEqual(3);
    expect(Number(fact(f!, 'requests'))).toBeGreaterThanOrEqual(10);
    expect(f!.summary).toMatch(/SEND-blocked on map_db \(busy with route_planner\)/);
  });

  it('does not fire on the baseline (fast servers)', () => {
    expect(run('baseline').a.findings.filter((f) => f.kind === 'send-chain')).toEqual([]);
  });
});

describe('CPU hog detector', () => {
  it('finds diag_scan monopolising CPU 0 and starving the periodic threads', () => {
    const { m, a } = run('cpu-hog');
    const f = a.findings.find((x) => x.kind === 'cpu-hog');
    expect(f).toBeDefined();
    expect(m.threads[f!.threads[0]].name).toBe('diag_scan');
    expect(fact(f!, 'cpu')).toBe(0);
    expect(Number(fact(f!, 'share'))).toBeGreaterThan(90);
    expect(Number(fact(f!, 'episode'))).toBeGreaterThan(300e6);
    expect(names(m, f!)).toEqual(expect.arrayContaining(['sensor_poll', 'can_rx']));
    expect(f!.related.length).toBe(2);
  });

  it('does not fire on the baseline', () => {
    expect(run('baseline').a.findings.filter((f) => f.kind === 'cpu-hog')).toEqual([]);
  });
});

describe('clean baseline', () => {
  it('produces no findings at all', () => {
    const { a } = run('baseline');
    expect(a.findings.map((f) => f.title)).toEqual([]);
  });
});

describe('both decoders lead to the same analysis', () => {
  it('traceprinter text gives the same findings as the .kev reader', () => {
    const tp = readTraceprinter(gunzipSync(readFileSync(tracePath('inversion.traceprinter.txt.gz'))).toString('utf8'));
    const a = analyse(buildModel(tp), loadConfig(tracePath('inversion.deadlines.yaml')));
    const b = run('inversion').a;
    expect(a.findings.map((f) => [f.id, f.title])).toEqual(b.findings.map((f) => [f.id, f.title]));
  });
});
