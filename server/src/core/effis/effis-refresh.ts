/**
 * One EFFIS refresh: fetch each proxied layer, judge it (A2.2), and replace the
 * served copy only when the new body earned it (TASKS C4; ADR-001 A1.2/A2.2).
 *
 * Serve-stale is implemented as a property of the *store layout*, not of a cache
 * daemon: `overlays/effis/<layer>/current.<ext>` is the path the proxy route serves
 * (`adapters/http/effis-overlay-route.ts`), and this cycle replaces it atomically only
 * for a body the sanity check called good. Every other outcome leaves `current`
 * untouched — which *is* the stale copy the edge keeps serving. The poisoning fixtures
 * (200 + ServiceException XML, 200 + HTML, 200 + wrong-size PNG, 200 + blank PNG) are
 * therefore tests of this module and of the route over it (TASKS G4).
 *
 * The one other path the route may serve is `suspect-latest.<ext>`, and only while no
 * `current` exists: A2.2 lets a suspect body through with a TTL ≤ 60 s when there is
 * nothing stale to serve instead. A rejected body has no such path — it is never served.
 *
 * Everything fetched is also recorded once under a dated path (good under the layer
 * directory, failures under `rejected/` and `suspect/`), with a canonical-JSON
 * provenance sidecar carrying the query, the verdict, the hash and the config
 * versions — the C1 provenance discipline applied to bytes instead of rows.
 *
 * The cycle never throws. Every layer gets its verdict recorded, and the freshness
 * rows (`effis:layers` for the feed, `effis-refresh` for the job) are written even
 * when — especially when — everything else failed.
 */

import type { BoundingBox } from '../config/polling-bbox.js';
import { POLLING_BBOX } from '../config/polling-bbox.js';
import {
  EFFIS_LAYERS,
  effisLayerQuery,
  type EffisLayerId,
  type EffisLayerSpec,
  type EffisLayersValues,
} from '../config/effis-layers.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { EffisClient, EffisLayerFetch } from '../ports/effis-client.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import type { Inflate } from '../ports/inflate.js';
import type { PayloadStore } from '../ports/payload-store.js';
import {
  checkContentSanity,
  type SanityCheck,
  type SanityRule,
  type SanityVerdict,
} from './content-sanity.js';

export interface EffisRefreshDeps {
  readonly client: EffisClient;
  readonly payloads: PayloadStore;
  readonly feedStatus: FeedStatusStore;
  readonly clock: Clock;
  /** zlib inflate for the PNG structural check (G4); node:zlib in production. */
  readonly inflate: Inflate;
  readonly layersConfig?: VersionedConfig<EffisLayersValues>;
  readonly bboxConfig?: VersionedConfig<BoundingBox>;
}

export type EffisLayerOutcome =
  /** Good body: dated copy and `current` both replaced. */
  | 'stored'
  /** The request itself failed (network, non-2xx). Nothing recorded but the attempt. */
  | 'fetch_failed'
  /** Sanity verdict `reject` (A2.2 hard fail). Evidence under `rejected/`, `current` untouched. */
  | 'rejected'
  /**
   * Sanity verdict `suspect` (A2.2 soft fail). Evidence under `suspect/` and in
   * `suspect-latest`, `current` untouched.
   */
  | 'suspect'
  /** A good body the store could not keep. The one outcome that is our fault, not EFFIS's. */
  | 'write_failed';

export interface EffisLayerResult {
  readonly layer: EffisLayerId;
  readonly outcome: EffisLayerOutcome;
  /** `null` only when there was no body to judge. */
  readonly sanity: SanityVerdict | null;
  /** The classifier rule behind a non-good verdict; `null` when good or not judged. */
  readonly sanityRule: SanityRule | null;
  readonly bytes: number;
  readonly availableAt: EpochMs | null;
  /** Whether a previously-good `current` exists for the proxy to serve stale. */
  readonly staleAvailable: boolean;
  readonly error: string | null;
}

export interface EffisRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly layers: readonly EffisLayerResult[];
  /** `null` when the `effis:layers` feed row was recorded. */
  readonly feedStatusError: string | null;
  /** `null` when the `effis-refresh` job row was recorded. */
  readonly jobStatusError: string | null;
}

/**
 * The heartbeat/degraded gate. A refresh has failed when its evidence chain is broken
 * (a freshness row could not be written) or when not one layer landed — a single layer
 * outage is the feed row's business, exactly as one source outage is for ingest.
 */
export function effisRefreshFailed(report: EffisRefreshReport): boolean {
  return (
    report.feedStatusError !== null ||
    report.jobStatusError !== null ||
    !report.layers.some((layer) => layer.outcome === 'stored')
  );
}

/** `overlays/effis/<id>/current.<ext>` — the one path the proxy route serves. */
export function effisCurrentPath(spec: EffisLayerSpec): string {
  return `overlays/effis/${spec.id}/current.${spec.extension}`;
}

