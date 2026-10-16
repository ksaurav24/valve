// A FIFO ring that promotes to a priority heap when priorities differ or a
// requeued job would otherwise land behind later submissions.
export interface Queued {
  seq: number;
  priority: number;
  state: 'queued' | 'running' | 'settled' | 'cancelled';
}
export class JobQueue<T extends Queued> {
  private items: T[] = [];
  private head = 0;
  private heap = false;
  private priority = 0;
  private last = -1;
  private cancelled = false;
  size = 0;
  private better(a: T, b: T) {
    return (
      a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)
    );
  }
  push(job: T) {
    if (!this.size && this.head === this.items.length) {
      this.items = [];
      this.head = 0;
      this.heap = false;
      this.cancelled = false;
    }
    if (
      !this.heap &&
      this.size > 0 &&
      (job.priority !== this.priority || job.seq < this.last)
    ) {
      this.items = this.items
        .slice(this.head)
        .filter((j) => j.state === 'queued');
      this.head = 0;
      this.heap = true;
      this.cancelled = false;
      const all = this.items;
      this.items = [];
      for (const item of all) this.insert(item);
    }
    this.priority = job.priority;
    this.last = job.seq;
    this.size++;
    if (this.heap) this.insert(job);
    else this.items.push(job);
  }
  private insert(job: T) {
    let i = this.items.length;
    this.items.push(job);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!this.better(job, this.items[parent]!)) break;
      this.items[i] = this.items[parent]!;
      i = parent;
    }
    this.items[i] = job;
  }
  private siftDown(i: number, job: T) {
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (
        child + 1 < this.items.length &&
        this.better(this.items[child + 1]!, this.items[child]!)
      )
        child++;
      if (!this.better(this.items[child]!, job)) break;
      this.items[i] = this.items[child]!;
      i = child;
    }
    this.items[i] = job;
  }
  private compact() {
    if (!this.size) {
      this.items = [];
      this.head = 0;
      this.heap = false;
      this.cancelled = false;
    } else if (this.items.length > 1024 && this.items.length > this.size * 2) {
      // Drop consumed FIFO entries as well as cancellation tombstones.
      this.items = this.items
        .slice(this.head)
        .filter((job) => job.state === 'queued');
      this.head = 0;
      this.cancelled = false;
      // Filtering a heap can break its ordering; rebuild it in linear time.
      if (this.heap)
        for (let i = (this.items.length >>> 1) - 1; i >= 0; i--)
          this.siftDown(i, this.items[i]!);
    }
  }
  private popRaw(): T | undefined {
    if (!this.heap) {
      const job = this.items[this.head++];
      if (this.head > 1024 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
      return job;
    }
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) this.siftDown(0, last);
    return first;
  }
  take(count: number): T[] {
    const jobs: T[] = [];
    while (this.size > 0 && jobs.length < count) {
      const job = this.popRaw();
      if (!job) break;
      if (job.state === 'queued') {
        this.size--;
        jobs.push(job);
      }
    }
    // Ordinary FIFO consumption already compacts in popRaw.
    if (!this.size || this.cancelled) this.compact();
    return jobs;
  }
  cancel(job: T) {
    if (job.state === 'queued') {
      this.size--;
      job.state = 'cancelled';
      this.cancelled = true;
      this.compact();
    }
  }
}
