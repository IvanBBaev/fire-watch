/**
 * The off-infra probe's only network code: three GETs and one HEAD against public URLs.
 *
 * Runs on a GitHub-hosted runner, i.e. outside our provider, network and DNS — which is
 * the point (OPERATIONS §10.1: the status page must not share infrastructure with the thing
 * it reports on). It asks what a user's browser would ask and trusts nothing it gets back:
 * every response is reduced to plain data for `core/status-model.ts`, and every failure's
 * text goes to the `diagnostics` list, which the CLI prints to stderr and never publishes.
 *
 * No cache-buster query: the probe must see what users see, including a stale CDN copy.
 * `cache: 'no-store'` only keeps the runner's own fetch cache out of the way.
 */

import type {
  BodyObservation,
  HeadObservation,
  ProbeResults,
  StatusObservation,
} from '../core/status-model.js';

export interface ProbeTargets {
  /** Origin of the API, e.g. `https://api.example.bg` — `/healthz` and the freshness path are appended. */
  readonly apiBase: string | null;
  /** The snapshot document as the public map reads it. */
  readonly snapshotUrl: string | null;
  /** The T2 mirror object (HEAD). */
  readonly mirrorUrl: string | null;
}

export const HEALTHZ_PATH = '/healthz';
export const FRESHNESS_PATH = '/api/health/freshness';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const USER_AGENT = 'fire-watch-status-probe/1 (+off-infra status page)';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProbeOutcome {
  readonly results: ProbeResults;
  /** Operator-only: raw failure text, with URLs. Never written to the published files. */
  readonly diagnostics: readonly string[];
}

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

export async function probeAll(
  targets: ProbeTargets,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const diagnostics: string[] = [];
  const request = async (url: string, method: 'GET' | 'HEAD'): Promise<Response | null> => {
    try {
      return await fetchImpl(url, {
        method,
        cache: 'no-store',
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      diagnostics.push(`${method} ${url}: ${describe(error)}`);
      return null;
    }
  };

  const status = async (url: string | null): Promise<StatusObservation> => {
    if (url === null) return { kind: 'not_configured' };
    const response = await request(url, 'GET');
    if (response === null) return { kind: 'unreachable' };
    await response.body?.cancel();
    if (!response.ok) diagnostics.push(`GET ${url}: HTTP ${String(response.status)}`);
    return { kind: 'response', status: response.status };
  };

  const body = async (url: string | null): Promise<BodyObservation> => {
    if (url === null) return { kind: 'not_configured' };
    const response = await request(url, 'GET');
    if (response === null) return { kind: 'unreachable' };
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(await response.text()) as unknown;
    } catch (error) {
      diagnostics.push(`GET ${url}: body is not JSON (${describe(error)})`);
    }
    if (!response.ok) diagnostics.push(`GET ${url}: HTTP ${String(response.status)}`);
    return { kind: 'response', status: response.status, body: parsed };
  };

  const head = async (url: string | null): Promise<HeadObservation> => {
    if (url === null) return { kind: 'not_configured' };
    const response = await request(url, 'HEAD');
    if (response === null) return { kind: 'unreachable' };
    if (!response.ok) diagnostics.push(`HEAD ${url}: HTTP ${String(response.status)}`);
    return {
      kind: 'response',
      status: response.status,
      generatedAtHeader: response.headers.get('x-amz-meta-generated-at'),
      lastModifiedHeader: response.headers.get('last-modified'),
    };
  };

  const api = targets.apiBase;
  const [healthz, freshness, snapshot, mirror] = await Promise.all([
    status(api === null ? null : join(api, HEALTHZ_PATH)),
    body(api === null ? null : join(api, FRESHNESS_PATH)),
    body(targets.snapshotUrl),
    head(targets.mirrorUrl),
  ]);
  return { results: { healthz, freshness, snapshot, mirror }, diagnostics };
}

/** The previously published `status.json`, from a URL or a local path; `null` on any failure. */
export async function readPrevious(
  source: string,
  readFile: (path: string) => Promise<string>,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ readonly value: unknown; readonly diagnostic: string | null }> {
  try {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetchImpl(source, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { value: null, diagnostic: `previous ${source}: HTTP ${String(response.status)}` };
      }
      return { value: JSON.parse(await response.text()) as unknown, diagnostic: null };
    }
    return { value: JSON.parse(await readFile(source)) as unknown, diagnostic: null };
  } catch (error) {
    return { value: null, diagnostic: `previous ${source}: ${describe(error)}` };
  }
}
