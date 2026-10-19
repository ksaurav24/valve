// Streaming NDJSON writer with bounded memory: records go to disk as they finish, never to IPC.
// The legacy harnesses accumulated logs in memory and shipped them over IPC (5 GiB at 64 workers).
import { createWriteStream, type WriteStream } from 'node:fs';
import { encode } from '../core/codec.ts';

export class Recorder {
  private stream: WriteStream;
  private buffer: string[] = [];
  private bytes = 0;
  private error: Error | undefined;
  private totalBytes = 0;
  count = 0;

  constructor(
    path: string,
    private flushBytes = 1 << 16,
    private maxBytes = 64 * 1024 ** 2,
  ) {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.stream.on('error', (error) => {
      this.error = error;
    });
  }

  write(record: unknown) {
    const line = encode(record) + '\n';
    if (this.error) throw this.error;
    this.totalBytes += Buffer.byteLength(line);
    if (this.totalBytes > this.maxBytes)
      throw new Error(
        'recording budget exceeded; reduce offered load or trial duration',
      );
    this.buffer.push(line);
    this.bytes += line.length;
    this.count++;
    if (this.bytes >= this.flushBytes) this.flush();
  }

  private flush() {
    if (!this.buffer.length) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.bytes = 0;
    // Never retain an unbounded chain of closures while the disk falls behind. Failing the
    // trial preserves its evidence and exposes recorder saturation instead of biasing load.
    if (this.stream.writableLength > 4 * 1024 ** 2)
      throw new Error('recorder disk backpressure exceeded 4 MiB');
    this.stream.write(chunk);
  }

  async close() {
    this.flush();
    if (this.error) throw this.error;
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });
  }
}
