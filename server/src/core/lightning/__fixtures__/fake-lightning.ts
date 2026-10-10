/**
 * Test doubles for the lightning ports (TASKS F18): a Data Store client that answers a
 * scripted search and returns each product's id as its bytes, and a decoder that emits
 * one synthetic flash in the middle of each window. Synthetic only — tests, never runtime.
 */

import type { VirtualClock } from '../../ports/clock.js';
import type { DecodeResult } from '../../ports/granule-decoder.js';
import type {
  LightningClient,
  LightningDownload,
  LightningProduct,
  LightningSearch,
} from '../../ports/lightning-client.js';
import type { LightningDecoder, LightningGranuleRef } from '../../ports/lightning-decoder.js';
import { LIGHTNING_PAYLOAD_FORMAT } from '../lightning-payload.js';

export class FakeClient implements LightningClient {
  searches: { startIso: string; endIso: string }[] = [];
  downloads: string[] = [];
  searchAnswer: LightningSearch = { ok: true, products: [] };
  /** When set, answers each search from the window asked for instead of `searchAnswer`. */
  searchBy: ((window: { startIso: string; endIso: string }) => LightningSearch) | null = null;
  failDownload: Map<string, LightningDownload> = new Map();

  constructor(private readonly clock: VirtualClock) {}

  search(window: { startIso: string; endIso: string }): Promise<LightningSearch> {
    this.searches.push(window);
    return Promise.resolve(this.searchBy?.(window) ?? this.searchAnswer);
  }

  downloadBody(p: LightningProduct): Promise<LightningDownload> {
    this.downloads.push(p.id);
    const failure = this.failDownload.get(p.id);
    if (failure !== undefined) return Promise.resolve(failure);
    return Promise.resolve({
      ok: true,
      bytes: new TextEncoder().encode(p.id),
      sha256: 'a'.repeat(64),
      availableAt: this.clock.now(),
    });
  }
}

/** Emits one flash in the middle of the window, or what `answer` says for a body name. */
export class FakeDecoder implements LightningDecoder {
  refs: LightningGranuleRef[] = [];
  answers = new Map<string, Partial<DecodeResult>>();

  decode(ref: LightningGranuleRef): Promise<DecodeResult> {
    this.refs.push(ref);
    const override = this.answers.get(ref.name);
    const [startIso, endIso] = ref.slotIso.split('/') as [string, string];
    const mid = (Date.parse(startIso) + Date.parse(endIso)) / 2;
    const payload = JSON.stringify({
      format: LIGHTNING_PAYLOAD_FORMAT,
      window: { start: startIso, end: endIso },
      flashes: [
        {
          t: new Date(mid).toISOString(),
          lat: 42.5,
          lon: 23.5,
          radiance: 1,
          durationMs: 2,
          footprint: 3,
          falseLikelihood: 0.02,
        },
      ],
      decoder: {
        flashes: 2,
        clippedOut: 1,
        droppedWithoutPosition: 0,
        droppedWithoutTime: 0,
        droppedOutsideWindow: 0,
      },
    });
    return Promise.resolve({
      outcome: 'ok',
      payload,
      error: null,
      durationMs: 5,
      ...override,
    } as DecodeResult);
  }
}
