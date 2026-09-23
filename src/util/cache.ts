interface Entry<T> {
  value: T;
  expires: number;
}

/** Tiny in-process TTL cache; keeps repeat scans from re-hitting the same APIs. */
export class TtlCache<T> {
  #store = new Map<string, Entry<T>>();
  #ttlMs: number;
  #max: number;

  constructor(ttlMs: number, max = 2000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  get(key: string): T | undefined {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.#store.size >= this.#max) {
      const oldest = this.#store.keys().next();
      if (!oldest.done) this.#store.delete(oldest.value);
    }
    this.#store.set(key, { value, expires: Date.now() + this.#ttlMs });
  }

  clear(): void {
    this.#store.clear();
  }

  async wrap(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }
}
