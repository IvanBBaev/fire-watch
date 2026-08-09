/**
 * Canonical JSON — the one serialization anything determinism-critical is compared or
 * digested through (ADR-002 D7).
 *
 * `JSON.stringify` is not enough on its own: it preserves key insertion order, so two
 * code paths that build the same object in a different sequence produce different bytes.
 * That is fine for a log line and fatal for CI-2, which asserts that two runs of the
 * same replay are byte-identical, and for the config digests that let a report cite the
 * parameters it ran under.
 *
 * Two values are also refused outright rather than silently mangled: non-finite numbers
 * (`JSON.stringify` turns them into `null`, so `NaN` and `Infinity` would digest the
 * same) and `undefined` members (dropped by `JSON.stringify` inside objects but turned
 * into `null` inside arrays — the inconsistency is the problem).
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonical JSON requires finite numbers');
    }
    if (value === undefined) {
      throw new TypeError('canonical JSON has no undefined — omit the key instead');
    }
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${body.join(',')}}`;
}
