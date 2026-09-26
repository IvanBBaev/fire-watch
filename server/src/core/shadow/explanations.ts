/**
 * The reviewer's side of "every diff explained" (GATES L-1; IP WP6 fixture-refresh policy).
 *
 * WP6's policy is that "every explained diff either becomes a fixture or is recorded as
 * accepted, with a reason". Those are the two dispositions, and both carry a reason: a
 * fixture without a sentence saying what it pins is a fixture nobody can later decide to
 * delete, and an acceptance without one is a shrug. The fixture disposition also names the
 * fixture, so the claim "this is now covered" is checkable against `server/fixtures/`.
 *
 * An explanation is keyed by the diff's own `key`, which is built from stable identities
 * (public ids, the candidate's own event keys, zone ids, alert subkeys) and never from a
 * position in a list — so an explanation written on Tuesday still names the same diff on
 * Wednesday's re-run, and one whose diff has gone away is reported as stale rather than
 * silently kept.
 *
 * This module only parses and validates. Where the file comes from is the caller's
 * business; the core reads no files.
 */

export const DIFF_DISPOSITIONS = ['fixture', 'accepted'] as const;
export type DiffDisposition = (typeof DIFF_DISPOSITIONS)[number];

export interface DiffExplanation {
  /** A diff line's `key`, verbatim. */
  readonly key: string;
  readonly disposition: DiffDisposition;
  /** The fixture directory id (`S17`, a local name) when `disposition` is `fixture`; else `null`. */
  readonly fixtureId: string | null;
  readonly reason: string;
}

/**
 * `{"explanations": [{"key", "disposition", "fixtureId"?, "reason"}]}`. Strict: an unknown
 * field is refused, because a misspelt `fixtureID` would otherwise turn a fixture into an
 * acceptance without anyone noticing. Errors name the entry's index and the field, which
 * is enough to find it; they never echo the reason text.
 */
export function parseExplanations(document: unknown): readonly DiffExplanation[] {
  if (!isRecord(document)) throw new RangeError('explanations: the document is not an object');
  assertOnlyFields(document, ['explanations'], 'explanations');
  const entries = document['explanations'];
  if (!Array.isArray(entries)) throw new RangeError('explanations: "explanations" is not an array');

  const seen = new Set<string>();
  const parsed = entries.map((entry: unknown, index): DiffExplanation => {
    const where = `explanations[${String(index)}]`;
    if (!isRecord(entry)) throw new RangeError(`${where} is not an object`);
    assertOnlyFields(entry, ['key', 'disposition', 'fixtureId', 'reason'], where);

    const key = nonEmptyString(entry['key'], `${where}.key`);
    if (seen.has(key)) throw new RangeError(`${where}.key explains a diff already explained`);
    seen.add(key);

    const disposition = entry['disposition'];
    if (disposition !== 'fixture' && disposition !== 'accepted') {
      throw new RangeError(`${where}.disposition must be one of ${DIFF_DISPOSITIONS.join(', ')}`);
    }
    const reason = nonEmptyString(entry['reason'], `${where}.reason`);

    const rawFixtureId = entry['fixtureId'];
    let fixtureId: string | null = null;
    if (disposition === 'fixture') {
      fixtureId = nonEmptyString(rawFixtureId, `${where}.fixtureId`);
    } else if (rawFixtureId !== undefined && rawFixtureId !== null) {
      throw new RangeError(`${where}.fixtureId is only meaningful for the fixture disposition`);
    }

    return Object.freeze({ key, disposition, fixtureId, reason });
  });
  return Object.freeze(parsed);
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RangeError(`${where} must be a non-empty string`);
  }
  return value;
}

function assertOnlyFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const name of Object.keys(record)) {
    if (!allowed.includes(name)) {
      throw new RangeError(`${where} has an unknown field ${JSON.stringify(name)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
