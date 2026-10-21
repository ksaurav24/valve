// One renewal timer and one release batch per valve; portable web APIs only.
import { failure } from './errors.js';
import type { Store } from './store.js';
export function leaseManager(
  store: Store,
  id: string,
  ttlMs: number,
  report: (error: unknown) => void,
  wake: () => void,
) {
  const active = new Map<
    string,
    {
      controller: AbortController;
      until: number;
      detach: () => void;
      error?: Error;
    }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewing = false;
  let cancelWatch: (() => void) | undefined;
  let pending: string[] = [];
  let releases: Promise<void> = Promise.resolve();
  let releasing = 0;
  function lost(token: string, cause?: unknown) {
    const entry = active.get(token);
    if (entry && !entry.error) {
      entry.error = failure(
        id,
        'LEASE_LOST',
        'global concurrency lease was lost. Stop work when the job signal aborts.',
        cause,
      );
      entry.controller.abort(entry.error);
    }
  }
  function arm() {
    if (!active.size || timer !== undefined || renewing) return;
    const earliest = Math.min(
      ...[...active.values()]
        .filter((entry) => !entry.error)
        .map((entry) => entry.until),
    );
    timer = setTimeout(
      () => {
        timer = undefined;
        void renew();
      },
      Math.max(1, Math.min(ttlMs / 3, earliest - Date.now())),
    );
  }
  async function renew() {
    renewing = true;
    const now = Date.now();
    for (const [token, entry] of active) if (entry.until <= now) lost(token);
    const tokens = [...active]
      .filter(([, entry]) => !entry.error)
      .map(([token]) => token);
    if (tokens.length) {
      try {
        const deadline = Math.min(
          ...tokens.map((token) => active.get(token)!.until),
        );
        const expiry = new Promise<boolean>((resolve) => {
          cancelWatch = () => {
            clearTimeout(timer);
            timer = undefined;
            resolve(false);
          };
          timer = setTimeout(cancelWatch, Math.max(1, deadline - Date.now()));
        });
        let valid: boolean;
        try {
          valid = await Promise.race([store.renew!(id, tokens, ttlMs), expiry]);
        } finally {
          cancelWatch?.();
          cancelWatch = undefined;
        }
        if (!valid || Date.now() >= now + ttlMs)
          for (const token of tokens) lost(token);
        else
          for (const token of tokens) {
            const entry = active.get(token);
            if (entry && !entry.error) entry.until = now + ttlMs;
          }
      } catch (error) {
        report(error);
        // Fail closed when renewal cannot be confirmed. The old slots expire naturally.
        for (const token of tokens) lost(token, error);
      }
    }
    renewing = false;
    if ([...active.values()].some((entry) => !entry.error)) arm();
  }
  function flush() {
    if (!pending.length) return;
    const tokens = pending;
    pending = [];
    releasing++;
    releases = releases
      .then(() => store.release!(id, tokens))
      .catch(report)
      .then(() => {
        releasing--;
        wake();
      });
  }
  return {
    releasing: () => pending.length > 0 || releasing > 0,
    claim(token: string, until: number, signal?: AbortSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      active.set(token, {
        controller,
        until,
        detach: () => signal?.removeEventListener('abort', abort),
      });
      arm();
      return controller.signal;
    },
    error: (token: string) => {
      if ((active.get(token)?.until ?? Infinity) <= Date.now()) lost(token);
      return active.get(token)?.error;
    },
    release(token: string) {
      active.get(token)?.detach();
      active.delete(token);
      if (!active.size) {
        cancelWatch?.();
        clearTimeout(timer);
        timer = undefined;
      }
      pending.push(token);
      if (pending.length === 1) queueMicrotask(flush);
    },
    async close() {
      cancelWatch?.();
      clearTimeout(timer);
      timer = undefined;
      flush();
      await releases;
    },
  };
}
