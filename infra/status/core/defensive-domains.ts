/**
 * Defensive-domain candidates: the look-alikes of our name an attacker would register to
 * send a fake "evacuate" message or host a fake map (TASKS J5; security review 05 T17).
 *
 * This generates a *checklist*, nothing more. It registers nothing, resolves nothing and
 * decides nothing: which names are worth money is a founder call (README). It is pure and
 * deterministic — the same input always yields the same sorted list — so the checklist in
 * a pull request diff means something.
 *
 * Every candidate carries a priority:
 *
 *   - `register` — the name itself on another TLD. Someone *will* take these.
 *   - `consider` — the variants people actually type or misread on the primary TLD
 *     (hyphenation, a Latin-lookalike letter, an obvious affix such as `-bg`), and
 *     whole-script Cyrillic look-alikes, which registries do not block.
 *   - `monitor` — the long tail (single-key typos on secondary TLDs, mixed-script IDNs
 *     that most registries refuse). Watch certificate-transparency logs for these rather
 *     than buy them.
 */

import { domainToASCII } from 'node:url';

import { isValidLabel } from './domain-name.js';

export const CANDIDATE_KINDS = [
  'tld-variant',
  'hyphenation',
  'affix',
  'ascii-homoglyph',
  'idn-homoglyph',
  'omission',
  'repetition',
  'transposition',
  'adjacent-key',
  'vowel-swap',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const PRIORITIES = ['register', 'consider', 'monitor'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Candidate {
  /** The name as DNS stores it (`xn--…` for an IDN). */
  readonly domain: string;
  /** The name as a reader sees it (Unicode for an IDN). */
  readonly display: string;
  readonly kind: CandidateKind;
  readonly priority: Priority;
}

export interface CandidateOptions {
  /** The second-level label, ASCII — e.g. `firewatch`. */
  readonly name: string;
  /** TLDs without the dot, primary first — e.g. `['bg', 'com', 'eu']`. IDN TLDs as A-labels. */
  readonly tlds: readonly string[];
  /** Words appended or prepended as `affix` candidates. */
  readonly affixes?: readonly string[];
}

export const DEFAULT_TLDS = ['bg', 'com', 'eu'] as const;
export const DEFAULT_AFFIXES = ['bg', 'alert', 'alerts', 'map'] as const;

const VOWELS = ['a', 'e', 'i', 'o', 'u'];

const QWERTY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Keys horizontally or vertically next to each key on a QWERTY layout. */
export const ADJACENT_KEYS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  QWERTY_ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const near = new Set<string>();
      for (const [dr, dc] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [-1, 1],
        [1, 0],
        [1, -1],
      ] as const) {
        const key = QWERTY_ROWS[r + dr]?.[c + dc];
        if (key !== undefined) near.add(key);
      }
      map.set(ch, [...near].sort().join(''));
    });
  });
  return map;
})();

/** Latin sequences that read as another in common fonts, both directions. */
const ASCII_HOMOGLYPHS: readonly (readonly [string, string])[] = [
  ['m', 'rn'],
  ['w', 'vv'],
  ['d', 'cl'],
  ['l', '1'],
  ['l', 'i'],
  ['i', 'l'],
  ['i', '1'],
  ['o', '0'],
  ['g', 'q'],
];

/**
 * Bulgarian-alphabet Cyrillic letters indistinguishable from a Latin letter in most
 * fonts. Restricted to the Bulgarian alphabet on purpose: that is what `.бг` accepts and
 * what a Bulgarian keyboard produces by accident.
 */
export const CYRILLIC_CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ['a', 'а'],
  ['c', 'с'],
  ['e', 'е'],
  ['k', 'к'],
  ['o', 'о'],
  ['p', 'р'],
  ['x', 'х'],
  ['y', 'у'],
]);

function* labelVariants(label: string): Generator<readonly [string, CandidateKind]> {
  const chars = [...label];
  // Hyphenation: remove existing hyphens, or add one between any two letters.
  if (label.includes('-')) yield [label.replace(/-/g, ''), 'hyphenation'];
  for (let i = 1; i < chars.length; i += 1) {
    if (chars[i - 1] !== '-' && chars[i] !== '-') {
      yield [`${label.slice(0, i)}-${label.slice(i)}`, 'hyphenation'];
    }
  }
  for (let i = 0; i < chars.length; i += 1) {
    const before = label.slice(0, i);
    const ch = chars[i] ?? '';
    const after = label.slice(i + 1);
    yield [before + after, 'omission'];
    yield [before + ch + ch + after, 'repetition'];
    if (i + 1 < chars.length && chars[i + 1] !== ch) {
      yield [before + (chars[i + 1] ?? '') + ch + label.slice(i + 2), 'transposition'];
    }
    for (const near of ADJACENT_KEYS.get(ch) ?? '') yield [before + near + after, 'adjacent-key'];
    if (VOWELS.includes(ch)) {
      for (const v of VOWELS) if (v !== ch) yield [before + v + after, 'vowel-swap'];
    }
  }
  for (const [from, to] of ASCII_HOMOGLYPHS) {
    for (let at = label.indexOf(from); at !== -1; at = label.indexOf(from, at + 1)) {
      yield [label.slice(0, at) + to + label.slice(at + from.length), 'ascii-homoglyph'];
    }
    for (let at = label.indexOf(to); at !== -1; at = label.indexOf(to, at + 1)) {
      yield [label.slice(0, at) + from + label.slice(at + to.length), 'ascii-homoglyph'];
    }
  }
}

