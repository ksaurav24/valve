/** Parser for the minimal trusted subset of legacy slotexp JSONL rows. */

export interface SlotexpRow {
  stage: string;
  cell: string;
  arm: string;
  rep: number;
  workers: number;
  quotaPerSec: number;
  valid: boolean;
  metrics: {
    utilization?: number;
    callsPerGrant?: number;
    unitsPerSec?: number;
    jain?: number;
    redisCpuUsPerGrant?: number;
    openWaitP99?: number;
    urgentTimeoutRate?: number;
  };
  safety: {
    rateViolations: number;
    startedAfterAbort: number;
    lateCallbacks: number;
  };
}

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const number = (value: unknown): number | undefined =>
  value === 'Infinity'
    ? Number.POSITIVE_INFINITY
    : typeof value === 'number'
      ? value
      : undefined;
const requiredNumber = (value: unknown, field: string): number => {
  const parsed = number(value);
  if (parsed === undefined)
    throw new Error(`Legacy slotexp row is missing numeric ${field}`);
  return parsed;
};
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string')
    throw new Error(`Legacy slotexp row is missing string ${field}`);
  return value;
};

/** Parse JSONL rows and retain only stable identity, final-window, and safety fields. */
export function readSlotexpRows(jsonlText: string): SlotexpRow[] {
  return jsonlText
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const row = record(JSON.parse(line));
      const windows = Array.isArray(row.metrics) ? row.metrics : [];
      const metrics = record(windows.at(-1));
      const redis = record(metrics.redis);
      const open = record(metrics.open);
      const urgent = record(metrics.urgent);
      const resources = record(row.resources);
      const safety = record(row.safety);
      const optional = (value: unknown) => number(value);
      const projectedMetrics: SlotexpRow['metrics'] = {};
      for (const [key, value] of [
        ['utilization', metrics.utilization],
        ['callsPerGrant', metrics.callsPerGrant],
        ['unitsPerSec', metrics.unitsPerSec],
        ['jain', metrics.jain],
        ['redisCpuUsPerGrant', redis.cpuUsPerGrant],
        ['openWaitP99', open.waitP99],
        ['urgentTimeoutRate', urgent.timeoutRate],
      ] as const) {
        const parsed = optional(value);
        if (parsed !== undefined) projectedMetrics[key] = parsed;
      }
      return {
        arm: requiredString(row.arm, 'arm'),
        cell: requiredString(row.cell, 'cell'),
        metrics: projectedMetrics,
        quotaPerSec: requiredNumber(row.quotaPerSec, 'quotaPerSec'),
        rep: requiredNumber(row.rep, 'rep'),
        safety: {
          lateCallbacks: requiredNumber(
            safety.lateCallbacks,
            'safety.lateCallbacks',
          ),
          rateViolations: requiredNumber(
            safety.rateViolations,
            'safety.rateViolations',
          ),
          startedAfterAbort: requiredNumber(
            safety.startedAfterAbort,
            'safety.startedAfterAbort',
          ),
        },
        stage: requiredString(row.stage, 'stage'),
        valid: resources.valid === true,
        workers: requiredNumber(row.workers, 'workers'),
      };
    });
}