export function effisCurrentMetaPath(spec: EffisLayerSpec): string {
  return `overlays/effis/${spec.id}/current.meta.json`;
}

/**
 * `overlays/effis/<id>/suspect-latest.<ext>` — the newest suspect body, which the route
 * passes through with a short TTL only while no `current` exists (A2.2).
 */
export function effisSuspectLatestPath(spec: EffisLayerSpec): string {
  return `overlays/effis/${spec.id}/suspect-latest.${spec.extension}`;
}

export function effisSuspectLatestMetaPath(spec: EffisLayerSpec): string {
  return `overlays/effis/${spec.id}/suspect-latest.meta.json`;
}

/**
 * `2026-08-13T101500Z` — an instant that survives being a directory name. Colons are
 * dropped rather than replaced so the stamp stays parseable by eye and by `sort`.
 */
export function payloadStamp(at: EpochMs): string {
  return isoFromEpochMs(at)
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '');
}

export async function runEffisRefresh(deps: EffisRefreshDeps): Promise<EffisRefreshReport> {
  const layersConfig = deps.layersConfig ?? EFFIS_LAYERS;
  const bboxConfig = deps.bboxConfig ?? POLLING_BBOX;
  const startedAt = deps.clock.now();

  const layers: EffisLayerResult[] = [];
  for (const spec of layersConfig.values.layers) {
    layers.push(await refreshLayer(spec, deps, layersConfig, bboxConfig));
  }

  // Attempted-and-recorded even when every fetch failed: "we asked and got nothing" is
  // the observation that turns a freshness row critical, and it must never be lost to
  // the failure it describes.
  const attemptAt = deps.clock.now();
  const allStored = layers.every((layer) => layer.outcome === 'stored');
  const anyStored = layers.some((layer) => layer.outcome === 'stored');
  const errors = joinErrors(layers);

  // The feed row is strict — it goes stale unless *everything* the proxy serves was
  // refreshed. The job row asks the scheduler's question — did the refresh do useful
  // work at all — so a single-layer outage warns on the feed without paging twice
  // (C5: "the feed row carries the endpoint effect").
  const feedStatusError = await record(deps.feedStatus, {
    row: 'effis:layers',
    attemptAt,
    succeeded: allStored,
    hadData: anyStored,
    error: errors,
  });
  const jobStatusError = await record(deps.feedStatus, {
    row: 'effis-refresh',
    attemptAt,
    succeeded: anyStored,
    hadData: anyStored,
    error: errors,
  });

  return {
    startedAt,
    finishedAt: deps.clock.now(),
    layers,
    feedStatusError,
    jobStatusError,
  };
}

