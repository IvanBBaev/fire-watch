/**
 * Every account-surface refusal carries a machine-readable `code` from the shared
 * contracts union, and every code in that union is one the server actually emits.
 *
 * The first half keeps a refusal from shipping without a code (the web client could
 * then only guess from the status). The second keeps the union honest: a code nobody
 * emits is dead weight the web must still handle, and a code the server emits but the
 * union lacks would fail to compile, so together the two make the union exactly the
 * server's output — which is the set the web client's exhaustiveness test checks against.
 */

import { isProblemCode, PROBLEM_CODES, type ProblemCode } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_EXPORT_PROBLEMS } from './account-export-route.js';
import { ACCOUNT_PROBLEMS } from './account-route.js';
import { AUTH_REFUSALS, INVALID_BODY, ORIGIN_REFUSED } from './auth-route.js';
import { CHANNEL_PROBLEMS, CHANNEL_REFUSALS } from './channel-opt-in-route.js';
import { FALLBACK_PROBLEMS } from './problem.js';
import { ZONE_REFUSALS, ZONES_PROBLEMS } from './zones-route.js';

interface Emitted {
  readonly status: number;
  readonly title: string;
  readonly code: ProblemCode;
}

const EMITTED: readonly (readonly [string, readonly Emitted[]])[] = [
  ['problem handler fallbacks', FALLBACK_PROBLEMS],
  ['shared origin and body checks', [ORIGIN_REFUSED, INVALID_BODY]],
  ['sign-in refusals', Object.values(AUTH_REFUSALS)],
  ['account', ACCOUNT_PROBLEMS],
  ['account export', ACCOUNT_EXPORT_PROBLEMS],
  ['channel refusals', Object.values(CHANNEL_REFUSALS)],
  ['channel routes', CHANNEL_PROBLEMS],
  ['zone refusals', Object.values(ZONE_REFUSALS)],
  ['zone routes', ZONES_PROBLEMS],
];

describe('problem codes', () => {
  it.each(EMITTED)('every %s refusal carries a known code', (_name, specs) => {
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(isProblemCode(spec.code), spec.title).toBe(true);
  });

  it('the server emits every code in the contracts union, and nothing else', () => {
    const emitted = new Set(EMITTED.flatMap(([, specs]) => specs.map((spec) => spec.code)));
    expect([...emitted].sort()).toEqual([...PROBLEM_CODES].sort());
  });

  // `request_refused` is the exception by design: it carries whichever 4xx the framework
  // raised (a malformed body, an oversized one, a wrong content type), so its table entry
  // is only a representative.
  it('one code never stands for two statuses, bar the framework fallback', () => {
    const statusByCode = new Map<ProblemCode, Set<number>>();
    for (const [, specs] of EMITTED) {
      for (const spec of specs) {
        if (spec.code === 'request_refused') continue;
        const statuses = statusByCode.get(spec.code) ?? new Set<number>();
        statuses.add(spec.status);
        statusByCode.set(spec.code, statuses);
      }
    }
    for (const [code, statuses] of statusByCode) expect([...statuses], code).toHaveLength(1);
  });
});
