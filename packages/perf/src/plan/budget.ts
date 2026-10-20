// Wall-clock estimates from measured per-trial costs. Defaults come from 2,136 legacy slotExp
// trials (overhead median 2.5 s at 1 worker to 4.0 s at 64, incl. a 2 s quiet period; 2.4%
// resource rejections). `perf calibrate` replaces them with this host's measurements.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decode, encode } from '../core/codec.ts';
import { calibrationFile, ensureDir, stateDir } from '../core/paths.ts';
import type { CellSpec } from '../core/types.ts';

export interface Calibration {
  /** Fixed per-trial overhead without the quiet period, seconds. */
  baseSec: number;
  /** Additional overhead per worker process, seconds. */
  perWorkerSec: number;
  /** Quiet period before authoritative trials, seconds. */
  quietSec: number;
  rejectRate: number;
  cooldownSec: number;
  source: string;
  measuredAt?: string;
}

export const LEGACY_CALIBRATION: Calibration = {
  baseSec: 0.45,
  perWorkerSec: 0.027,
  quietSec: 2.0,
  rejectRate: 0.024,
  cooldownSec: 10,
  source: 'legacy slotExp medians (2,136 trials, i5-12450H)',
};

/** Load measured supervisor overhead, falling back to the recorded initial calibration. */
export function loadCalibration(): Calibration {
  if (existsSync(calibrationFile))
    return decode<Calibration>(readFileSync(calibrationFile, 'utf8'));
  return LEGACY_CALIBRATION;
}
/** Persist host calibration for subsequent deterministic budget estimates. */
export function saveCalibration(c: Calibration) {
  ensureDir(stateDir);
  writeFileSync(calibrationFile, encode(c, 2));
}

/** Expected wall seconds for one trial (drain counted at its worst case). */
export function trialSeconds(
  cell: CellSpec,
  cal: Calibration,
  authoritative: boolean,
): number {
  const workers =
    cell.workers +
    (cell.faults ?? []).reduce(
      (n, f) => n + (f.type === 'spawn-workers' ? f.count : 0),
      0,
    );
  return (
    (cell.timing.warmupMs + cell.timing.windowMs + cell.timing.drainMs) / 1000 +
    cal.baseSec +
    cal.perWorkerSec * workers +
    (authoritative ? cal.quietSec : 0)
  );
}

export interface Estimate {
  trials: number;
  seconds: number;
  /** Includes expected rejection retries and cooldowns. */
  withRetriesSeconds: number;
}

/** Estimate trial time plus declared rejection, cooldown, and setup allowances. */
export function estimate(
  trials: readonly { cell: CellSpec }[],
  cal: Calibration,
  authoritative: boolean,
  setupSec = 5,
): Estimate {
  const seconds = trials.reduce(
    (s, t) => s + trialSeconds(t.cell, cal, authoritative),
    0,
  );
  const retry = authoritative
    ? cal.rejectRate * (seconds + trials.length * cal.cooldownSec)
    : 0;
  return {
    trials: trials.length,
    seconds,
    withRetriesSeconds: seconds + retry + setupSec,
  };
}

export const fmtDuration = (sec: number) => {
  if (sec < 90) return `${sec.toFixed(0)} s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(2)} h`;
};

/** Parse "40m", "2h", "90s" or plain seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`bad duration ${text}`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
