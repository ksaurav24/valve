import type { FlowGeometry } from './geometry.ts';

type Particle = { id: number; s: number; v: number };
type LaneParticle = Particle & { w: number };
type Worker = {
  i: number;
  burst: boolean;
  until: number;
  next: number;
  emitAt: number;
  v: number;
};
export type FlowSimulation = {
  t: number;
  lane: LaneParticle[];
  file: LaneParticle[];
  out: Particle[];
  lastRel: number;
  gateAt: number;
  owner: LaneParticle | null;
  id: number;
  full: boolean;
  workers: Worker[];
  I: number;
  step: (dt: number) => void;
};

// Valve flow - deterministic scheduling simulation (seeded, with small simulation steps).
function vfRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vfApproach(
  p: { s: number; v: number },
  cap: number,
  vmax: number,
  dt: number,
) {
  const room = Math.max(0, cap - p.s);
  const want = Math.min(vmax, room * 4.5);
  const dv = want - p.v;
  p.v += dv > 0 ? Math.min(dv, 420 * dt) : Math.max(dv, -1600 * dt);
  p.s = Math.min(cap, p.s + Math.max(0, p.v) * dt);
  if (p.s >= cap) p.v = Math.min(p.v, want);
}
export function vfCreateSim(g: FlowGeometry, rate: number) {
  const rnd = vfRng(7);
  const exp = (m: number) => -Math.log(1 - rnd()) * m;
  const I = 1 / rate;
  const sim: FlowSimulation = {
    t: 0,
    lane: [],
    file: [],
    out: [],
    lastRel: -10,
    gateAt: -10,
    owner: null,
    id: 0,
    full: false,
    workers: [],
    I,
    step: () => {},
  };
  sim.workers = g.workers.map((w, i) => ({
    i,
    burst: false,
    until: exp(4) + i * 2,
    next: exp(1.5),
    emitAt: -10,
    v: 150 + i * 14,
  }));
  sim.step = (dt) => {
    const t = (sim.t += dt),
      { CAP, SP } = g;
    const inSys = sim.lane.length + sim.file.length;
    sim.full = inSys >= CAP;
    // Bursty sources: idle trickle, occasional bursts; blocked while the queue is full (backpressure).
    sim.workers.forEach((w) => {
      if (t >= w.until) {
        w.burst = !w.burst;
        w.until = t + (w.burst ? 0.7 + rnd() * 1.1 : 5 + exp(4));
      }
      if (t >= w.next && sim.lane.length + sim.file.length < CAP) {
        const lastOnLane = sim.lane
          .filter((p) => p.w === w.i)
          .reduce((m, p) => Math.min(m, p.s), 1e9);
        if (lastOnLane > SP * 1.6) {
          sim.lane.push({ id: sim.id++, w: w.i, s: 0, v: w.v * 0.6 });
          w.emitAt = t;
          w.next = t + (w.burst ? 0.28 + rnd() * 0.22 : 1.1 + exp(2.4));
        }
      }
    });
    // Merge: nearest particle to the throat owns it; others hold back.
    if (sim.owner && !sim.lane.includes(sim.owner)) sim.owner = null;
    if (!sim.owner) {
      let best: LaneParticle | null = null,
        bd = 1e9;
      sim.lane.forEach((p) => {
        const d = g.lanes[p.w].ST - p.s;
        if (d < 70 && d < bd) {
          bd = d;
          best = p;
        }
      });
      sim.owner = best;
    }
    const tail = sim.file[sim.file.length - 1];
    const tailU = tail ? tail.s : 1e9;
    for (let k = sim.lane.length - 1; k >= 0; k--) {
      const p = sim.lane[k],
        ST = g.lanes[p.w].ST;
      let cap = ST + g.trackLen;
      const ahead = sim.lane
        .filter((q) => q.w === p.w && q.s > p.s)
        .reduce((m, q) => Math.min(m, q.s), 1e9);
      cap = Math.min(cap, ahead - SP);
      if (p === sim.owner)
        cap = Math.min(cap, ST + Math.min(g.trackLen, tailU) - SP);
      else cap = Math.min(cap, ST - 34);
      vfApproach(p, cap, sim.workers[p.w].v, dt);
      if (p === sim.owner && p.s >= ST) {
        sim.lane.splice(k, 1);
        sim.owner = null;
        sim.file.push({ id: p.id, w: p.w, s: p.s - ST, v: p.v });
      }
    }
    sim.file.forEach((p, k) => {
      const cap = k === 0 ? g.trackLen : sim.file[k - 1].s - SP;
      vfApproach(p, cap, 120, dt);
    });
    // GCRA-style admission: one start per interval, released only when the head is staged at the gate.
    const head = sim.file[0];
    if (head && head.s >= g.trackLen - 0.5 && t - sim.lastRel >= I) {
      sim.file.shift();
      sim.out.push({ id: head.id, s: 0, v: 0 });
      sim.lastRel = t;
      sim.gateAt = t;
    }
    for (let k = sim.out.length - 1; k >= 0; k--) {
      const p = sim.out[k];
      p.v = Math.min(170, p.v + 300 * dt);
      p.s += p.v * dt;
      if (p.s > g.outPath.len) sim.out.splice(k, 1);
    }
  };
  return sim;
}
