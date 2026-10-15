// Indexed min-heap: cancellation removes references immediately, without tombstones.
export class DelayedQueue<T extends { seq: number }> {
  private epoch = 0;
  private items: { job: T; at: number; epoch: number }[] = [];
  private positions = new Map<T, number>();
  get size(): number {
    return this.items.length;
  }
  get next(): number {
    const first = this.items[0];
    return first ? (first.epoch < this.epoch ? -Infinity : first.at) : Infinity;
  }
  /** Invalidate all existing hints in O(1); newly denied jobs keep their new hints. */
  wake() {
    if (this.items.length) this.epoch++;
  }
  private before(
    a: { job: T; at: number; epoch: number },
    b: { job: T; at: number; epoch: number },
  ) {
    return (
      a.epoch < b.epoch ||
      (a.epoch === b.epoch &&
        (a.at < b.at || (a.at === b.at && a.job.seq < b.job.seq)))
    );
  }
  private swap(a: number, b: number) {
    const value = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = value;
    this.positions.set(this.items[a]!.job, a);
    this.positions.set(value.job, b);
  }
  private up(index: number) {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!this.before(this.items[index]!, this.items[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }
  add(job: T, at: number) {
    this.remove(job);
    this.positions.set(job, this.items.length);
    this.items.push({ job, at, epoch: this.epoch });
    this.up(this.items.length - 1);
  }
  remove(job: T) {
    const index = this.positions.get(job);
    if (index === undefined) return;
    this.positions.delete(job);
    const last = this.items.pop()!;
    if (index === this.items.length) return;
    this.items[index] = last;
    this.positions.set(last.job, index);
    let i = this.up(index);
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1;
      if (
        child + 1 < this.items.length &&
        this.before(this.items[child + 1]!, this.items[child]!)
      )
        child++;
      if (!this.before(this.items[child]!, this.items[i]!)) break;
      this.swap(i, child);
      i = child;
    }
  }
  take(now: number, count: number): T[] {
    const result: T[] = [];
    while (this.items.length && result.length < count && this.next <= now) {
      const job = this.items[0]!.job;
      this.remove(job);
      result.push(job);
    }
    return result;
  }
}
