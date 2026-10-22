/**
 * Curated statements — the vocabulary and the refusal rules of the WP6 admin form
 * (review 16 §5.2–§5.5, §5.10; GATES.md §3 L-15).
 *
 * A curated statement is the only way an official lifecycle state
 * (`officially_contained`, `officially_extinguished`) or a correction of one reaches the
 * public record. The machine never writes one. A curator fills the form, a second staff
 * member reviews it (two-person approval), and only then is it published.
 *
 * The rules live here, not in the server or the web, because both apply them: the form
 * refuses before it sends, and the server refuses again because the form is not trusted.
 * A rule that existed on one side only would drift.
 *
 * **Not decided here (founder sign-off, review 16 §6):** the Bulgarian normative wording
 * of each statement type, whether a T2 bulletin alone may carry a state (§5.2 says it may;
 * §5.3 asks for two sources — the stricter §5.3 is applied until the founder rules), and
 * whether the life-safety relay exception applies to curated states at all (§6 Q2; it is
 * listed so the vocabulary is complete, and refused as not applicable).
 */

import { CURATED_LIFECYCLE_STATES, type CuratedLifecycleState } from './lifecycle.js';

/**
 * The source ladder (review 16 §5.2).
 *
 * - `T1` official, durable (a ГДПБЗН bulletin, an official register).
 * - `T2` official, ephemeral (an official social post; the capture is mandatory).
 * - `T3` journalistic: may be quoted as a report, never as an operational state.
 * - `T4` unverified (social media at large): never in the public voice — refused.
 */
