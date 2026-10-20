// Abstract clients against the admission model. This does not simulate Valve's scheduler.
import { mulberry32, sample } from '../core/rng.ts';
import type { DistSpec } from '../core/types.ts';
import { acquire } from './admission.ts';
import type { Lease } from './admission.ts';
import { cloneState, createState } from './state.ts';
import type { AdmissionState, Rule } from './state.ts';
/** Declared client policy: RTT elapses after admission, then the retry timer starts. */
export interface ClientPolicy {
  batch: number;
  retry: 'hint';
  rttMs: DistSpec;
  timerLateness: DistSpec;
  oneInFlight: true;
}
/** Each client has either maintained backlog depth or an exogenous arrival schedule. */
export interface SimulationInput {
  clients: number;
  queue: { backlog: number } | { arrivals: readonly (readonly number[])[] };
  rules: readonly Rule[];
  lease?: Omit<Lease, 'owner'>;
  initialState?: AdmissionState;
  policy: ClientPolicy;
  seed: number;
  t0: number;
  t1: number;
  cost?: number;
}
/** Descriptive metrics of this declared abstract policy only. */
export interface SimulationResult {
  kind: 'abstract-client-model';
  calls: number;
  grants: number;
  zeroGrantCalls: number;
  callsPerGrant: number;
  admittedCost: number;
  perClientGrants: number[];
  waits: number[];
}
/** Run deterministic discrete events; ties resolve by client index. Leases expire by TTL. */
export function simulate(input: SimulationInput): SimulationResult {
  if (
    input.clients < 1 ||
    input.policy.batch < 1 ||
    ('backlog' in input.queue && input.queue.backlog < 1)
  )
    throw new RangeError('Positive clients, batch and backlog required');
  const rnd = mulberry32(input.seed),
    state = cloneState(input.initialState ?? createState());
  const queues = Array.from({ length: input.clients }, (_, i) =>
    'arrivals' in input.queue
      ? [...(input.queue.arrivals[i] ?? [])].sort((a, b) => a - b)
      : Array<number>(input.queue.backlog).fill(input.t0),
  );
  const wakes = queues.map((q) => Math.max(input.t0, q[0] ?? Infinity));
  const result: SimulationResult = {
    kind: 'abstract-client-model',
    calls: 0,
    grants: 0,
    zeroGrantCalls: 0,
    callsPerGrant: 0,
    admittedCost: 0,
    perClientGrants: Array<number>(input.clients).fill(0),
    waits: [],
  };
  let serial = 0;
  while (true) {
    const now = Math.min(...wakes),
      client = wakes.indexOf(now);
    if (now >= input.t1) break;
    const queue = queues[client]!;
    const count = Math.min(
      input.policy.batch,
      queue.filter((at) => at <= now).length,
    );
    const reply = acquire(
      state,
      {
        rules: input.rules,
        costs: Array<number>(count).fill(input.cost ?? 1),
        ...(input.lease
          ? { lease: { ...input.lease, owner: `sim-${serial++}` } }
          : {}),
      },
      now,
    );
    result.calls++;
    result.grants += reply.granted;
    result.perClientGrants[client]! += reply.granted;
    if (!reply.granted) result.zeroGrantCalls++;
    for (const at of queue.splice(0, reply.granted))
      result.waits.push(now - at);
    const completed = now + sample(rnd, input.policy.rttMs);
    if ('backlog' in input.queue)
      for (let i = 0; i < reply.granted; i++) queue.push(completed);
    const wake = Math.max(
      completed + reply.retryAfterMs + sample(rnd, input.policy.timerLateness),
      queue[0] ?? Infinity,
    );
    if (wake <= now)
      throw new RangeError(
        'Zero-time client cycle: declare positive RTT or timer lateness',
      );
    wakes[client] = wake;
  }
  result.admittedCost = result.grants * (input.cost ?? 1);
  result.callsPerGrant = result.grants
    ? result.calls / result.grants
    : Infinity;
  return result;
}
