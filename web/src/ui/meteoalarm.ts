/**
 * The V2-B3 official-warnings section's state: the MeteoAlarm document held, and whether it
 * is usable.
 *
 * One document for the whole polled area. It is fetched only while the Layers panel is open
 * (the section lives there), re-fetched when the copy is older than
 * {@link METEOALARM_REFETCH_AFTER_MS}, and never with credentials: the request carries
 * nothing about the reader.
 *
 * The fetch is a plain GET the section makes on demand; it adds nothing to the polling
 * supervisor and no header to a map route (CI-7).
 */

import { signal } from '@preact/signals';
import { CREDITS, renderCredit, type Credit } from '@fire-watch/contracts';

import type { Messages } from '../core/i18n/messages.js';
import type { MeteoalarmDoc } from '../core/meteoalarm.js';
import type { Clock } from '../core/ports.js';
import { creditRenderContext } from './logic/credits.js';

/** The route's edge TTL; asking sooner would only return the same bytes. */
export const METEOALARM_REFETCH_AFTER_MS = 5 * 60 * 1000;

export type MeteoalarmStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  /** No usable copy: no server, a stale feed (503), or a body we cannot read. */
  | { readonly kind: 'unavailable'; readonly fetchedAtMs: number }
  | {
      readonly kind: 'ready';
      readonly doc: MeteoalarmDoc;
      /** Our monotonic clock when the copy arrived — only for deciding when to re-fetch. */
      readonly fetchedAtMs: number;
    };

export const meteoalarmStatus = signal<MeteoalarmStatus>({ kind: 'idle' });

/** The browser seams the loader uses; swapped in tests. */
export interface MeteoalarmLoaderDeps {
  /**
   * Fetch and read the document, `null` on any failure. It ships in the section's lazy chunk
   * (`fetchMeteoalarmDocument` in `meteoalarm-view.tsx`), so the shell is handed it rather
   * than importing it (CI-12).
   */
  readonly load: (url: string) => Promise<MeteoalarmDoc | null>;
  /** Monotonic — it only ever measures a copy's age. */
  readonly now: () => number;
  readonly url: string;
}

/** Fetch the document; every failure ends as `unavailable`, never a throw. */
export async function loadMeteoalarm(deps: MeteoalarmLoaderDeps): Promise<void> {
  meteoalarmStatus.value = { kind: 'loading' };
  let doc: MeteoalarmDoc | null = null;
  try {
    doc = await deps.load(deps.url);
  } catch {
    // Already `null`: a failed load ends as unavailable like any other.
  }
  meteoalarmStatus.value =
    doc === null
      ? { kind: 'unavailable', fetchedAtMs: deps.now() }
      : { kind: 'ready', doc, fetchedAtMs: deps.now() };
}

/**
 * Load unless a copy is already in hand (or on its way) and young enough. An `unavailable`
 * answer is also held for the refetch interval, so a build without a server asks once, not
 * on every render.
 */
export function ensureMeteoalarm(deps: MeteoalarmLoaderDeps): void {
  const status = meteoalarmStatus.peek();
  if (status.kind === 'loading') return;
  if (status.kind !== 'idle' && deps.now() - status.fetchedAtMs < METEOALARM_REFETCH_AFTER_MS) {
    return;
  }
  void loadMeteoalarm(deps);
}

export interface MeteoalarmCreditText {
  readonly text: string;
  readonly href: string | undefined;
}

/** The MeteoAlarm credit, rendered from the contracts registry — never retyped here. */
export function meteoalarmCredit(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): MeteoalarmCreditText | null {
  const credit: Credit | undefined = CREDITS.find((entry) => entry.id === 'meteoalarm');
  if (credit === undefined) return null;
  return { text: renderCredit(credit, creditRenderContext(clock, messages)), href: credit.href };
}

/** Test seam. */
export function resetMeteoalarmForTest(): void {
  meteoalarmStatus.value = { kind: 'idle' };
}
