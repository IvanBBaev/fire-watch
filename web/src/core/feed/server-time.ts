/**
 * Server-time estimation (ADR-003 A1.6). Staleness math must never read the raw device
 * clock: a device hours off would fabricate a staleness banner over fresh data, or hide
 * one over stale data. Every successful snapshot response — including the 304s that are a
 * polling client's common case — contributes one sample of where the server thinks "now"
 * is, and `serverNow()` is that estimate carried forward by *elapsed* time only.
 *
 * Per sample: `serverTime = Date header + Age seconds + rtt/2`. The `Date` header is what
 * the origin stamped; a CDN HIT serves a stored `Date`, which is why the cache `Age` is
 * added back; half the measured request duration approximates the transit delay of the
 * response leg. The sample is stored as an *anchor*, `serverTime − monotonicNow` at the
 * moment the response arrived, and `serverNow()` is the median anchor plus the monotonic
 * clock now. The device wall clock contributes no absolute term at all — so an NTP
 * correction, a manual clock change, or a laptop resuming from sleep cannot move the
 * banner; only a monotonic advance does.
 *
 * `Date` has 1-second resolution, so an estimate within 2 s of the device clock is
 * reported *as* the device clock — the banner must not churn on rounding, and inside the
 * deadband the device reading is the smoother of the two.
 *
 * A response with no usable `Date` header contributes nothing: the previous anchors
 * hold. Before the first sample `serverNow()` is the device clock — the tracker never
 * invents an offset and never falls back silently once it has data.
 */

import type { Clock, ServerNow } from '../ports.js';

/** Samples kept for the median (ADR-003 A1.6: "median of the last 5 samples"). */
const SAMPLE_WINDOW = 5;

/** Estimates within this of the device clock are reported as the device clock. */
const OFFSET_DEADBAND_MS = 2000;

/** HTTP `Age` is `delta-seconds` — a plain non-negative integer; anything else is noise. */
const AGE_SECONDS = /^\d+$/;

export interface ServerTimeTracker {
  /**
   * Record one response's `Date`/`Age` headers together with the measured round-trip
   * time of the request that produced them, anchored to the monotonic clock at the
   * moment of the call — so call it right after the response arrives. Unparseable or
   * missing `Date` is skipped.
   */
  observe(headers: { date: string | null; age: string | null }, rttMs: number): void;
  /** Epoch ms in server time: the median anchor carried forward by monotonic time. */
  serverNow: ServerNow;
  /** `serverNow() − clock.epochNow()` (0 inside the deadband) — diagnostics and tests. */
  offsetMs(): number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? 0;
  return (lower + upper) / 2;
}

function ageMs(header: string | null): number {
  if (header === null) return 0;
  const trimmed = header.trim();
  return AGE_SECONDS.test(trimmed) ? Number.parseInt(trimmed, 10) * 1000 : 0;
}

export function createServerTimeTracker(clock: Clock): ServerTimeTracker {
  /** `serverTime − monotonicNow` per sample, newest last, at most 5. */
  const anchors: number[] = [];

  const serverNow: ServerNow = () => {
    const deviceNow = clock.epochNow();
    if (anchors.length === 0) return deviceNow;
    const estimate = median(anchors) + clock.monotonicNow();
    return Math.abs(estimate - deviceNow) < OFFSET_DEADBAND_MS ? deviceNow : estimate;
  };

  return {
    observe: (headers, rttMs) => {
      if (headers.date === null) return;
      const dateMs = Date.parse(headers.date);
      if (Number.isNaN(dateMs)) return;
      const serverTime = dateMs + ageMs(headers.age) + rttMs / 2;
      anchors.push(serverTime - clock.monotonicNow());
      if (anchors.length > SAMPLE_WINDOW) anchors.shift();
    },
    serverNow,
    offsetMs: () => serverNow() - clock.epochNow(),
  };
}