export const SOURCE_TIERS = ['T1', 'T2', 'T3', 'T4'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/** The tiers a public statement may cite at all; `T4` is refused outright (§5.10). */
export const PUBLISHABLE_SOURCE_TIERS: readonly SourceTier[] = ['T1', 'T2', 'T3'];

/** The tiers that are an authority speaking (§5.3: one of the two sources must be one). */
export const OFFICIAL_SOURCE_TIERS: readonly SourceTier[] = ['T1', 'T2'];

/**
 * What a curated statement says. The two official states, plus a correction of an
 * earlier curated statement (§5.5). The vocabulary is frozen: there is no free-text
 * state, and the form offers nothing else.
 */
export const CURATED_STATEMENT_TYPES = [...CURATED_LIFECYCLE_STATES, 'curated_correction'] as const;
export type CuratedStatementType = CuratedLifecycleState | 'curated_correction';

/**
 * The three §5.3 exceptions to the two-source rule.
 *
 * - `t1_de_escalation` — a T1 bulletin alone may de-escalate (an official
 *   `локализиран`/`ликвидиран` notice).
 * - `life_safety_relay` — shown, never pushed. Whether it applies to a curated *state*
 *   is open (§6 Q2), so the validator refuses it as not applicable for now.
 * - `own_correction` — our own correction of our own earlier statement.
 */
export const TWO_SOURCE_EXCEPTIONS = [
  't1_de_escalation',
  'life_safety_relay',
  'own_correction',
] as const;
export type TwoSourceException = (typeof TWO_SOURCE_EXCEPTIONS)[number];

/** The longest one-line justification the form accepts (§5.10: "one line"). */
export const JUSTIFICATION_MAX_LENGTH = 280;

/** The longest "what is now known" clause of a correction. */
export const CORRECTION_TEXT_MAX_LENGTH = 500;

/** The longest event identifier the form accepts. */
export const EVENT_ID_MAX_LENGTH = 64;

/** The longest source URL or capture reference the form accepts. */
export const SOURCE_REFERENCE_MAX_LENGTH = 2048;

/**
 * A cited source. `capture` is the evidence (an archived copy's reference — a stored
 * object key or an archive URL): it is kept for review and audit and **never served**
 * (§5.4). `url` is what a reader is linked to.
 */
export interface StatementSource {
  readonly tier: SourceTier;
  readonly url: string;
  readonly capture: string;
}

/** The form's fields (§5.10), as the client sends them. The curator is the session. */
export interface CuratedStatementDraft {
  readonly eventId: string;
  readonly statementType: CuratedStatementType;
  readonly source: StatementSource;
  /** The authority's own timestamp, not the time it was entered (ISO 8601). */
  readonly statedAt: string;
  readonly secondSource: StatementSource | null;
  readonly exception: TwoSourceException | null;
  readonly justification: string;
  /** A correction only: what is now known (§5.5 copy shape). */
  readonly correctionText: string | null;
}

/**
 * Why a draft cannot be saved. One code per rule, so the form can point at the field.
 *
 * Two of them are the refusals §5.10 names: `source_unverified` (T4 cited for a public
 * statement) and `capture_missing` (no evidence attached).
 */
export const STATEMENT_ISSUES = [
  'event_id_invalid',
  'statement_type_invalid',
  'source_tier_invalid',
  'source_unverified',
  'source_url_invalid',
  'capture_missing',
  'stated_at_invalid',
  'stated_at_in_future',
  'journalistic_source_for_state',
  'second_source_required',
  'official_source_missing',
  'second_source_unverified',
  'second_source_not_independent',
  'second_source_capture_missing',
  'second_source_url_invalid',
  'exception_invalid',
  'exception_not_applicable',
  'justification_missing',
  'justification_not_one_line',
  'correction_text_missing',
  'correction_text_invalid',
  'correction_text_not_allowed',
] as const;
export type StatementIssue = (typeof STATEMENT_ISSUES)[number];

export function isSourceTier(value: unknown): value is SourceTier {
  return typeof value === 'string' && (SOURCE_TIERS as readonly string[]).includes(value);
}

export function isCuratedStatementType(value: unknown): value is CuratedStatementType {
  return (
    typeof value === 'string' && (CURATED_STATEMENT_TYPES as readonly string[]).includes(value)
  );
}

export function isTwoSourceException(value: unknown): value is TwoSourceException {
  return typeof value === 'string' && (TWO_SOURCE_EXCEPTIONS as readonly string[]).includes(value);
}

/** An absolute http(s) URL with a host; nothing else is a link a reader can follow. */
export function isSourceUrl(value: string): boolean {
  if (value.length === 0 || value.length > SOURCE_REFERENCE_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** A URL compared for independence: scheme, case of the host and a trailing slash ignored. */
function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL): string => u.pathname.replace(/\/+$/, '');
    return (
      x.hostname.toLowerCase() === y.hostname.toLowerCase() &&
      path(x) === path(y) &&
      x.search === y.search
    );
  } catch {
    return a === b;
  }
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// A line break of any kind, including the Unicode line and paragraph separators.
const LINE_BREAK = /[\r\n\u2028\u2029]/;
// The C0/C1 controls other than the line breaks checked above.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function checkSource(
  source: StatementSource,
  issues: StatementIssue[],
  codes: {
    readonly unverified: StatementIssue;
    readonly url: StatementIssue;
    readonly capture: StatementIssue;
  },
): void {
  if (!isSourceTier(source.tier)) issues.push('source_tier_invalid');
  else if (!PUBLISHABLE_SOURCE_TIERS.includes(source.tier)) issues.push(codes.unverified);
  if (!isSourceUrl(source.url)) issues.push(codes.url);
  if (source.capture.trim().length === 0 || source.capture.length > SOURCE_REFERENCE_MAX_LENGTH) {
    issues.push(codes.capture);
  }
}

/**
 * Every rule a draft breaks, in a stable order; an empty list means it may be saved.
 *
 * Saving is not publishing: a saved draft still needs a second staff member's approval.
 * `now` is the server's clock (or the browser's, for the form's early answer).
 */