async function refreshLayer(
  spec: EffisLayerSpec,
  deps: EffisRefreshDeps,
  layersConfig: VersionedConfig<EffisLayersValues>,
  bboxConfig: VersionedConfig<BoundingBox>,
): Promise<EffisLayerResult> {
  const query = effisLayerQuery(spec, layersConfig.values, bboxConfig.values);
  const staleAvailable = await currentExists(deps.payloads, spec);

  let fetched: EffisLayerFetch;
  try {
    fetched = await deps.client.fetchLayer({ layer: spec.layerName, query });
  } catch (error: unknown) {
    // The port promises error values, but a client that throws anyway must not take the
    // other layer and the freshness rows down with it.
    fetched = {
      status: null,
      bytes: null,
      contentType: null,
      availableAt: null,
      error: describeError(error),
    };
  }

  if (fetched.bytes === null) {
    return {
      layer: spec.id,
      outcome: 'fetch_failed',
      sanity: null,
      sanityRule: null,
      bytes: 0,
      availableAt: null,
      staleAvailable,
      error: fetched.error ?? 'fetch failed without a reason',
    };
  }

  const availableAt = fetched.availableAt ?? deps.clock.now();
  const sanity = checkContentSanity(
    { status: fetched.status, contentType: fetched.contentType, body: fetched.bytes },
    {
      acceptedMediaTypes: spec.acceptedMediaTypes,
      byteFloorBytes: spec.byteFloorBytes,
      // The raster we asked for is the raster we must get back — the query carries it.
      raster:
        spec.service === 'wms'
          ? { width: layersConfig.values.wmsWidth, height: layersConfig.values.wmsHeight }
          : null,
    },
    deps.inflate,
  );
  const stamp = payloadStamp(availableAt);

  const meta = (sha256: string): string =>
    effisPayloadMeta({
      spec,
      query,
      fetched,
      sanity,
      sha256,
      availableAt,
      layersConfig,
      bboxConfig,
    });

  if (sanity.verdict !== 'good') {
    // A2.2: never cached — `current` stays whatever it was. The bytes are still kept,
    // because a rejected body is *evidence*: the reject counter and the post-mortem
    // both need to see what EFFIS actually sent, not our summary of it.
    const rejected = sanity.verdict === 'reject';
    const shelf = rejected ? 'rejected' : 'suspect';
    // A rejected body is not what it claims to be, so it does not get to wear the
    // layer's extension; a suspect one is a well-formed file of the right type.
    const extension = rejected ? 'bin' : spec.extension;
    const base = `overlays/effis/${spec.id}/${shelf}/${stamp}`;
    let error = sanity.reason;
    try {
      const written = await deps.payloads.writePayload(
        `${base}/payload.${extension}`,
        fetched.bytes,
      );
      await deps.payloads.writeText(`${base}/meta.json`, meta(written.sha256));
      if (!rejected) {
        // The A2.2 pass-through copy, dated copy first so it never points at nothing.
        await deps.payloads.writePayload(effisSuspectLatestPath(spec), fetched.bytes);
        await deps.payloads.writeText(effisSuspectLatestMetaPath(spec), meta(written.sha256));
      }
    } catch (writeError: unknown) {
      error = `${sanity.reason ?? ''}; evidence write failed: ${describeError(writeError)}`;
    }
    return {
      layer: spec.id,
      outcome: rejected ? 'rejected' : 'suspect',
      sanity: sanity.verdict,
      sanityRule: sanity.rule,
      bytes: fetched.bytes.byteLength,
      availableAt,
      staleAvailable,
      error,
    };
  }

  try {
    const base = `overlays/effis/${spec.id}/${stamp}`;
    const written = await deps.payloads.writePayload(
      `${base}/payload.${spec.extension}`,
      fetched.bytes,
    );
    await deps.payloads.writeText(`${base}/meta.json`, meta(written.sha256));
    // Only now, with the dated copy safe, does `current` move — and it moves atomically
    // (the store's promise), so a reader mid-refresh sees the old whole file or the new
    // whole file, never a mixture and never nothing.
    await deps.payloads.writePayload(effisCurrentPath(spec), fetched.bytes);
    await deps.payloads.writeText(effisCurrentMetaPath(spec), meta(written.sha256));
    return {
      layer: spec.id,
      outcome: 'stored',
      sanity: 'good',
      sanityRule: null,
      bytes: written.bytes,
      availableAt,
      staleAvailable,
      error: null,
    };
  } catch (error: unknown) {
    return {
      layer: spec.id,
      outcome: 'write_failed',
      sanity: 'good',
      sanityRule: null,
      bytes: fetched.bytes.byteLength,
      availableAt,
      staleAvailable,
      error: describeError(error),
    };
  }
}

interface MetaInput {
  readonly spec: EffisLayerSpec;
  readonly query: Readonly<Record<string, string>>;
  readonly fetched: EffisLayerFetch;
  readonly sanity: SanityCheck;
  readonly sha256: string;
  readonly availableAt: EpochMs;
  readonly layersConfig: VersionedConfig<EffisLayersValues>;
  readonly bboxConfig: VersionedConfig<BoundingBox>;
}

/**
 * The provenance sidecar: everything a reader needs to reconstruct what was asked, what
 * came back and under which parameters it was judged — without trusting the file it
 * sits next to. Canonical JSON, so two identical refreshes produce identical sidecars.
 */
function effisPayloadMeta(input: MetaInput): string {
  return `${canonicalJson({
    feed: 'effis:layers',
    layer: input.spec.id,
    service: input.spec.service,
    layer_name: input.spec.layerName,
    query: input.query,
    received_status: input.fetched.status,
    received_content_type: input.fetched.contentType,
    bytes: input.sanity.byteLength,
    sha256: input.sha256,
    sanity: input.sanity.verdict,
    sanity_rule: input.sanity.rule,
    sanity_reason: input.sanity.reason,
    raster: input.sanity.raster,
    available_at: isoFromEpochMs(input.availableAt),
    effis_layers_version: input.layersConfig.version,
    effis_layers_digest: input.layersConfig.digest,
    polling_bbox_version: input.bboxConfig.version,
  })}\n`;
}

async function currentExists(payloads: PayloadStore, spec: EffisLayerSpec): Promise<boolean> {
  try {
    return await payloads.exists(effisCurrentPath(spec));
  } catch {
    // A store that cannot even answer `exists` will fail the write loudly in a moment;
    // "no stale copy" is the honest answer to give the report meanwhile.
    return false;
  }
}

async function record(
  store: FeedStatusStore,
  attempt: Parameters<FeedStatusStore['recordAttempt']>[0],
): Promise<string | null> {
  try {
    await store.recordAttempt(attempt);
    return null;
  } catch (error: unknown) {
    return describeError(error);
  }
}

function joinErrors(layers: readonly EffisLayerResult[]): string | null {
  const errors = layers
    .filter((layer) => layer.error !== null)
    .map((layer) => `${layer.layer}: ${layer.error ?? ''}`);
  return errors.length === 0 ? null : errors.join('; ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
