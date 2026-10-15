/**
 * How many requests one model server is asked to take at once. A server with
 * one slot (llama.cpp `-np 1`) answers one request at a time, so the main turn,
 * its subagents, a summary and a title must queue instead of fighting over it.
 * A request holds its place only while its reply streams; between two requests
 * of a loop (a tool runs) the place is free for someone else, which is also
 * what keeps a parent waiting on its subagents from blocking them.
 */
export class RequestLimiter {
  #capacity: number;
  #active = 0;
  readonly #queue: Array<{ readonly grant: () => void; cancelled: boolean }> = [];

  constructor(capacity = Number.POSITIVE_INFINITY) {
    this.#capacity = capacity;
  }

  /** Changes apply to the next request; those already running keep their place. */
  setCapacity(capacity: number): void {
    this.#capacity = Math.max(1, capacity);
    this.#drain();
  }

  get capacity(): number {
    return this.#capacity;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.filter((entry) => !entry.cancelled).length;
  }

  /** Resolves with the function that gives the place back (once). Rejects with the abort reason if `signal` fires while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    return new Promise((resolve, reject) => {
      const entry = {
        cancelled: false,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.#active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.#active -= 1;
            this.#drain();
          });
        },
      };
      const onAbort = (): void => {
        entry.cancelled = true;
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#queue.length > 0 && this.#active < this.#capacity) {
      const next = this.#queue.shift()!;
      if (!next.cancelled) next.grant();
    }
  }
}
