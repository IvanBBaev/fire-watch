/**
 * The F15 satellite-pass section's state: which cell's prediction is held, and whether it
 * is usable.
 *
 * One document at a time — the cell under the map centre or the selected fire. It is fetched
 * only while the Layers panel is open (the section lives there), re-fetched when the cell
 * changes or the copy is older than {@link PASSES_REFETCH_AFTER_MS}, and never with
 * credentials: the request names a 0.5° cell and nothing else about the reader.
 *
 * The fetch is a plain GET the section makes on demand; it adds nothing to the polling
 * supervisor and no header to a map route (CI-7).
 */

import { signal } from '@preact/signals';
import { CREDITS, renderCredit, type Credit } from '@fire-watch/contracts';

import type { Messages } from '../core/i18n/messages.js';
import type { Clock } from '../core/ports.js';
import { parsePassesDocument, passesUrl, type PassesDoc } from '../core/passes.js';
import { creditRenderContext } from './logic/credits.js';

/**
 * The server recomputes a cell every ten minutes (its bucket), so asking sooner would only
 * return the same bytes; asking later lets "next look" drift past a pass.
 */
export const PASSES_REFETCH_AFTER_MS = 10 * 60 * 1000;

/** Where the fixture build reads from when no template is configured. */
export const DEFAULT_PASSES_URL_TEMPLATE = '/api/v1/passes/{cell}';

export type PassesStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly cell: string }
  /** No usable prediction: no server, the route refused the cell, or a body we cannot read. */
  | { readonly kind: 'unavailable'; readonly cell: string; readonly fetchedAtMs: number }
  | {
      readonly kind: 'ready';
      readonly cell: string;
      readonly doc: PassesDoc;
      /** Our monotonic clock when the copy arrived — only for deciding when to re-fetch. */
      readonly fetchedAtMs: number;
    };

export const passesStatus = signal<PassesStatus>({ kind: 'idle' });

/** The browser seams the loader uses; swapped in tests. */
export interface PassesLoaderDeps {
  readonly fetch: (url: string) => Promise<Response>;
  /** Monotonic — it only ever measures a copy's age. */
  readonly now: () => number;
  readonly urlTemplate: string;
}

export const browserPassesLoader = (
  clock: Pick<Clock, 'monotonicNow'>,
  urlTemplate: string | undefined,
): PassesLoaderDeps => ({
  fetch: (url) => fetch(url, { credentials: 'omit' }),
  now: () => clock.monotonicNow(),
  urlTemplate: urlTemplate ?? DEFAULT_PASSES_URL_TEMPLATE,
});

/** Fetch one cell's prediction; every failure ends as `unavailable`, never a throw. */
export async function loadPasses(cell: string, deps: PassesLoaderDeps): Promise<void> {
  passesStatus.value = { kind: 'loading', cell };
  let doc: PassesDoc | null;
  try {
    const response = await deps.fetch(passesUrl(deps.urlTemplate, cell));
    doc = response.ok ? parsePassesDocument(await response.json()) : null;
  } catch {
    doc = null;
  }
  // A slower answer for a cell the reader has since left must not overwrite the newer one.
  const current = passesStatus.peek();
  if (current.kind !== 'loading' || current.cell !== cell) return;
  passesStatus.value =
    doc === null
      ? { kind: 'unavailable', cell, fetchedAtMs: deps.now() }
      : { kind: 'ready', cell, doc, fetchedAtMs: deps.now() };
}

/**
 * Load `cell` unless a copy for it is already in hand (or on its way) and young enough.
 * An `unavailable` answer is also held for the refetch interval, so a build without a
 * server asks once, not on every render.
 */
export function ensurePasses(cell: string, deps: PassesLoaderDeps): void {
  const status = passesStatus.peek();
  if (status.kind !== 'idle' && status.cell === cell) {
    if (status.kind === 'loading') return;
    if (deps.now() - status.fetchedAtMs < PASSES_REFETCH_AFTER_MS) return;
  }
  void loadPasses(cell, deps);
}

/** The CelesTrak credit, rendered from the contracts registry — never retyped here. */
export function celestrakCredit(
  clock: Pick<Clock, 'epochNow'>,
  messages: Pick<Messages, 'appTitle'>,
): { readonly text: string; readonly href: string | undefined } | null {
  const credit: Credit | undefined = CREDITS.find((entry) => entry.id === 'celestrak');
  if (credit === undefined) return null;
  return { text: renderCredit(credit, creditRenderContext(clock, messages)), href: credit.href };
}

/** Test seam. */
export function resetPassesForTest(): void {
  passesStatus.value = { kind: 'idle' };
}
