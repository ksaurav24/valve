import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { decode, encode } from '../core/codec.ts';

/** Acquire a local endpoint lease, recovering only a confirmed dead PID's complete record. */
export function acquireEndpointLock(
  path: string,
  metadata: Record<string, unknown> = {},
): () => void {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const contents = encode({
    ...metadata,
    pid: process.pid,
    token: randomUUID(),
  });
  const publish = () => linkSync(temporary, path);
  writeFileSync(temporary, contents, { flag: 'wx' });
  try {
    try {
      publish();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = readFileSync(path, 'utf8');
      let pid: number | undefined;
      try {
        pid = decode<{ pid?: number }>(stale).pid;
      } catch {
        /* fail closed below */
      }
      if (!Number.isSafeInteger(pid) || pid! <= 0)
        throw new Error(
          `Endpoint lock ${path} has no valid owner; inspect it before removal`,
          { cause: error },
        );
      try {
        process.kill(pid!, 0);
        throw new Error(`Endpoint lock ${path} held by live pid ${pid}`, {
          cause: error,
        });
      } catch (ownerError) {
        // EPERM and unexpected errors cannot establish that the owner is dead.
        if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH')
          throw ownerError;
      }
      // Serialize reapers so a delayed reclaimer cannot unlink a successor's live lock.
      const recovery = `${path}.recover`;
      try {
        linkSync(temporary, recovery);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `Endpoint lock recovery in progress at ${recovery}; inspect its owner if interrupted`,
            { cause: recoveryError },
          );
        throw recoveryError;
      }
      try {
        if (readFileSync(path, 'utf8') !== stale)
          throw new Error(
            `Endpoint lock ${path} changed during recovery; retry`,
            { cause: error },
          );
        rmSync(path);
        publish();
      } finally {
        rmSync(recovery, { force: true });
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8') === contents) rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
