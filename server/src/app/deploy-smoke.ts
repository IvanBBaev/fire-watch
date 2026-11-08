/**
 * The deploy smoke (review 27 E-5): after `infra/deploy.sh` has migrated and restarted the
 * worker and the API, is the new release serving? A failing smoke makes the script
 * redeploy the last good tag, so the question is narrow on purpose — **is this release
 * broken**, not **is the service healthy**.
 *
 * The difference matters on `/api/health/freshness`. It answers 500 when any critical
 * source is blind (OPERATIONS §2.2) — a real outage, but one upstream of us: rolling back
 * the code would not bring FIRMS back, and would block every deploy until it did, fixes
 * included. So freshness passes on **any verdict body**, 200 or 500, and fails only when
 * the API could not produce one: overload (503 `unavailable`) or a database it cannot read
 * (500 with a `reason`). The worker's `/api/health/meta` is the same: `starting` is a pass
 * (a process that has not finished its first cycle is what every deploy sees first), and
 * the paging states are not — they come from the meta-alerts and outlive a restart, but a
 * `failed`/`stale` verdict seconds after a restart is this release's own doing.
 *
 * Each round runs every probe; the smoke passes on the first round where all of them pass
 * and fails when the deadline expires first, reporting the last round's failures.
 */

export interface SmokeResponse {
  readonly status: number;
  /** Parsed JSON, or `undefined` when the body was not JSON. */
  readonly body: unknown;
}

export interface SmokeProbe {
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** `null` is a pass; a string says what was wrong. */
  readonly judge: (response: SmokeResponse) => string | null;
}

export interface SmokeTargets {
  /** The API's base URL from where the smoke runs, e.g. `http://api:8080`. */
  readonly apiUrl: string;
  /** The worker's metrics listener, or `null` when it is not configured. */
  readonly metaUrl: string | null;
  readonly metaToken: string | null;
}

function statusField(body: unknown): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['status']
    : undefined;
}

function expectOk(response: SmokeResponse): string | null {
  if (response.status === 200 && statusField(response.body) === 'ok') return null;
  return `HTTP ${String(response.status)} status=${String(statusField(response.body))}`;
}

/** A freshness verdict — `{generatedAt, status, budgetVersion, rows}` — at either code. */
export function judgeFreshness(response: SmokeResponse): string | null {
  const body = response.body;
  if (
    (response.status === 200 || response.status === 500) &&
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>)['rows']) &&
    typeof (body as Record<string, unknown>)['budgetVersion'] === 'string'
  ) {
    return null;
  }
  const reason =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['reason']
      : undefined;
  return `HTTP ${String(response.status)} status=${String(statusField(body))}${
    reason === undefined
      ? ''
      : ` reason=${typeof reason === 'string' ? reason : JSON.stringify(reason)}`
  }`;
}

const META_PASSING: ReadonlySet<unknown> = new Set(['ok', 'starting']);

export function judgeMeta(response: SmokeResponse): string | null {
  const status = statusField(response.body);
  if (response.status === 200 && META_PASSING.has(status)) return null;
  return `HTTP ${String(response.status)} status=${String(status)}`;
}

export function smokeProbes(targets: SmokeTargets): SmokeProbe[] {
  const api = targets.apiUrl.replace(/\/+$/, '');
  const probes: SmokeProbe[] = [
    { name: 'api_liveness', url: `${api}/healthz`, judge: expectOk },
    { name: 'api_readiness', url: `${api}/readyz`, judge: expectOk },
    { name: 'api_freshness', url: `${api}/api/health/freshness`, judge: judgeFreshness },
  ];
  if (targets.metaUrl !== null) {
    probes.push({
      name: 'worker_meta',
      url: `${targets.metaUrl.replace(/\/+$/, '')}/api/health/meta`,
      ...(targets.metaToken === null
        ? {}
        : { headers: { authorization: `Bearer ${targets.metaToken}` } }),
      judge: judgeMeta,
    });
  }
  return probes;
}

export interface SmokeDeps {
  readonly fetch: (probe: SmokeProbe) => Promise<SmokeResponse>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface SmokeOptions {
  readonly deadlineMs: number;
  readonly intervalMs: number;
}

export interface SmokeResult {
  readonly passed: boolean;
  readonly rounds: number;
  /** The last round's failures by probe name; empty on a pass. */
  readonly failures: Readonly<Record<string, string>>;
}

/** `ECONNREFUSED`, `ENOTFOUND`, … — never the message, which can quote the URL. */
function unreachableCode(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

export async function runSmoke(
  probes: readonly SmokeProbe[],
  deps: SmokeDeps,
  options: SmokeOptions,
): Promise<SmokeResult> {
  const deadline = deps.now() + options.deadlineMs;
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const failures: Record<string, string> = {};
    for (const probe of probes) {
      let verdict: string | null;
      try {
        verdict = probe.judge(await deps.fetch(probe));
      } catch (error) {
        // A refused connection is the normal state while a container starts.
        verdict = `unreachable: ${unreachableCode(error)}`;
      }
      if (verdict !== null) failures[probe.name] = verdict;
    }
    if (Object.keys(failures).length === 0) return { passed: true, rounds, failures };
    if (deps.now() + options.intervalMs > deadline) return { passed: false, rounds, failures };
    await deps.sleep(options.intervalMs);
  }
}
