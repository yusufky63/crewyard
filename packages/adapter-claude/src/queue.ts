/** Unbounded push queue with a single async consumer. end() lets the consumer drain, then stop. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(item: T): boolean {
    if (this.ended) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else this.items.push(item);
    return true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter && this.items.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.end();
        this.items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
