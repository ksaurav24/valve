// Bound the unread branch created by Request.clone before allowing replay.
export async function canReplayBody(
  request: Request,
  limit: number,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const reader = request.clone().body!.getReader();
  const cancel = () => {
    // A tee's cancellation waits for its sibling. Awaiting here would prevent
    // fetch from consuming that sibling. Source failures surface on that body.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let size = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return true;
      if (!(value instanceof Uint8Array)) return false;
      size += value.byteLength;
      // Empty chunks also occupy the unread branch's queue.
      if (size > limit || ++chunks > 1024) return false;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
