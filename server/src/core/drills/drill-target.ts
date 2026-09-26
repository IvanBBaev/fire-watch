/**
 * Is this drill about to touch production? (TASKS I7, J2.)
 *
 * Both drills write: the erasure drill seeds and erases an account, the restore drill
 * uploads an artifact and creates a database. Neither may run against production by
 * accident, so the target must **say** it is not production: the database host or name
 * (and the bucket, when one is used) must carry a non-production marker as a word
 * (`staging`, `drill`, `scratch`, `test`, …) and none may carry a production one
 * (`prod`, `production`, `live`). Anything else — including a bare `fire_watch` on
 * `localhost`, which is exactly what production's compose stack looks like — is refused.
 *
 * The CLI's `--confirm-not-production` overrides the refusal for a target that cannot be
 * named (a laptop's Postgres); the record says so, so an overridden drill is never
 * mistaken for a named-staging one.
 *
 * Pure: `URL` is the language global, nothing here reads the environment.
 */

export const PRODUCTION_MARKERS = ['prod', 'production', 'live'] as const;

export const NON_PRODUCTION_MARKERS = [
  'staging',
  'stage',
  'stg',
  'drill',
  'scratch',
  'test',
  'testing',
  'dev',
  'ci',
  'sandbox',
] as const;

export interface DrillTargetInput {
  readonly databaseUrl?: string | null;
  /** A database named without a URL (`PGDATABASE` for the psql-driven backup leg). */
  readonly databaseName?: string | null;
  /** The backup bucket, or a local store directory. */
  readonly bucket?: string | null;
}

export interface DrillTargetAssessment {
  /** Whether the target names itself non-production and nothing names it production. */
  readonly ok: boolean;
  /** Why not, one line each; empty when ok. */
  readonly problems: readonly string[];
  /** Credential-free labels for the record: `database_host`, `database_name`, `bucket`. */
  readonly described: Readonly<Record<string, string>>;
}

interface Named {
  readonly label: string;
  readonly value: string;
}

export function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

export function assessDrillTarget(input: DrillTargetInput): DrillTargetAssessment {
  const problems: string[] = [];
  const described: Record<string, string> = {};
  const named: Named[] = [];

  if (input.databaseUrl !== undefined && input.databaseUrl !== null) {
    let url: URL | null = null;
    try {
      url = new URL(input.databaseUrl);
    } catch {
      problems.push('DATABASE_URL is not a URL');
    }
    if (url !== null) {
      const host = url.hostname;
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
      described['database_host'] = host === '' ? '(socket)' : host;
      described['database_name'] = name === '' ? '(default)' : name;
      named.push({ label: 'database host', value: host }, { label: 'database name', value: name });
    }
  }
  if (
    input.databaseName !== undefined &&
    input.databaseName !== null &&
    input.databaseName !== ''
  ) {
    described['pg_database'] = input.databaseName;
    named.push({ label: 'database name', value: input.databaseName });
  }
  if (input.bucket !== undefined && input.bucket !== null && input.bucket !== '') {
    described['bucket'] = input.bucket;
    named.push({ label: 'bucket', value: input.bucket });
  }
  if (named.length === 0 && problems.length === 0) {
    problems.push('no database or bucket to assess');
  }

  let marked = false;
  for (const { label, value } of named) {
    const tokens = tokensOf(value);
    const production = tokens.filter((t) => (PRODUCTION_MARKERS as readonly string[]).includes(t));
    if (production.length > 0) {
      problems.push(
        `${label} ${JSON.stringify(value)} carries a production marker (${production.join(', ')})`,
      );
    }
    if (tokens.some((t) => (NON_PRODUCTION_MARKERS as readonly string[]).includes(t)))
      marked = true;
  }
  if (named.length > 0 && !marked) {
    problems.push(
      `neither the database host, its name nor the bucket carries a non-production marker (${NON_PRODUCTION_MARKERS.join(', ')})`,
    );
  }
  return { ok: problems.length === 0, problems, described };
}
