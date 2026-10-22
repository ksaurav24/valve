// Multiplex listeners by id without taking ownership of the subscriber client.
import type { StoreNotification } from '../store.js';
import type { IoredisSubscriber, NodeRedisSubscriber } from './types.js';
export function subscriptions(
  subscriber: IoredisSubscriber | NodeRedisSubscriber,
  prefix: string,
) {
  const entries = new Map<
    string,
    {
      listeners: Set<(notice: StoreNotification) => void>;
      ready: Promise<unknown>;
      off: () => Promise<unknown>;
    }
  >();
  function deliver(channel: string, message: string) {
    const listeners = entries.get(channel)?.listeners;
    const limits = /^limits:(\d+\.\d+):([01])$/.exec(message);
    const notice: StoreNotification | undefined =
      message === 'resume' || message === 'release'
        ? { type: message }
        : /^pause:\d+$/.test(message)
          ? { type: 'pause', durationMs: Number(message.slice(6)) }
          : limits
            ? {
                type: 'limits',
                version: limits[1]!,
                relaxed: limits[2] === '1',
              }
            : undefined;
    if (notice) for (const listener of listeners ?? []) listener(notice);
  }
  const io = 'on' in subscriber && !('evalSha' in subscriber);
  const ioListener = (channel: string, message: string) =>
    deliver(channel, message);
  const ioClient = io ? (subscriber as IoredisSubscriber) : undefined;
  const nodeClient = subscriber as NodeRedisSubscriber;
  ioClient?.on('message', ioListener);
  return {
    async subscribe(id: string, listener: (notice: StoreNotification) => void) {
      const channel = `${prefix}:{${id}}:events`;
      let entry = entries.get(channel);
      if (!entry) {
        const message = (text: string | Uint8Array) => {
          if (typeof text === 'string') deliver(channel, text);
        };
        entry = {
          listeners: new Set(),
          ready: ioClient
            ? ioClient.subscribe(channel)
            : nodeClient.subscribe(channel, message),
          off: () =>
            ioClient
              ? ioClient.unsubscribe(channel)
              : nodeClient.unsubscribe(channel, message),
        };
        entries.set(channel, entry);
      }
      entry.listeners.add(listener);
      try {
        await entry.ready;
      } catch (error) {
        entry.listeners.delete(listener);
        if (!entry.listeners.size) entries.delete(channel);
        throw error;
      }
      const current = entry;
      return () => {
        current.listeners.delete(listener);
        // Keep the Redis subscription until store.close(): reuse is race-free when a new valve arrives during unsubscribe.
      };
    },
    async close() {
      ioClient?.off('message', ioListener);
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(
        pending.map(async (entry) => {
          entry.listeners.clear();
          await entry.ready.catch(() => undefined);
          await entry.off();
        }),
      );
    },
  };
}