export function validateCuratedStatement(
  draft: CuratedStatementDraft,
  now: Date,
): readonly StatementIssue[] {
  const issues: StatementIssue[] = [];

  if (
    draft.eventId.length === 0 ||
    draft.eventId.length > EVENT_ID_MAX_LENGTH ||
    !EVENT_ID.test(draft.eventId)
  ) {
    issues.push('event_id_invalid');
  }
  const typeKnown = isCuratedStatementType(draft.statementType);
  if (!typeKnown) issues.push('statement_type_invalid');
  const isCorrection = draft.statementType === 'curated_correction';

  checkSource(draft.source, issues, {
    unverified: 'source_unverified',
    url: 'source_url_invalid',
    capture: 'capture_missing',
  });

  const stated = Date.parse(draft.statedAt);
  if (Number.isNaN(stated)) issues.push('stated_at_invalid');
  else if (stated > now.getTime()) issues.push('stated_at_in_future');

  // §5.3: a journalistic report is never an operational state in our voice. A correction
  // may cite one (it says what is now known, not what an authority declared).
  if (typeKnown && !isCorrection && draft.source.tier === 'T3') {
    issues.push('journalistic_source_for_state');
  }

  // The two-source rule and its exceptions.
  let exceptionHolds = false;
  if (draft.exception !== null) {
    if (!isTwoSourceException(draft.exception)) issues.push('exception_invalid');
    else if (draft.exception === 't1_de_escalation') {
      if (draft.source.tier === 'T1' && typeKnown && !isCorrection) exceptionHolds = true;
      else issues.push('exception_not_applicable');
    } else if (draft.exception === 'own_correction') {
      if (isCorrection) exceptionHolds = true;
      else issues.push('exception_not_applicable');
    } else {
      // life_safety_relay: shown, never pushed — not a basis for a curated state (§6 Q2).
      issues.push('exception_not_applicable');
    }
  }

  if (draft.secondSource !== null) {
    checkSource(draft.secondSource, issues, {
      unverified: 'second_source_unverified',
      url: 'second_source_url_invalid',
      capture: 'second_source_capture_missing',
    });
    if (sameDocument(draft.source.url, draft.secondSource.url)) {
      issues.push('second_source_not_independent');
    }
    const official = (tier: SourceTier): boolean => OFFICIAL_SOURCE_TIERS.includes(tier);
    if (!official(draft.source.tier) && !official(draft.secondSource.tier) && !exceptionHolds) {
      // §5.3: two sources, at least one of them an authority.
      issues.push('official_source_missing');
    }
  } else if (!exceptionHolds) {
    issues.push('second_source_required');
  }

  const justification = draft.justification.trim();
  if (justification.length === 0) issues.push('justification_missing');
  else if (
    LINE_BREAK.test(draft.justification) ||
    CONTROL.test(draft.justification) ||
    draft.justification.length > JUSTIFICATION_MAX_LENGTH
  ) {
    issues.push('justification_not_one_line');
  }

  if (isCorrection) {
    const text = draft.correctionText ?? '';
    if (text.trim().length === 0) issues.push('correction_text_missing');
    else if (CONTROL.test(text) || text.length > CORRECTION_TEXT_MAX_LENGTH) {
      issues.push('correction_text_invalid');
    }
  } else if (draft.correctionText !== null) {
    issues.push('correction_text_not_allowed');
  }

  return issues;
}

/**
 * Read an untrusted JSON body into a draft, or `null` when its shape is wrong. Shape
 * only: the rules are `validateCuratedStatement`'s.
 */
export function parseCuratedStatementDraft(body: unknown): CuratedStatementDraft | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const source = parseSource(b['source']);
  if (source === null) return null;
  const second = b['secondSource'] ?? null;
  const secondSource = second === null ? null : parseSource(second);
  if (second !== null && secondSource === null) return null;
  const exception = b['exception'] ?? null;
  const correctionText = b['correctionText'] ?? null;
  if (
    typeof b['eventId'] !== 'string' ||
    typeof b['statementType'] !== 'string' ||
    typeof b['statedAt'] !== 'string' ||
    typeof b['justification'] !== 'string' ||
    (exception !== null && typeof exception !== 'string') ||
    (correctionText !== null && typeof correctionText !== 'string')
  ) {
    return null;
  }
  return {
    eventId: b['eventId'],
    statementType: b['statementType'] as CuratedStatementType,
    source,
    statedAt: b['statedAt'],
    secondSource,
    exception: exception as TwoSourceException | null,
    justification: b['justification'],
    correctionText: correctionText,
  };
}

function parseSource(value: unknown): StatementSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s['tier'] !== 'string' ||
    typeof s['url'] !== 'string' ||
    typeof s['capture'] !== 'string'
  ) {
    return null;
  }
  return { tier: s['tier'] as SourceTier, url: s['url'], capture: s['capture'] };
}

/**
 * What a reader may see of a statement: everything but the captures (§5.4 — the capture
 * is evidence, never served) and the internal justification.
 */
export interface PublicStatementView {
  readonly eventId: string;
  readonly statementType: CuratedStatementType;
  readonly source: { readonly tier: SourceTier; readonly url: string };
  readonly statedAt: string;
  readonly secondSource: { readonly tier: SourceTier; readonly url: string } | null;
  readonly correctionText: string | null;
}

export function publicViewOf(draft: CuratedStatementDraft): PublicStatementView {
  return {
    eventId: draft.eventId,
    statementType: draft.statementType,
    source: { tier: draft.source.tier, url: draft.source.url },
    statedAt: draft.statedAt,
    secondSource:
      draft.secondSource === null
        ? null
        : { tier: draft.secondSource.tier, url: draft.secondSource.url },
    correctionText: draft.correctionText,
  };
}
