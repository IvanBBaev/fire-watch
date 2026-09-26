/**
 * Renders every message in a catalog, exhaustively, for the copy gates.
 *
 * The wording gates (CI-10's never-send lint, CI-11's glossary sync) are only worth
 * running if they see *all* the copy, and a hand-written list of message keys is a gate
 * that silently stops covering whatever was added last. So the list is not written down:
 * {@link renderCatalog} walks the catalog object, renders every string it reaches, and —
 * the part that makes it a guarantee rather than a habit — **throws** when it meets a
 * template function whose arguments are not registered here. A message added to
 * `messages.ts` tomorrow is therefore either linted or a red build. It cannot be skipped.
 *
 * Template parameters are bound to sentinels rather than to realistic values, so that the
 * literal copy around them stays comparable across renders. The sentinels are shared with
 * `glossary-sync.test.ts`, which splits rendered copy on them; see {@link T1} for why they
 * can neither create nor hide a wording violation.
 *
 * This is test support and is never imported by the UI, so it stays free of vitest and of
 * node builtins — `no-dev-deps-in-shipped-code` covers `web/src/**` that is not a test,
 * and the entry budget covers the rest.
 */

import type { RelativeAge } from './format.js';
import type { Messages } from './messages.js';

/**
 * Substitution sentinels for template parameters.
 *
 * They are token-shaped ASCII with a digit in the middle, and that shape is the whole
 * argument for choosing them:
 *
 * - **They cannot create a violation.** Every never-send pattern is spelled in Latin
 *   letters or in Cyrillic, and the bounded tails that carry Bulgarian inflection are
 *   `\p{Script=Cyrillic}{0,6}` / `[a-z]{0,6}` — neither can cross the `1`..`4` sitting in
 *   the middle of a sentinel, and no rule's vocabulary contains `xt` at all. Matching is
 *   on Unicode word boundaries, so a sentinel can only ever match as its own word, and it
 *   is a word no rule knows.
 * - **They cannot hide one.** A sentinel stands only where a parameter stands, and every
 *   parameter in both catalogs is a pre-formatted timestamp, a number, a place name or a
 *   pre-worded age — none of which is vocabulary any rule bans, and all of which a real
 *   render would place in exactly this slot. The `age` parameters carry
 *   {@link Messages.relativeAge}'s output in production, and that function is rendered
 *   here in all six of its branches under its own key, so its words are read too. The one
 *   parameter whose real value *is* banned vocabulary is
 *   {@link Messages.status.officialThenRedetected}'s `declaredState`; it is bound below to
 *   its real values for exactly this reason.
 * - **They cannot fuse with the copy around them**, which would move a word boundary and
 *   change what matches. That is not left to inspection: `never-send-catalog.test.ts`
 *   asserts that every sentinel occurrence is delimited by a non-word character on both
 *   sides, in every rendered message.
 */
export const T1 = 'XT1X';
export const T2 = 'XT2X';
export const T3 = 'XT3X';
export const T4 = 'XT4X';

/** Every sentinel, for callers that split on them or check their boundaries. */
export const SENTINELS: readonly string[] = [T1, T2, T3, T4];

/**
 * The count sentinel. Deliberately large and non-round so that locale grouping is
 * exercised (`285 714` / `285,714`) and so it reads as a placeholder, not as a figure.
 */
export const N = 285_714;

/** {@link N} as the catalogs' `String(...)` conversions render it, ungrouped. */
export const N_STR = String(N);

/** One rendered message: where it came from, and what it rendered to. */
export interface RenderedMessage {
  /** Dotted path into the catalog — `lifecycle.active`, `about.paragraphs[0]`. */
  readonly path: string;
  /**
   * Which registered argument tuple produced this text. A message that branches on its
   * argument renders once per branch under one path.
   */
  readonly variant: number;
  readonly text: string;
}

/**
 * Argument tuples for every template function in {@link Messages}, keyed by dotted path.
 *
 * Several tuples mean several renders: a catalog that branches on its argument (singular
 * versus plural, the four {@link RelativeAge} units) holds copy in each branch, and a
 * branch that is never rendered is copy no gate ever reads.
 *
 * Exported so a test can assert there are no stale keys — a renamed or deleted message
 * must not leave an entry behind that makes this registry look more complete than it is.
 */
