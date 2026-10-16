// Adapted from the supplied Valve Hero v2 concept.
type Point = [number, number];
type Segment =
  | { type: 'line'; a: Point; b: Point }
  | { type: 'cubic'; p: [Point, Point, Point, Point] };
type SampledPath = { pts: Point[]; len: number };

// Valve flow - geometry. Pure functions; no rendering.
function vfCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const a = 1 - t,
    b0 = a * a * a,
    b1 = 3 * a * a * t,
    b2 = 3 * a * t * t,
    b3 = t * t * t;
  return [
    b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
    b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
  ];
}
// Resample a chain of segments to ~1px uniform arc-length steps.
function vfSample(segs: Segment[]): SampledPath {
  const raw: Point[] = [];
  segs.forEach((s, si) => {
    const n = s.type === 'line' ? 2 : 160;
    for (let i = si === 0 ? 0 : 1; i < n; i++) {
      const t = i / (n - 1);
      raw.push(
        s.type === 'line'
          ? [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]
          : vfCubic(s.p[0], s.p[1], s.p[2], s.p[3], t),
      );
    }
  });
  const out = [raw[0]];
  let acc = 0,
    next = 1;
  for (let i = 1; i < raw.length; i++) {
    const [x0, y0] = raw[i - 1],
      [x1, y1] = raw[i];
    const d = Math.hypot(x1 - x0, y1 - y0);
    while (acc + d >= next) {
      const f = (next - acc) / d;
      out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
      next += 1;
    }
    acc += d;
  }
  return { pts: out, len: out.length - 1 };
}
export function vfAt(path: SampledPath, s: number): Point {
  const i = Math.max(0, Math.min(path.len - 1, Math.floor(s))),
    f = Math.max(0, Math.min(1, s - i));
  const a = path.pts[i],
    b = path.pts[i + 1] || a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// mode: 'wide' (desktop/tablet) | 'compact' (mobile)
export function vfBuild(mode: 'wide' | 'compact') {
  const wide = mode === 'wide';
  const base = wide
    ? {
        W: 1200,
        H: 330,
        cy: 165,
        ys: [52, 165, 278],
        x0: 40,
        port: 112,
        MX: 430,
        MH: 56,
        TX: 590,
        CAP: 10,
        SP: 20,
        outEnd: 1240,
      }
    : {
        W: 640,
        H: 300,
        cy: 150,
        ys: [70, 150, 230],
        x0: 24,
        port: 80,
        MX: 220,
        MH: 46,
        TX: 320,
        CAP: 7,
        SP: 20,
        outEnd: 680,
      };
  const g = {
    ...base,
    BH: 36,
    CHI: 13,
    OH: 11,
    OI: 5,
    GX: 0,
    C1: 0,
    trackLen: 0,
    slots: [] as number[],
    workers: [] as { y: number; label: string }[],
    lanes: [] as { path: SampledPath; ST: number; d: string }[],
    body: '',
    channel: '',
    outPath: { pts: [], len: 0 } as SampledPath,
    collars: [] as number[],
  };
  g.GX = g.TX + g.CAP * g.SP + 10; // gate plates
  g.C1 = g.GX + 22; // chamber end
  g.trackLen = g.GX - 8 - g.TX; // head waits just before the gate
  const n = g.ys.length,
    cy = g.cy;
  g.slots = g.ys.map((_, i) => cy + (i - (n - 1) / 2) * (wide ? 40 : 34));
  g.workers = g.ys.map((y, i) => ({ y, label: 'worker-0' + (i + 1) }));
  g.lanes = g.ys.map((y, i) => {
    const sy = g.slots[i],
      k = (g.MX - g.port) * 0.5;
    const lane: Segment = {
      type: 'cubic',
      p: [
        [g.port, y],
        [g.port + k, y],
        [g.MX - k * 0.8, sy],
        [g.MX, sy],
      ],
    };
    const conv: Segment = {
      type: 'cubic',
      p: [
        [g.MX, sy],
        [g.MX + (g.TX - g.MX) * 0.45, sy],
        [g.TX - (g.TX - g.MX) * 0.4, cy],
        [g.TX, cy],
      ],
    };
    const path = vfSample([lane, conv]);
    return {
      path,
      ST: path.len,
      d: `M${g.port},${y} C${lane.p[1].join(',')} ${lane.p[2].join(',')} ${g.MX},${sy}`,
    };
  });
  const { MX, MH, TX, BH, CHI, OH, OI, GX, C1 } = g,
    E = g.outEnd;
  const L = 8; // flange lip
  g.body = `M${MX},${cy - MH - L} C${MX + 90},${cy - MH - L} ${TX - 80},${cy - BH} ${TX},${cy - BH} L${C1 - 6},${cy - BH} C${C1 + 8},${cy - BH} ${C1 + 6},${cy - OH} ${C1 + 26},${cy - OH} L${E},${cy - OH} L${E},${cy + OH} L${C1 + 26},${cy + OH} C${C1 + 6},${cy + OH} ${C1 + 8},${cy + BH} ${C1 - 6},${cy + BH} L${TX},${cy + BH} C${TX - 80},${cy + BH} ${MX + 90},${cy + MH + L} ${MX},${cy + MH + L} Z`;
  g.channel = `M${MX + 2},${cy - MH} C${MX + 92},${cy - MH} ${TX - 70},${cy - CHI} ${TX},${cy - CHI} L${GX + 2},${cy - CHI} C${GX + 10},${cy - CHI} ${GX + 8},${cy - OI} ${GX + 20},${cy - OI} L${E},${cy - OI} L${E},${cy + OI} L${GX + 20},${cy + OI} C${GX + 8},${cy + OI} ${GX + 10},${cy + CHI} ${GX + 2},${cy + CHI} L${TX},${cy + CHI} C${TX - 70},${cy + CHI} ${MX + 92},${cy + MH} ${MX + 2},${cy + MH} Z`;
  g.outPath = vfSample([{ type: 'line', a: [GX - 8, cy], b: [E + 10, cy] }]);
  g.collars = wide ? [C1 + 90, C1 + 200, C1 + 310] : [C1 + 60];
  return g;
}
export type FlowGeometry = ReturnType<typeof vfBuild>;
