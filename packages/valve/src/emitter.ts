// Ordered listeners with guarded warning reporting and unsubscribe support.
import type { ValveEventMap } from './types.js';
export function emitter() {
  const listeners = new Map<
    keyof ValveEventMap,
    Set<(payload: never) => void>
  >();
  function emit<E extends keyof ValveEventMap>(
    event: E,
    payload: ValveEventMap[E],
  ) {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      try {
        listener(payload as never);
      } catch (error) {
        if (event !== 'warning')
          emit('warning', {
            message: `Listener for ${event} threw: ${String(error)}`,
          });
      }
    }
  }
  return {
    emit,
    on<E extends keyof ValveEventMap>(
      event: E,
      listener: (payload: ValveEventMap[E]) => void,
    ) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(listener as (payload: never) => void);
      return () => {
        set.delete(listener as (payload: never) => void);
      };
    },
  };
}