export const MESSAGE_ARGUMENTS: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  'lifecycle.active': [[T1]],
  'lifecycle.signalWeakening': [[N]],
  'lifecycle.noLongerDetected': [[T1]],
  'lifecycle.officiallyContained': [[T1, T2]],
  'lifecycle.officiallyExtinguished': [[T1, T2]],
  'lifecycle.archived': [[N]],
  'status.staleSources': [[T1]],
  'status.freshnessChip': [[T1, T2, T3, T4]],
  'status.freshnessChipUnknown': [[T1, T2]],
  'status.cloudBlindClose': [[N]],
  // `declaredState` is the one parameter whose real value is itself vocabulary the
  // never-send list bans: GLOSSARY §3b writes its domain as `<локализиран|ликвидиран>`,
  // and both catalogs relay the Bulgarian term rather than translating it. A sentinel
  // here would render a sentence that reads clean while production ships a quote-tier
  // word, so both real values are bound instead — one render per value, so the lint sees
  // the sentence a reader would see.
  'status.officialThenRedetected': [
    [T1, 'локализиран', T3, T4],
    [T1, 'ликвидиран', T3, T4],
  ],
  // 320 ha is §5.2's worked example: two significant figures in both units, and large
  // enough that the дка figure crosses a grouping separator.
  areaBothUnits: [[320]],
  eventNearPlace: [[T1]],
  detectionCount: [[1], [N]],
  relativeAge: [
    [{ unit: 'now' } satisfies RelativeAge],
    [{ unit: 'minutes', minutes: 7 } satisfies RelativeAge],
    [{ unit: 'hours', hours: 3, minutes: 0 } satisfies RelativeAge],
    [{ unit: 'hours', hours: 3, minutes: 20 } satisfies RelativeAge],
    [{ unit: 'days', days: 1, hours: 0, minutes: 0 } satisfies RelativeAge],
    [{ unit: 'days', days: 13, hours: 6, minutes: 23 } satisfies RelativeAge],
  ],
  observedShort: [[T1, T2]],
  firstObserved: [[T1]],
  'shareCard.observedAt': [[T1]],
  'shareCard.madeAt': [[T1]],
  'ageWindow.olderHidden': [[1], [N]],
  'listInView.outsideView': [[1], [N]],
};

/** Raised when the walk meets a message the registry cannot render. */
export class CatalogCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogCoverageError';
  }
}

/**
 * Every message in `messages`, rendered.
 *
 * The catalog is walked, not enumerated: whatever the object holds is what comes back.
 * That is the exhaustiveness guarantee — a key added to `messages.ts` is reached on the
 * next run whether or not anyone remembered the gates.
 *
 * @throws CatalogCoverageError when a template function has no entry in
 * {@link MESSAGE_ARGUMENTS}, or when a leaf is neither a string, a function, an array nor
 * a plain object. New copy in an unregistered shape fails loudly rather than being
 * skipped, which is the one failure mode a copy gate must not have.
 */
export function renderCatalog(messages: Messages): readonly RenderedMessage[] {
  const rendered: RenderedMessage[] = [];
  walk(messages, '', rendered);
  return rendered;
}

function walk(node: unknown, path: string, out: RenderedMessage[]): void {
  if (typeof node === 'string') {
    out.push({ path, variant: 0, text: node });
    return;
  }
  if (typeof node === 'function') {
    renderTemplate(node, path, out);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item: unknown, index) => {
      walk(item, `${path}[${String(index)}]`, out);
    });
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  throw new CatalogCoverageError(
    `catalog entry ${path === '' ? '<root>' : path} is a ${typeof node}, which the copy ` +
      `gates cannot render. Give it a shape they can read, or teach the walk in ` +
      `catalog-render.ts about it.`,
  );
}

function renderTemplate(node: object, path: string, out: RenderedMessage[]): void {
  const tuples = Object.hasOwn(MESSAGE_ARGUMENTS, path) ? MESSAGE_ARGUMENTS[path] : undefined;
  if (tuples === undefined || tuples.length === 0) {
    throw new CatalogCoverageError(
      `message template "${path}" has no arguments registered in MESSAGE_ARGUMENTS ` +
        `(catalog-render.ts), so the copy gates would never render it. Register the ` +
        `argument tuples it should be linted with — one per branch it has.`,
    );
  }
  const template = node as (...args: readonly unknown[]) => unknown;
  tuples.forEach((args, variant) => {
    const text: unknown = template(...args);
    if (typeof text !== 'string') {
      throw new CatalogCoverageError(
        `message template "${path}" rendered a ${typeof text} rather than a string`,
      );
    }
    out.push({ path, variant, text });
  });
}
