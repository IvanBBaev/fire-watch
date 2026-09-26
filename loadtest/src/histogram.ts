/**
 * A mergeable latency histogram with bounded relative error.
 *
 * Log-spaced buckets (`GROWTH` apart) from 0.1 ms up: every recorded value is off by at
 * most half a bucket (~2.5 %), memory is a few hundred integers whatever the request
 * count, and two shards' histograms merge by adding counts — so the p95 of a sharded run
 * is the p95 of all its requests, not an average of per-shard p95s (which is wrong).
 */

const MIN_MS = 0.1;
const GROWTH = 1.05;
const LOG_GROWTH = Math.log(GROWTH);

export interface HistogramData {
  /** Sparse: bucket index → count. Index 0 holds everything at or below `MIN_MS`. */
  readonly buckets: Readonly<Record<string, number>>;
  readonly count: number;
  readonly max: number;
}

export class Histogram {
  private readonly counts = new Map<number, number>();
  private total = 0;
  private maximum = 0;

  static from(data: HistogramData): Histogram {
    const h = new Histogram();
    h.merge(data);
    return h;
  }

  record(valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const index = bucketOf(valueMs);
    this.counts.set(index, (this.counts.get(index) ?? 0) + 1);
    this.total += 1;
    if (valueMs > this.maximum) this.maximum = valueMs;
  }

  merge(data: HistogramData): void {
    for (const [key, count] of Object.entries(data.buckets)) {
      const index = Number(key);
      this.counts.set(index, (this.counts.get(index) ?? 0) + count);
    }
    this.total += data.count;
    if (data.max > this.maximum) this.maximum = data.max;
  }

  get count(): number {
    return this.total;
  }

  /** The `q` quantile (0..1), or `null` with no samples. Never above the recorded max. */
  quantile(q: number): number | null {
    if (this.total === 0) return null;
    const rank = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (const index of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(index) ?? 0;
      if (seen >= rank) return Math.min(valueOf(index), this.maximum);
    }
    return this.maximum;
  }

  toJSON(): HistogramData {
    const buckets: Record<string, number> = {};
    for (const [index, count] of [...this.counts.entries()].sort((a, b) => a[0] - b[0])) {
      buckets[String(index)] = count;
    }
    return { buckets, count: this.total, max: this.maximum };
  }
}

function bucketOf(valueMs: number): number {
  if (valueMs <= MIN_MS) return 0;
  return 1 + Math.floor(Math.log(valueMs / MIN_MS) / LOG_GROWTH);
}

/** The midpoint of a bucket in log space — the value reported for everything in it. */
function valueOf(index: number): number {
  if (index === 0) return MIN_MS;
  return MIN_MS * Math.pow(GROWTH, index - 0.5);
}
