/**
 * Reads the `/api/health/freshness` body (OPERATIONS §2.2 rule 3) as an *outside* observer.
 *
 * The status probe is a stranger to the origin: it runs on a GitHub-hosted runner, reads
 * whatever the public hostname answered, and must not trust it to be well formed — a proxy
 * error page, a truncated body or a future schema are all things it will see eventually.
 * So this is a validating parser from `unknown`, not a cast.
 *
 * It is typed against the contract (`FreshnessReport` in `packages/contracts`) with type
 * imports only, which TypeScript erases: the emitted probe loads nothing from the
 * workspace at runtime, but a rename or a new state in the contract is a compile error
 * here rather than a status page that quietly reads `undefined`.
 */

import type {
  FreshnessReport,
  FreshnessRow,
  FreshnessState,
  FreshnessStatus,
} from '../../../packages/contracts/src/freshness.js';

export const FRESHNESS_BODY_STATES = [
  'ok',
  'warn',
  'critical',
  'muted',
  'unknown',
] as const satisfies readonly FreshnessState[];

export const FRESHNESS_BODY_STATUSES = [
  'ok',
  'warn',
  'critical',
] as const satisfies readonly FreshnessStatus[];

// The `satisfies` above says every local value is a contract value; these say the reverse,
// so a state added to the contract fails the build here until this parser learns it.
type MissingState = Exclude<FreshnessState, (typeof FRESHNESS_BODY_STATES)[number]>;
type MissingStatus = Exclude<FreshnessStatus, (typeof FRESHNESS_BODY_STATUSES)[number]>;
type Assert<T extends true> = T;
export type StatesAreExhaustive = Assert<[MissingState] extends [never] ? true : false>;
export type StatusesAreExhaustive = Assert<[MissingStatus] extends [never] ? true : false>;

/**
 * One row as the status page needs it. `row` is widened to `string` on purpose: the
 * server may start reporting a row before this probe is redeployed, and an unknown row id
 * must be shown (by its canonical id), not dropped.
 */
export type FreshnessBodyRow = Omit<
  Pick<
    FreshnessRow,
    'row' | 'state' | 'pages' | 'ageSeconds' | 'lastSuccessAt' | 'mutedUntil' | 'muteReason'
  >,
  'row'
> & { readonly row: string };

export type FreshnessBody = Pick<FreshnessReport, 'status' | 'generatedAt' | 'budgetVersion'> & {
  readonly rows: readonly FreshnessBodyRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseRow(value: unknown): FreshnessBodyRow | null {
  if (!isRecord(value)) return null;
  const { row, state, pages, ageSeconds, lastSuccessAt, mutedUntil, muteReason } = value;
  if (typeof row !== 'string' || row.length === 0) return null;
  if (!oneOf(FRESHNESS_BODY_STATES, state)) return null;
  if (typeof pages !== 'boolean') return null;
  if (!(ageSeconds === null || (typeof ageSeconds === 'number' && Number.isFinite(ageSeconds)))) {
    return null;
  }
  if (!nullableString(lastSuccessAt) || !nullableString(mutedUntil)) return null;
  if (!nullableString(muteReason)) return null;
  return { row, state, pages, ageSeconds, lastSuccessAt, mutedUntil, muteReason };
}

/** The body, or `null` when it is not a freshness report at all. One bad row rejects it. */
export function parseFreshnessBody(value: unknown): FreshnessBody | null {
  if (!isRecord(value)) return null;
  const { status, generatedAt, budgetVersion, rows } = value;
  if (!oneOf(FRESHNESS_BODY_STATUSES, status)) return null;
  if (typeof generatedAt !== 'string' || typeof budgetVersion !== 'string') return null;
  if (!Array.isArray(rows)) return null;
  const parsed: FreshnessBodyRow[] = [];
  for (const row of rows) {
    const one = parseRow(row);
    if (one === null) return null;
    parsed.push(one);
  }
  return { status, generatedAt, budgetVersion, rows: parsed };
}
