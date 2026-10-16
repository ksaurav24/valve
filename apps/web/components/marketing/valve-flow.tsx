'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { vfAt, vfBuild } from './valve-flow/geometry';
import { vfCreateSim, type FlowSimulation } from './valve-flow/simulation';
import type { FlowGeometry } from './valve-flow/geometry';

const VF = {
  line: 'var(--border)',
  edge: 'var(--ring)',
  text: 'var(--muted-foreground)',
  val: 'var(--foreground)',
  ink: 'var(--foreground)',
  dark: 'var(--background)',
};
const accent = 'var(--live)';
const rate = 2;
const POOL = 40;
const vfEaseOut = (x: number) => 1 - Math.pow(1 - x, 3);
const vfEaseInOut = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

type FlowElements = {
  pool: (SVGCircleElement | null)[];
  ticks: (SVGLineElement | null)[];
  ports: (SVGRectElement | null)[];
  collars: (SVGRectElement | null)[];
  gateT: SVGRectElement | null;
  gateB: SVGRectElement | null;
  gateGlow: SVGRectElement | null;
  meter: SVGRectElement | null;
  q: SVGTSpanElement | null;
  qNote: SVGTSpanElement | null;
};

export function ValveFlow() {
  const wrap = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [cw, setCw] = useState(640);
  const [paused, setPaused] = useState(false);
  const simulation = useRef<{
    geometry: FlowGeometry;
    sim: FlowSimulation;
  } | null>(null);
  const elements = useRef<FlowElements>({
    pool: [],
    ticks: [],
    ports: [],
    collars: [],
    gateT: null,
    gateB: null,
    gateGlow: null,
    meter: null,
    q: null,
    qNote: null,
  });
  const R = elements.current;
  useEffect(() => {
    const ro = new ResizeObserver((entries) =>
      setCw(Math.round(entries[0].contentRect.width) || 640),
    );
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  const mode = cw >= 760 ? 'wide' : 'compact';
  const g = useMemo(() => vfBuild(mode), [mode]);
  const fs = Math.min(30, Math.max(12, (13 * g.W) / Math.max(280, cw)));
  const { cy, MX, MH, TX, BH, CHI, OH, GX, C1, CAP, SP } = g;
  const pr = mode === 'wide' ? 3.2 : 3.4;

  useEffect(() => {
    if (simulation.current?.geometry !== g) {
      const sim = vfCreateSim(g, rate);
      // Start with a populated flow rather than an empty pipe.
      for (let i = 0; i < 25 * 120; i++) sim.step(1 / 120);
      simulation.current = { geometry: g, sim };
    }
    const sim = simulation.current.sim;
    let lastQ = '';
    const draw = () => {
      const t = sim.t,
        all: [number, number, string, number][] = [];
      sim.lane.forEach((p) => {
        const [x, y] = vfAt(g.lanes[p.w].path, p.s);
        all.push([x, y, VF.ink, Math.min(1, p.s / 24)]);
      });
      sim.file.forEach((p) => all.push([TX + p.s, cy, VF.ink, 1]));
      sim.out.forEach((p) => {
        const [x, y] = vfAt(g.outPath, p.s);
        all.push([x, y, accent, 1]);
      });
      R.pool.forEach((el, i) => {
        if (!el) return;
        const a = all[i];
        if (!a) {
          el.setAttribute('opacity', '0');
          return;
        }
        el.setAttribute('cx', a[0].toFixed(2));
        el.setAttribute('cy', a[1].toFixed(2));
        el.setAttribute('fill', a[2]);
        el.setAttribute('opacity', String(a[3]));
      });
      const d = t - sim.gateAt;
      const ap =
        d < 0.12
          ? vfEaseOut(d / 0.12)
          : d < 0.2
            ? 1
            : d < 0.5
              ? 1 - vfEaseInOut((d - 0.2) / 0.3)
              : 0;
      const gap = ap * 14,
        h = CHI + 1 - gap / 2;
      if (R.gateT) R.gateT.setAttribute('height', Math.max(0, h).toFixed(2));
      if (R.gateB) {
        R.gateB.setAttribute('y', (cy + gap / 2).toFixed(2));
        R.gateB.setAttribute('height', Math.max(0, h).toFixed(2));
      }
      if (R.gateGlow) R.gateGlow.setAttribute('opacity', (ap * 0.9).toFixed(3));
      if (R.meter)
        R.meter.setAttribute(
          'width',
          (Math.min(1, (t - sim.lastRel) / sim.I) * 52).toFixed(2),
        );
      R.ticks.forEach(
        (el, k) =>
          el &&
          el.setAttribute('stroke', sim.file.length > k ? VF.val : VF.line),
      );
      R.ports.forEach(
        (el, i) =>
          el &&
          el.setAttribute(
            'fill-opacity',
            (0.9 * Math.exp(-(t - sim.workers[i].emitAt) * 5)).toFixed(3),
          ),
      );
      R.collars.forEach((el, j) => {
        if (!el) return;
        let n = 0;
        sim.out.forEach((p) => {
          const x = vfAt(g.outPath, p.s)[0];
          n = Math.max(n, Math.exp(-Math.pow((x - g.collars[j]) / 16, 2)));
        });
        el.setAttribute('opacity', (0.12 + 0.6 * n).toFixed(3));
      });
      const q = `${String(sim.file.length + sim.lane.length).padStart(2, '0')}/${CAP}`;
      if (q + sim.full !== lastQ && R.q && R.qNote) {
        lastQ = q + sim.full;
        R.q.textContent = q;
        R.qNote.textContent = sim.full && g.W > 640 ? '· workers wait' : '';
      }
    };
    draw();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0,
      prev = 0,
      visible = false;
    const running = () =>
      visible && !document.hidden && !paused && !motion.matches;
    const loop = (now: number) => {
      raf = 0;
      if (!running()) return;
      const dt = prev ? Math.min(0.05, (now - prev) / 1000) : 0;
      prev = now;
      if (dt > 0) {
        const steps = Math.ceil(dt / (1 / 120));
        for (let i = 0; i < steps; i++) sim.step(dt / steps);
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    const syncPlayback = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      prev = 0;
      if (running()) raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      syncPlayback();
    });
    io.observe(wrap.current!);
    motion.addEventListener('change', syncPlayback);
    document.addEventListener('visibilitychange', syncPlayback);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      motion.removeEventListener('change', syncPlayback);
      document.removeEventListener('visibilitychange', syncPlayback);
    };
  }, [g, paused, R, TX, cy, CHI]);

  const T = (x: number, y: number) => ({
    x,
    y,
    fontFamily: 'var(--font-mono)',
    fontSize: fs,
    fill: VF.text,
    letterSpacing: '0.02em',
  });
  return (
    <figure data-ui className="valve-flow-figure relative m-0">
      <div
        className="valve-flow"
        ref={wrap}
        style={{
          width: '100%',
          WebkitMaskImage:
            'linear-gradient(to right, #000 0, #000 88%, transparent 100%)',
          maskImage:
            'linear-gradient(to right, #000 0, #000 88%, transparent 100%)',
        }}
      >
        <svg
          id={uid}
          viewBox={`0 0 ${g.W} ${g.H}`}
          width="100%"
          className="h-full w-full overflow-hidden"
          role="img"
          aria-label="Requests from several workers queue inside valve and are admitted one at a time at a steady rate"
        >
          <defs>
            <linearGradient id={uid + 'b'} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--muted)" />
              <stop offset="0.5" stopColor="var(--card)" />
              <stop offset="1" stopColor="var(--background)" />
            </linearGradient>
            <clipPath id={uid + 'c'}>
              <rect x="0" y="0" width={MX + 3} height={g.H} />
              <path d={g.channel} />
            </clipPath>
          </defs>
          {g.workers.map((w, i) => (
            <g key={i}>
              <line x1={g.x0} y1={w.y} x2={g.port} y2={w.y} stroke={VF.line} />
              <path d={g.lanes[i].d} fill="none" stroke={VF.line} />
              <rect
                ref={(el) => {
                  R.ports[i] = el;
                }}
                x={g.port - 4}
                y={w.y - 4}
                width="8"
                height="8"
                fill={VF.ink}
                fillOpacity="0"
                stroke={VF.text}
                strokeWidth="1"
              />
              <text {...T(g.x0, w.y - 12)}>{w.label}</text>
            </g>
          ))}
          <path d={g.body} fill={`url(#${uid}b)`} stroke={VF.edge} />
          <rect
            x={MX - 5}
            y={cy - MH - 14}
            width="7"
            height={2 * MH + 28}
            rx="2"
            fill="var(--secondary)"
            stroke={VF.edge}
          />
          <path d={g.channel} fill={VF.dark} stroke="var(--border)" />
          <line
            x1={TX}
            y1={cy - BH + 0.5}
            x2={C1 - 6}
            y2={cy - BH + 0.5}
            stroke="var(--foreground)"
            strokeOpacity="0.07"
          />
          <line x1={TX} y1={cy - BH} x2={TX} y2={cy + BH} stroke={VF.edge} />
          <line
            x1={C1 - 6}
            y1={cy - BH}
            x2={C1 - 6}
            y2={cy + BH}
            stroke={VF.edge}
          />
          {Array.from({ length: CAP }, (_, k) => {
            const x = g.trackLen + TX - k * SP;
            return (
              <line
                key={k}
                ref={(el) => {
                  R.ticks[k] = el;
                }}
                x1={x}
                y1={cy + CHI + 6}
                x2={x}
                y2={cy + CHI + 11}
                stroke={VF.line}
                strokeWidth="1.5"
              />
            );
          })}
          {g.collars.map((x, j) => (
            <g key={j}>
              <rect
                x={x - 3}
                y={cy - OH - 4}
                width="6"
                height={2 * OH + 8}
                rx="1.5"
                fill="var(--secondary)"
                stroke={VF.edge}
              />
              <rect
                ref={(el) => {
                  R.collars[j] = el;
                }}
                x={x - 0.75}
                y={cy - OH - 4}
                width="1.5"
                height="3"
                fill={accent}
                opacity="0.12"
              />
            </g>
          ))}
          <g clipPath={`url(#${uid}c)`}>
            {Array.from({ length: POOL }, (_, i) => (
              <circle
                key={i}
                ref={(el) => {
                  R.pool[i] = el;
                }}
                r={pr}
                opacity="0"
              />
            ))}
          </g>
          <rect
            ref={(el) => {
              R.gateGlow = el;
            }}
            x={GX - 3}
            y={cy - CHI}
            width="8"
            height={2 * CHI}
            fill={accent}
            opacity="0"
            fillOpacity="0.12"
          />
          <rect
            ref={(el) => {
              R.gateT = el;
            }}
            x={GX}
            y={cy - CHI - 1}
            width="3"
            height={CHI + 1}
            fill="var(--ring)"
          />
          <rect
            ref={(el) => {
              R.gateB = el;
            }}
            x={GX}
            y={cy}
            width="3"
            height={CHI + 1}
            fill="var(--ring)"
          />
          <rect
            x={GX - 46}
            y={cy - BH - 13}
            width="52"
            height="1.5"
            fill={VF.line}
          />
          <rect
            ref={(el) => {
              R.meter = el;
            }}
            x={GX - 46}
            y={cy - BH - 13}
            width="0"
            height="1.5"
            fill={accent}
            opacity="0.8"
          />
          <g>
            <text {...T(MX - 5, cy - MH - 26)}>ingress</text>
            <text {...T(TX, cy + BH + 26)}>
              queued{' '}
              <tspan
                ref={(el) => {
                  R.q = el;
                }}
                fill={VF.val}
              >
                00/{CAP}
              </tspan>{' '}
              <tspan
                ref={(el) => {
                  R.qNote = el;
                }}
              ></tspan>
            </text>
            <text
              {...T(mode === 'wide' ? C1 + 26 : g.W - 24, cy - OH - 18)}
              textAnchor={mode === 'wide' ? 'start' : 'end'}
            >
              admitted <tspan fill={VF.val}>{rate} req/s</tspan>
            </text>
          </g>
        </svg>
      </div>
      <figcaption className="mt-3 flex min-h-11 items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <span>Illustrative flow</span>
        <button
          type="button"
          aria-controls={uid}
          onClick={() => setPaused((value) => !value)}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 hover:bg-hover hover:text-foreground motion-reduce:hidden"
        >
          {paused ? (
            <Play aria-hidden="true" className="size-3" />
          ) : (
            <Pause aria-hidden="true" className="size-3" />
          )}
          {paused ? 'Play animation' : 'Pause animation'}
        </button>
      </figcaption>
    </figure>
  );
}
