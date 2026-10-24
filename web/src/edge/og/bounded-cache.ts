/**
 * A least-recently-used cache bounded twice — by entry count and by total bytes — for the
 * rendered og:image PNGs (TASKS V2-D4). An edge isolate is long-lived and shared across
 * requests, and a crawler walking every permalink must not be able to grow it without
 * limit; whichever bound is hit first evicts the oldest entry.
 *
 * A value larger than the byte bound on its own is not stored at all: caching it would
 * mean evicting everything else to hold one image.
 */

export interface CacheBounds {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export class BoundedCache<V extends { readonly byteLength: number }> {
  readonly #entries = new Map<string, V>();
  #bytes = 0;

  constructor(readonly bounds: CacheBounds) {}

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert so iteration order stays least-recently-used first.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#entries.delete(key);
      this.#bytes -= previous.byteLength;
    }
    if (value.byteLength > this.bounds.maxBytes || this.bounds.maxEntries < 1) return;
    this.#entries.set(key, value);
    this.#bytes += value.byteLength;
    while (this.#entries.size > this.bounds.maxEntries || this.#bytes > this.bounds.maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      const evicted = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (evicted !== undefined) this.#bytes -= evicted.byteLength;
    }
  }
}