/** Unicode look-alikes of `label`: each single confusable letter, and the whole-script one. */
function idnVariants(label: string): { readonly unicode: string; readonly wholeScript: boolean }[] {
  const chars = [...label];
  const out: { unicode: string; wholeScript: boolean }[] = [];
  chars.forEach((ch, i) => {
    const cyr = CYRILLIC_CONFUSABLES.get(ch);
    if (cyr !== undefined) {
      out.push({
        unicode: [...chars.slice(0, i), cyr, ...chars.slice(i + 1)].join(''),
        wholeScript: false,
      });
    }
  });
  const letters = chars.filter((ch) => ch !== '-' && !/[0-9]/.test(ch));
  if (letters.length > 0 && letters.every((ch) => CYRILLIC_CONFUSABLES.has(ch))) {
    out.push({
      unicode: chars.map((ch) => CYRILLIC_CONFUSABLES.get(ch) ?? ch).join(''),
      wholeScript: true,
    });
  }
  return out;
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { register: 0, consider: 1, monitor: 2 };

const TYPO_KINDS: ReadonlySet<CandidateKind> = new Set([
  'omission',
  'repetition',
  'transposition',
  'adjacent-key',
  'vowel-swap',
]);

function priorityOf(kind: CandidateKind, onPrimaryTld: boolean): Priority {
  if (kind === 'tld-variant') return 'register';
  if (TYPO_KINDS.has(kind)) return 'monitor';
  return onPrimaryTld ? 'consider' : 'monitor';
}

/**
 * The candidate list for `name` across `tlds`. The primary domain (`name` on the first
 * TLD) is never in it. Throws on an invalid `name` or TLD — a typo in the input must not
 * silently yield an empty checklist.
 */
export function generateCandidates(options: CandidateOptions): readonly Candidate[] {
  const name = options.name.trim().toLowerCase();
  if (!isValidLabel(name)) throw new RangeError(`not a valid domain label: "${options.name}"`);
  if (options.tlds.length === 0) throw new RangeError('at least one TLD is required');
  const tlds = options.tlds.map((t) => t.trim().toLowerCase().replace(/^\./, ''));
  for (const tld of tlds) {
    if (!isValidLabel(tld)) throw new RangeError(`not a valid TLD label: "${tld}"`);
  }
  const primary = `${name}.${tlds[0] ?? ''}`;
  const affixes = options.affixes ?? DEFAULT_AFFIXES;
  const best = new Map<string, Candidate>();

  const add = (
    label: string,
    tld: string,
    kind: CandidateKind,
    display: string | null = null,
    forced: Priority | null = null,
  ): void => {
    if (!isValidLabel(label)) return;
    const domain = `${label}.${tld}`;
    if (domain === primary) return;
    const candidate: Candidate = {
      domain,
      display: display === null ? domain : `${display}.${tld}`,
      kind,
      priority: forced ?? priorityOf(kind, tld === tlds[0]),
    };
    const existing = best.get(domain);
    if (
      existing === undefined ||
      PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[existing.priority] ||
      (candidate.priority === existing.priority &&
        CANDIDATE_KINDS.indexOf(candidate.kind) < CANDIDATE_KINDS.indexOf(existing.kind))
    ) {
      best.set(domain, candidate);
    }
  };

  tlds.forEach((tld, index) => {
    if (index > 0) add(name, tld, 'tld-variant');
    for (const [label, kind] of labelVariants(name)) add(label, tld, kind);
    for (const affix of affixes) {
      add(`${name}${affix}`, tld, 'affix');
      add(`${name}-${affix}`, tld, 'affix');
      add(`${affix}${name}`, tld, 'affix');
      add(`${affix}-${name}`, tld, 'affix');
    }
    for (const { unicode, wholeScript } of idnVariants(name)) {
      const ascii = domainToASCII(`${unicode}.${tld}`);
      const label = ascii.split('.')[0] ?? '';
      if (ascii.length === 0 || !label.startsWith('xn--')) continue;
      add(label, tld, 'idn-homoglyph', unicode, wholeScript ? 'consider' : 'monitor');
    }
  });

  return [...best.values()].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      CANDIDATE_KINDS.indexOf(a.kind) - CANDIDATE_KINDS.indexOf(b.kind) ||
      (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
  );
}
