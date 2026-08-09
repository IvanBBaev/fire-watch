# Backend Design Review — Fire Watch server

*Role: senior backend engineer (TypeScript / Node.js / Fastify). Scope: the proposed server
design in `docs/ANALYSIS.md` §5 and its interaction with ADR-001.*
*Date: 2026-07-21. Status: review complete, pre-code.*

---

## 1. Summary verdict

**Buildable and fundamentally sound — approved to proceed, with conditions.** The architecture
direction is right: ports & adapters, PostGIS from day one, `FireEvent` as the core entity,
poll-don't-stream at MVP, freshness as first-class data. These are the decisions I would have
made myself and I will not re-litigate them.

The conditions: the analysis stops exactly where the backend work gets hard. The three problems
that will consume most of the server engineering effort are (a) **stable fire-event identity
under incremental clustering** (merge/split without breaking IDs that alerts, URLs and SSE
clients hold), (b) **detection dedup/upsert semantics across overlapping FIRMS polls and
NRT→standard reprocessing**, and (c) **the SSE contract** (event types, replay, proxy
behavior). None of these are designed in the analysis; all three are designed concretely in
this document (§5). Additionally, the phrase "one small VM **or serverless**" in §5 of the
analysis must lose the "or serverless" — long-lived pollers plus SSE mandate a persistent
process (§3, R-4).

Estimated server-side MVP effort with the designs below: realistic within the stated 4–6 weeks
of evenings *if* the FCI adapter stays out of scope (it correctly is) and the alert engine
stays at "outbox table designed, delivery not built" (recommended).

---

## 2. Strengths

Things the analysis gets right that I explicitly endorse, so nobody "improves" them later:

1. **PostGIS from day one.** Correct divergence from the kiko SQLite precedent. Geofence
   matching (`ST_DWithin`), DBSCAN reconciliation (`ST_ClusterDBSCAN`), nearest-settlement
   lookups, and future polygon monitoring are all one engine. Doing any of this in JS against
   SQLite would be rework guaranteed.
2. **Raw detections append-only, events derived.** This is the single most important data
   decision in the document. Clustering parameters *will* be tuned; being able to re-derive
   events from history is what makes tuning safe. Keep it sacred: no destructive updates to
   `detections` ever (upserts that refine a row's own fields are fine; deletes are not).
3. **Poll, don't stream, at MVP.** The FIRMS rate-limit math supports it overwhelmingly
   (§5.4.2: we need ~0.6% of the allowed budget). EUMETCast push deferred with FCI is right.
4. **Honest freshness UX as a product requirement.** From the backend side this costs one
   `source_status` table and a foreign member on GeoJSON responses — cheap, and it forces the
   ingestion layer to record what it knows about its own staleness. Design ally, not overhead.
5. **Explicit non-goals** (no prediction modeling, no dispatch tooling). Keeps the domain core
   small: normalize → dedup → cluster → enrich → notify. That is a shape one person can hold
   in their head.
6. **FireEvent as the API surface, not hotspots.** Matches how alerting, history, and the B2B
   API will work. Raw detections stay available as a sub-resource for the detail panel and
   power users (§5.5).
7. **ADR-001 keeps the server out of the tile business.** MapLibre + OpenFreeMap/PMTiles means
   the backend serves *only* dynamic GeoJSON + SSE + a couple of proxied layers. No tile
   server to operate at MVP. Good separation.

---

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk / gap | Consequence if ignored |
|---|---|---|---|
| R-1 | **High** | **Event identity under merge/split is unspecified.** "Events merge/split" is one clause in the analysis; it is the hardest domain problem in the system. | Event IDs churn on every re-cluster → broken alert dedup ("new fire!" for the same fire), broken permalinks, SSE clients showing duplicate/zombie events. Trust product with untrustworthy IDs. |
| R-2 | **High** | **Detection dedup key undefined.** FIRMS polls overlap by design (`day_range` windows); the same pixel returns repeatedly; NRT rows are later superseded by standard-processing rows with slightly different values and a different `version`. | Duplicate detections inflate event confidence/FRP, re-trigger alerts, and corrupt the append-only history the reprocessing story depends on. |
| R-3 | **Medium-High** | **Clustering execution model unchosen** (batch DBSCAN vs incremental assignment). DBSCAN is a batch algorithm; naively re-running it every poll conflicts directly with R-1. | Either O(history) clustering every 5 minutes, or unstable partitions. Must be decided before the first line of domain code. |
| R-4 | **Medium-High** | **"Or serverless" in the cost note.** SSE connections and 5-minute pollers require a persistent process; serverless functions give neither (and managed SSE workarounds cost more than a VM). | Architecture dead-end discovered during deployment week. |
| R-5 | **Medium** | **SSE contract completely undefined** — no event types, no replay semantics, no heartbeat, no proxy-buffering plan. | Reverse proxy buffers the stream (nginx default) → "live" map silently 60 s stale; reconnects lose updates; mobile clients drain batteries on dead connections. |
| R-6 | **Medium** | **EFFIS WMS is pixels, not data.** The detail panel promises "fire danger" per event, but WMS `GetMap` returns imagery. Extracting a danger *class* for a point needs `GetFeatureInfo` (or ingesting the underlying FWI data). Also: EFFIS servers are slow/flaky exactly during fire season. | Detail-panel feature quietly impossible as designed; map overlay dies when EFFIS does, during the moments users care most. |
| R-7 | **Medium** | **No schema/migration story.** PostGIS DDL (extensions, GIST indexes, geography columns, generated columns) is SQL-first; ORM-generated migrations handle it poorly. | Migration tooling fights the database for the life of the project. Cheap to decide now (§5.9). |
| R-8 | **Medium** | **Alert outbox named but not designed.** MVP has no alerts (fine), but the outbox *table* and the "one alert per (zone, event), not per detection" rule shape the event-identity design (R-1). | v1 alerting bolted onto an event model that can't support dedup → the exact spam failure a trust product cannot afford. |
| R-9 | **Low-Med** | **FCI/netCDF adapter path undecided** — Node (h5wasm) vs Python sidecar. Correctly deferred, but the *port boundary* must be drawn now or the deferral leaks into the core. | FCI integration becomes a rewrite instead of an adapter drop-in. |
| R-10 | **Low-Med** | **Open-Meteo terms.** Free tier is non-commercial (~10k req/day). Fine for MVP; a licensing to-do the moment Phase-2 monetization starts. Also: don't bulk-poll weather — fetch per active event, cached. | Terms violation at monetization; pointless API load before that. |
| R-11 | **Low** | **MAP_KEY leaks into logs.** The FIRMS key is a **URL path segment**; default request/error logging of URLs logs the secret. | Key rotation fire-drill; possibly throttled shared key. One pino redact rule, if planned. |
| R-12 | **Low** | **Confidence normalization across sensors unspecified.** VIIRS reports `l/n/h`; MODIS reports 0–100. | Ad-hoc mapping scattered through code; inconsistent UX tiers. Trivial to fix with one mapping table (§5.3). |
| R-13 | **Low** | **Readiness vs freshness conflation risk.** If `/readyz` includes source freshness, a FIRMS outage takes the whole API out of rotation — the opposite of the honest-staleness product promise. | Self-inflicted downtime during upstream outages. Keep them separate (§5.10). |

---

## 4. Detailed recommendations

Each maps to the risks above; the concrete designs are in §5.

1. **(R-1, R-3) Adopt incremental event assignment + nightly batch reconciliation.** Never
   re-run DBSCAN as the source of truth on the hot path. Detections attach to existing active
   events by proximity rules; DBSCAN runs nightly as an *auditor* proposing merges only.
   Event IDs are permanent; merged events get `status='merged'` + `merged_into`, never
   deletion. Splits are not automated at MVP. Full algorithm: §5.4.
2. **(R-2) Define the detection natural key now** and enforce it with a unique index:
   `(source, satellite, observed_at, lat/lon rounded to 4 decimals)` materialized as a
   `dedup_key` column; ingest is `INSERT … ON CONFLICT (dedup_key) DO UPDATE` limited to
   value-refinement fields (`version`, `confidence`, `frp`). Details and rationale: §5.3.
3. **(R-4) One persistent Node process at MVP, two composition roots from day one.**
   `main.ts` starts HTTP + scheduler together; `server.ts` and `worker.ts` exist as separate
   entrypoints selected by env so the split to two processes is a deploy change, not a
   refactor. In-process event bus behind a port; its Postgres `LISTEN/NOTIFY` implementation
   is the multi-process upgrade path. §5.2, §5.4.
4. **(R-5) Implement the SSE contract in §5.6 verbatim**: named event types, monotonic
   sequence IDs, ring-buffer replay with an explicit `reset` fallback, 25 s heartbeats,
   `X-Accel-Buffering: no` + `Cache-Control: no-cache, no-transform`, compression excluded on
   the stream route. Use the official `@fastify/sse` plugin (exists as of 2026, with built-in
   Last-Event-ID replay and heartbeats) — but pin it, it is young; the hand-rolled fallback is
   ~60 lines and documented in §5.6.
5. **(R-6) Proxy and cache EFFIS at our edge.** Server-side WMS proxy with a short TTL +
   stale-while-revalidate for the map overlay; `GetFeatureInfo` with a per-cell daily cache
   for the danger class in the detail panel. The frontend never talks to EFFIS directly (also
   solves CORS and attribution consistency). §5.5, route `/api/v1/layers/*`.
6. **(R-7) SQL-first migrations (dbmate) + `kysely-codegen` for types.** The database schema
   is written in plain SQL where PostGIS is a first-class citizen; TypeScript types are
   *generated from* the database, not the other way around. §5.8, §5.9.
7. **(R-8) Create the `alert_outbox` table in the initial schema even though nothing writes
   to it at MVP**, with the uniqueness rule `(zone_id, event_id, tier)` baked in. It costs one
   migration and freezes the contract that event identity must support. §5.8.
8. **(R-9) Freeze the ingestion port as language-agnostic NDJSON of normalized `Detection`
   records.** Any adapter — including a future Python FCI sidecar using `eumdac`/`xarray` —
   delivers detections either in-process (TS adapters) or via an internal ingest endpoint
   (external processes). The Node-only path (h5wasm reads netCDF-4/HDF5 fine) stays open but
   is not load-bearing. §5.7.
9. **(R-10) Weather is fetched on demand per active event with a 1 h cache**, never bulk.
   Wrap Open-Meteo behind `/api/v1/weather` so the client never sees the upstream. Put
   "Open-Meteo commercial license" in the Phase-2 checklist.
10. **(R-11, R-12) Day-one hygiene:** pino redact paths covering outbound request URLs;
    single `normalizeConfidence(instrument, raw)` function with the mapping table in §5.3;
    all timestamps `timestamptz` UTC end-to-end (FIRMS `acq_date`+`acq_time` are UTC).
11. **(R-13) `/readyz` = process + DB only. Freshness is data**, exposed at
    `/api/v1/meta/freshness` and as a foreign member on GeoJSON responses, and *alerted on*
    via monitoring — never via readiness.
12. **Do the validation-plan step 1 (FIRMS latency ground-truth) with the real ingest code**,
    not a throwaway script: point the FIRMS adapter + poller at a dev database for a week.
    Same effort, and it doubles as the fixture-recording session for §5.11.

---

## 5. Backend deep dive

### 5.1 Repository & package layout

**Decision: minimal pnpm workspace — three packages. Not a single package, not a deep
monorepo.**

The genuinely shared artifact is the API contract (TypeBox schemas for GeoJSON responses and
SSE payloads) — the React client should import the same types the server validates with.
That alone justifies a workspace. Anything deeper (separate `domain`/`adapters` packages) is
ceremony at this scale: ports & adapters is a *folder and import discipline*, not a package
topology. One person, one service — package boundaries would only add build plumbing.

```
fire-watch/
├── package.json                 # workspace root: scripts, pnpm workspace config
├── pnpm-workspace.yaml
├── docs/
├── packages/
│   └── contracts/               # @fire-watch/contracts — zero runtime deps
│       └── src/
│           ├── geojson.ts       # TypeBox: Feature/FeatureCollection generics
│           ├── events.ts        # FireEventProperties, statuses, confidence tiers
│           ├── detections.ts    # DetectionProperties, source enum
│           ├── sse.ts           # SSE event names + payload schemas
│           └── freshness.ts     # SourceFreshness shape
├── server/                      # @fire-watch/server
│   ├── migrations/              # plain SQL, dbmate format (001_init.sql, …)
│   ├── src/
│   │   ├── domain/              # PURE: no IO, no imports from adapters/http/jobs
│   │   │   ├── detection.ts     # Detection type, confidence normalization, invariants
│   │   │   ├── fire-event.ts    # FireEvent type, lifecycle state machine
│   │   │   ├── clustering.ts    # attach/merge decision logic (pure functions)
│   │   │   └── freshness.ts     # staleness computation
│   │   ├── ports/               # interfaces only
│   │   │   ├── detection-source.ts   # DetectionSource (pull adapters implement)
│   │   │   ├── detection-repo.ts
│   │   │   ├── event-repo.ts
│   │   │   ├── event-bus.ts          # publish/subscribe of DomainEvent
│   │   │   ├── weather.ts
│   │   │   └── clock.ts
│   │   ├── app/                 # use-cases: orchestrate ports, no Fastify types
│   │   │   ├── ingest-detections.ts  # THE core use-case (fetch→dedup→cluster→emit)
│   │   │   ├── advance-lifecycles.ts
│   │   │   ├── reconcile-clusters.ts # nightly DBSCAN audit
│   │   │   └── queries/              # read-side: events-geojson.ts, freshness.ts
│   │   ├── adapters/
│   │   │   ├── firms/           # client.ts (HTTP), csv.ts (parse), map.ts (→Detection)
│   │   │   ├── effis/           # wms-proxy.ts, feature-info.ts
│   │   │   ├── open-meteo/
│   │   │   ├── db/              # Kysely: repos, db.ts, types.generated.ts
│   │   │   └── bus/             # in-memory.ts now; pg-notify.ts later
│   │   ├── http/
│   │   │   ├── plugins/         # config, db, bus, sse, error-handler, logging
│   │   │   ├── routes/          # events.ts, detections.ts, layers.ts, weather.ts,
│   │   │   │                    # stream.ts, meta.ts, health.ts
│   │   │   └── build-app.ts     # fastify factory (used by tests via .inject())
│   │   ├── jobs/
│   │   │   ├── scheduler.ts     # croner registration + job wrapper (see §5.4)
│   │   │   └── defs.ts          # job table: name, cadence, handler
│   │   ├── config.ts            # env → validated typed Config (single process.env site)
│   │   ├── server.ts            # composition root: HTTP only
│   │   ├── worker.ts            # composition root: jobs only
│   │   └── main.ts              # MVP: both in one process
│   └── test/
│       ├── unit/                # mirrors domain/ + app/
│       ├── integration/         # testcontainers PostGIS
│       └── fixtures/firms/      # recorded CSVs (see §5.11)
└── web/                         # @fire-watch/web — React/Vite/MapLibre (out of scope here)
```

**Import rules (enforced with `eslint-plugin-boundaries` or dependency-cruiser from commit 1):**
`domain` imports nothing internal; `ports` import `domain`; `app` imports `domain`+`ports`;
`adapters`/`http`/`jobs` import inward only; nothing imports `http` except entrypoints.

### 5.2 Process model

**MVP: one process** (`main.ts`): Fastify HTTP + croner scheduler + in-memory event bus.
Justification: ingestion writes and SSE fan-out share memory, so a poll result reaches
connected clients with zero infra. The load is trivial (a few HTTP calls per 5 min, tens of
SSE clients initially).

**The pre-paid escape hatch:** `server.ts` and `worker.ts` are real entrypoints from day one
(`ROLE=web|worker|all`, default `all`). The only thing that breaks on split is the in-memory
bus — which is why the bus is a port with a planned `pg NOTIFY/LISTEN` implementation
(payloads are tiny: event IDs + seq, receivers re-read from DB). No Redis in this future
either; Postgres is the only stateful dependency until proven otherwise.

**What this rules out:** serverless/function hosting (R-4). Target: one small VM or a
container platform with persistent processes (Hetzner CX/Fly.io machine). This also matches
the SSE requirements in §5.6.

### 5.3 Data model & detection dedup (R-2, R-12)

Normalized domain type (what every adapter must produce):

```ts
// domain/detection.ts
export type DetectionSource =
  | 'firms:viirs:snpp' | 'firms:viirs:noaa20' | 'firms:viirs:noaa21'
  | 'firms:modis' | 'fci:fir' | 'manual';

export interface Detection {
  source: DetectionSource;
  satellite: string;          // 'N20', 'Terra', …
  observedAt: Date;           // acq_date + acq_time, UTC — never local
  lat: number;                // WGS84
  lon: number;
  frpMw: number | null;       // fire radiative power
  brightnessK: number | null;
  confidence: 'low' | 'nominal' | 'high';
  dayNight: 'D' | 'N' | null;
  version: string | null;     // FIRMS processing version, e.g. '2.0NRT'
  raw: Record<string, unknown>; // full source row, jsonb — reprocessing insurance
}
```

**Confidence normalization** (single function, unit-tested):

| Instrument | Raw | Normalized |
|---|---|---|
| VIIRS | `l` / `n` / `h` | low / nominal / high |
| MODIS | 0–29 | low |
| MODIS | 30–79 | nominal |
| MODIS | 80–100 | high |

**Dedup key.** FIRMS has no row ID. The stable identity of an observation is *where and when
the sensor saw it*: `dedup_key = source | satellite | observed_at(ISO) | lat4 | lon4` with
lat/lon rounded to 4 decimals (~11 m — far below the 375 m pixel, far above float noise).
Enforced by a unique index. Ingestion is:

```sql
INSERT INTO detections (…) VALUES (…)
ON CONFLICT (dedup_key) DO UPDATE
  SET version = EXCLUDED.version,
      confidence = EXCLUDED.confidence,
      frp_mw = EXCLUDED.frp_mw,
      brightness_k = EXCLUDED.brightness_k,
      raw = EXCLUDED.raw
  WHERE detections.version IS DISTINCT FROM EXCLUDED.version;
```

This makes every poll idempotent by construction: overlapping `day_range` windows are *free*,
and the NRT→standard-processing refinement updates values in place without creating a second
observation. The ingest use-case must count `inserted` vs `refreshed` rows (via `xmax = 0` or
`RETURNING` trickery) — only *inserted* detections proceed to clustering and SSE.

### 5.4 Clustering & event identity (R-1, R-3) — the core design

**Principle: event IDs are permanent.** An alert was sent for event `X`; a user has
`/event/X` open; the SSE stream referenced `X`. Nothing may renumber `X`, ever.

**Hot path — incremental assignment** (runs inside `ingest-detections` for *newly inserted*
detections only):

1. Candidate events: `status IN ('new','active','cooling')` AND
   `ST_DWithin(event.centroid::geography, detection, 3000)` AND
   `last_observed_at > now() - interval '48 hours'`. (3 km attach radius = 2 km cluster ε +
   slack for centroid drift; tune later — parameters live in config, and the append-only
   detections table means retuning is replayable.)
2. Exactly one candidate → attach: set `detections.event_id`, recompute event aggregates
   (`last_observed_at`, `detection_count`, `max_frp_mw`, `centroid` as running mean or
   `ST_Centroid` over members, `sources`, confidence tier), bump `seq`, emit
   `event.updated`.
3. Zero candidates → create event (`status='new'`), emit `event.created`.
4. **Two or more candidates → the detection is a bridge: merge.** Survivor = earliest
   `first_detected_at` (stable under repetition). Losers: `status='merged'`,
   `merged_into=survivor`, their detections re-pointed to the survivor. Emit
   `event.merged {id, merged_into}` so clients can drop the losers. API requests for a merged
   ID return `301`-style: the merged record with a pointer (never 404).
5. Confidence score of the event = f(source mix, persistence): one satellite, one pass = low;
   ≥2 passes or ≥2 instruments = nominal; ≥3 passes over ≥12 h or high-confidence VIIRS
   majority = high. Pure function in `domain/`, table-driven tests.

**Lifecycle job** (every 10 min, pure time-based transitions, emits `event.status_changed`):

```
new      → active   : detections in ≥2 distinct passes, or age > 6 h with recent detection
active   → cooling  : no new detection for 24 h
cooling  → active   : new detection attaches (reflare)
cooling  → out      : no new detection for 48 h   (terminal, kept forever)
```

Never emit an "all clear" semantic — `out` is "no longer observed", and the API/UX copy must
say so (matches the legal section of the analysis).

**Cold path — nightly reconciliation** (`reconcile-clusters`): run
`ST_ClusterDBSCAN(geom, eps := 2000, minpoints := 1)` over the last 72 h of detections
*as an audit*. Where DBSCAN says one cluster but we hold two live events → apply the same
merge procedure. Where DBSCAN splits what we merged → **log only, do not auto-split** at MVP
(splitting requires re-assigning history and re-issuing identity; rare enough — two separate
fires igniting within ε — that manual review is acceptable initially). This keeps DBSCAN's
batch nature where it belongs: off the hot path, advisory, idempotent.

### 5.5 Job architecture (pollers)

**Decision: croner (in-process cron/interval scheduler), not BullMQ, not bare setInterval.**

- **BullMQ: rejected at MVP.** It buys distributed workers, per-job retries, and persistence —
  at the price of a Redis dependency, the only piece of infra the design otherwise avoids.
  Our jobs are (a) few, (b) periodic rather than queued, (c) idempotent by §5.3 — so "retry"
  is simply "the next tick". Revisit only when notification fan-out (v1, thousands of pushes
  with per-provider throttling) genuinely needs a queue — and even then, evaluate a
  Postgres-backed queue (pg-boss/graphile-worker) before adding Redis.
- **Bare `setInterval`: rejected** — no overlap protection, drifts, and we'd hand-roll what
  croner already does (cron + interval semantics, overrun protection, TS types, zero deps).
- **node-cron: acceptable but weaker** — cron-expressions only (awkward for "every 5 min with
  jitter"), less active maintenance than croner.

**Job table (MVP):**

| Job | Cadence | Work |
|---|---|---|
| `poll-firms` | every 5 min, ±30 s jitter | 4 requests (VIIRS SNPP/NOAA-20/NOAA-21, MODIS), bbox `west,south,east,north` from config, `day_range=1`; parse → normalize → ingest use-case |
| `backfill-firms` | daily 03:30 UTC | same sources, `day_range=3` — catches late-arriving and reprocessed rows; pure upsert, no SSE (only *inserted* rows cluster/emit, per §5.3) |
| `advance-lifecycles` | every 10 min | §5.4 lifecycle transitions |
| `reconcile-clusters` | daily 04:00 UTC | §5.4 DBSCAN audit |
| `refresh-effis` | daily 06:00 UTC (after EFFIS update) | warm the danger-layer cache; record freshness |
| `prune-caches` | hourly | expire weather/GetFeatureInfo caches |

**Rate-limit reality check (FIRMS):** 4 requests / 5 min = 48 req/h ≈ 480 per 10-min-limit
window of 5,000 → **<1% of budget**, including the daily backfill. Still: wrap the FIRMS
client in a token bucket (defense against a retry loop bug — the classic way keys get
banned), treat HTTP 429 or FIRMS's over-limit text response as a signal to skip ticks for
10 min, and alert on it.

**Job wrapper** (one decorator around every handler, in `jobs/scheduler.ts`):

```ts
interface JobRun {
  name: string;
  run(): Promise<void>;
}
// wrapper provides: per-job overlap lock (skip tick if still running);
// exponential backoff on consecutive failures (1×,2×,4× cadence, cap 30 min) —
// implemented by skipping ticks, not by rescheduling;
// timing + outcome → pino; source_status upsert (attempt/success/error/consecutive_failures);
// AbortSignal wired to graceful shutdown (§5.10).
```

Every poll updates `source_status` regardless of outcome — this single table feeds
`/api/v1/meta/freshness`, the GeoJSON freshness member, and monitoring. Distinguish
`last_success_at` (the poll worked) from `last_data_at` (max `observed_at` seen) — "FIRMS is
up but there's been no overpass since 11:42" and "FIRMS is down" are different truths and the
honest-UX requirement needs both.

### 5.6 API surface

All responses `application/json` (GeoJSON where noted); errors follow RFC 7807
(`application/problem+json`) via a single Fastify error handler. Prefix `/api/v1` — cheap
now, priceless when the B2B API (v2 plans) needs to evolve.

| Method & path | Params | Response |
|---|---|---|
| `GET /api/v1/events` | `bbox=w,s,e,n` (optional, default: configured region); `status` (csv of `new,active,cooling,out`; default excludes `out`); `since` (ISO; `first_detected_at` filter); `updated_after_seq` (see below); `limit` (default 500, max 2000) | GeoJSON `FeatureCollection` of events. Geometry: `Point` centroid at MVP (hull polygon later as `properties.hull` or a `?geom=hull` variant). Foreign member `freshness` (below). `ETag` derived from max event `seq`. |
| `GET /api/v1/events/:id` | — | Single GeoJSON `Feature`. For `status='merged'`: same shape + `merged_into`, HTTP 200 (clients follow; never 404 a formerly-valid ID). |
| `GET /api/v1/events/:id/detections` | `limit` | GeoJSON `FeatureCollection` of member detection points (detail panel: pass history, FRP trend). |
| `GET /api/v1/detections` | `bbox`, `source`, `since` (max window 7 d), `limit` | Raw normalized detections as GeoJSON. Debug/power-user endpoint; rate-limited harder. |
| `GET /api/v1/weather` | `lat`, `lon` | `{ wind: {speedMs, gustMs, directionDeg}, temperatureC, relativeHumidityPct, hourly: […12h] }` — Open-Meteo proxied, 1 h cache keyed by 0.05° grid cell. |
| `GET /api/v1/layers/fire-danger/tile` | WMS passthrough params (whitelisted) | EFFIS WMS proxy, cached (TTL 6 h + stale-while-revalidate 24 h). Frontend uses this as its raster source URL. |
| `GET /api/v1/layers/fire-danger/at` | `lat`, `lon` | `{ dangerClass: 1–6, validFor: 'YYYY-MM-DD', source: 'EFFIS' }` via cached `GetFeatureInfo`. |
| `GET /api/v1/meta/freshness` | — | Per-source status (shape below). |
| `GET /api/v1/stream` | `topics` (optional csv) | SSE — §5.7. |
| `GET /healthz` | — | `200 {"status":"ok"}` — liveness only, no dependency checks. |
| `GET /readyz` | — | 200/503 — DB `SELECT 1` only (see R-13). |

**Event Feature properties** (the contract; lives in `@fire-watch/contracts`):

```ts
interface FireEventProperties {
  id: string;                       // uuid — permanent (§5.4)
  status: 'new' | 'active' | 'cooling' | 'out' | 'merged';
  mergedInto: string | null;
  firstDetectedAt: string;          // ISO 8601 UTC
  lastObservedAt: string;           // honesty anchor: "last satellite pass HH:MM"
  detectionCount: number;
  maxFrpMw: number | null;
  sources: DetectionSource[];
  confidence: 'low' | 'nominal' | 'high';
  nearestSettlement: { name: string; distanceKm: number } | null;
  seq: number;                      // monotonic update cursor (see below)
}
```

**Freshness metadata** — attached as a *foreign member* (RFC 7946 allows unknown top-level
members; strict parsers that drop it lose nothing critical, and `/api/v1/meta/freshness`
carries the same data):

```jsonc
{
  "type": "FeatureCollection",
  "features": [ … ],
  "freshness": {
    "generatedAt": "2026-07-21T14:05:12Z",
    "sources": [
      { "source": "firms:viirs:noaa20",
        "lastSuccessAt": "2026-07-21T14:02:41Z",
        "lastDataAt":    "2026-07-21T11:42:00Z",
        "consecutiveFailures": 0 }
    ]
  }
}
```

**Change polling without SSE:** `fire_events.seq` is a global monotonic bigint bumped on
every event write. `GET /events?updated_after_seq=N` returns only events with `seq > N` —
the client's SSE-reconnect snapshot *and* the fallback for clients where SSE fails. One
mechanism, two consumers.

### 5.7 SSE design (R-5)

**Endpoint:** `GET /api/v1/stream`. **Plugin:** official `@fastify/sse` (route-level
`{ sse: true }`, built-in heartbeats and Last-Event-ID replay) — it is new in the ecosystem,
so pin the version and keep the fallback in mind: hand-rolling over `reply.raw` is ~60 lines
(write status + headers, `write()` frames, `request.raw.on('close')` cleanup) and was the
plan before the official plugin existed. Do not adopt `fastify-sse-v2` for a new build now
that the official plugin exists.

**Event types** (payload schemas in `contracts/sse.ts`):

| `event:` | `data:` | When |
|---|---|---|
| `event.created` | full `FireEventProperties` + centroid | New event from clustering |
| `event.updated` | same | Aggregates changed (new detections attached) |
| `event.status_changed` | `{id, status, previous}` | Lifecycle job |
| `event.merged` | `{id, mergedInto}` | §5.4 merge |
| `freshness` | freshness object (§5.6) | After every poll tick |
| `reset` | `{reason}` | Server can't replay from client's Last-Event-ID → client must refetch `/events` snapshot, then resume |

**IDs & reconnection:** every frame carries `id:` = the global `seq`. Server keeps an
in-memory ring buffer of the last ~1,000 frames. On reconnect with `Last-Event-ID`:
in-buffer → replay the gap; too old / unknown (e.g. after process restart) → send `reset`.
The client contract is therefore trivially simple: *on `reset` or first connect, snapshot via
`GET /events`, then apply the stream.* This eliminates the entire class of "SSE as source of
truth" bugs. Send `retry: 5000` on connect.

**Transport hygiene — every item is a known production incident elsewhere:**

- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no` (nginx **buffers responses by default**, which silently turns "live"
  into "on flush" — if nginx fronts us, also `proxy_buffering off` for this location; verify
  equivalent behavior on whatever CDN/proxy we deploy behind, Cloudflare included).
- **Compression excluded** for this route (`@fastify/compress` route opt-out) — gzip buffers
  frames.
- **Heartbeat comment frame (`: hb`) every 25 s** — below common 30–60 s idle timeouts of
  LBs/proxies; also how the *server* discovers dead connections (write fails → cleanup).
- **HTTP/1.1 browsers cap at 6 connections per origin** — SSE eats one per tab. Terminate
  TLS with HTTP/2 at the proxy/CDN so this ceiling disappears; document it as a deploy
  requirement, not a hope.
- Connection cap + per-IP limit on the route (`@fastify/rate-limit` custom bucket) as
  cheap DoS insurance.
- On shutdown: broadcast `reset {reason:'restart'}`, end connections, let clients' native
  `EventSource` retry logic do the rest (§5.10).

### 5.8 Database schema (initial migration, abridged)

> **Non-normative.** The schema owner is `server/db/migrations/001_initial_schema.sql`.
> This block predates ADR-002 and ADR-004 and is superseded wherever the two differ.
> Known differences: `detections` here has a surrogate `id` and a `UNIQUE (detection_uid)`
> that a partitioned table cannot have — the real key is `(acq_ts, detection_uid)`, which
> is equivalent because `acq_ts` is itself a hash input; the dedup upsert is `DO NOTHING`,
> not the refinement `DO UPDATE` this section describes (A1.1); and the outbox anti-spam
> key is `(zone_id, event_id, alert_type, alert_subkey)`, generalized from the `tier`
> column here by ADR-004 A1.11 so the escalation ladder fits it.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE detections (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL,
  satellite    text NOT NULL,
  observed_at  timestamptz NOT NULL,
  geom         geography(Point, 4326) NOT NULL,
  frp_mw       real,
  brightness_k real,
  confidence   text NOT NULL CHECK (confidence IN ('low','nominal','high')),
  day_night    char(1),
  version      text,
  raw          jsonb NOT NULL,
  dedup_key    text NOT NULL,
  event_id     uuid,                -- FK added after fire_events
  ingested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX detections_dedup ON detections (dedup_key);
CREATE INDEX detections_geom ON detections USING gist (geom);
CREATE INDEX detections_observed ON detections (observed_at DESC);
CREATE INDEX detections_event ON detections (event_id);

CREATE TABLE fire_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status             text NOT NULL CHECK (status IN ('new','active','cooling','out','merged')),
  merged_into        uuid REFERENCES fire_events(id),
  first_detected_at  timestamptz NOT NULL,
  last_observed_at   timestamptz NOT NULL,
  centroid           geography(Point, 4326) NOT NULL,
  detection_count    integer NOT NULL DEFAULT 0,
  max_frp_mw         real,
  sources            text[] NOT NULL DEFAULT '{}',
  confidence         text NOT NULL DEFAULT 'low',
  nearest_settlement jsonb,
  seq                bigint NOT NULL,          -- from global sequence, bumped on write
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE event_seq;                      -- the global update cursor (§5.6)
CREATE INDEX fire_events_centroid ON fire_events USING gist (centroid);
CREATE INDEX fire_events_status ON fire_events (status) WHERE status <> 'out';
CREATE INDEX fire_events_seq ON fire_events (seq);

ALTER TABLE detections
  ADD CONSTRAINT detections_event_fk FOREIGN KEY (event_id) REFERENCES fire_events(id);

CREATE TABLE source_status (
  source               text PRIMARY KEY,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_data_at         timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error           text
);

-- v1 contract frozen now (R-8); nothing writes to these at MVP:
CREATE TABLE watch_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  geom geography NOT NULL,          -- point+radius or polygon
  radius_m integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_zones_geom ON watch_zones USING gist (geom);

CREATE TABLE alert_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zone_id uuid NOT NULL REFERENCES watch_zones(id),
  event_id uuid NOT NULL REFERENCES fire_events(id),
  tier text NOT NULL,               -- 'first_detection' | 'escalation' | …
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (zone_id, event_id, tier)  -- THE anti-spam invariant
);
```

Retention: keep everything; `detections` for the whole Balkans is thousands of rows/day at
worst — partitioning is a year-3 problem. Nearest-settlement enrichment: load a one-off
settlements table (GeoNames/OSM extract, name + `name:bg` + geography point, GIST index) and
resolve with a `ORDER BY geom <-> $1 LIMIT 1` KNN query at event creation.

### 5.9 Library choices (with justification)

| Concern | Choice | Why / rejected alternatives |
|---|---|---|
| HTTP framework | **Fastify v5** | Given. Plugin encapsulation maps cleanly onto adapters; schema-based serialization fits contract-first GeoJSON. |
| Validation & types | **TypeBox** + `@fastify/type-provider-typebox` | Schemas *are* JSON Schema → one artifact drives request validation, response serialization (`fast-json-stringify`), OpenAPI (`@fastify/swagger`), and shared types in `contracts/`. Zod needs a conversion layer (`zod-to-json-schema`) to get the same and its JSON Schema output is less faithful. One schema tool everywhere, including env config (TypeBox `Value.Decode`). |
| DB access | **Kysely + `pg`** driver; **dbmate** for migrations; **kysely-codegen** for types | PostGIS work is SQL-shaped (`ST_DWithin`, `ST_ClusterDBSCAN`, KNN `<->`, `ST_AsGeoJSON`); Kysely's typed builder + first-class `sql` fragments embrace that instead of hiding it. **Prisma rejected:** geometry = unsupported types → raw queries anyway, plus a heavyweight runtime; the ORM would be dead weight on our hottest paths. **Drizzle rejected (narrowly):** its PostGIS support is real but point-centric; polygons/geography and the window-function clustering land in custom SQL regardless — at which point Kysely's SQL-first model is the more honest tool. Migrations in plain SQL because our DDL is PostGIS-first (extensions, GIST, geography) and generated migrations fight it; types are *generated from* the migrated DB, so drift is impossible. |
| Geo math | **PostGIS only on the server**; no turf.js server-side | One geometry engine, one semantics (geography vs planar, meters vs degrees — exactly where dual-engine bugs breed). Permitted exception: a haversine one-liner in pure domain code for non-authoritative display math. Turf lives in the *frontend* if the map needs client-side geometry. |
| CSV (FIRMS) | **csv-parse** (sync API) | Balkan-bbox responses are kilobytes; streaming is over-engineering. Mature, correct with quoted fields/CRLF. Rejected: papaparse (browser-first), hand-split (the day FIRMS quotes a field, silent corruption). |
| Scheduling | **croner** | §5.5. Rejected: BullMQ (Redis for nothing at this scale), node-cron (weaker), setInterval (hand-rolling overlap/backoff). |
| SSE | **`@fastify/sse`** (official) | §5.7. Pin version (young plugin); hand-rolled `reply.raw` is the documented fallback. `fastify-sse-v2` superseded for new code. |
| Outbound HTTP | **Native fetch + undici Agent** (timeouts: connect 5 s, total 30 s) + small retry helper | No axios/got needed; undici is already Node's engine. MockAgent doubles as the test stub (§5.11). |
| netCDF / future FCI | **Decision deferred, boundary fixed** (R-9): adapter delivers normalized `Detection` NDJSON. **Node path exists**: FCI L2 FIR is netCDF-4 = HDF5, readable with **h5wasm** (NIST, actively maintained, works in Node). But EUMETSAT's ecosystem is Python-first (`eumdac` official Data Store client, xarray/satpy for decode), so a small Python sidecar container is the *likely* winner. Because the port is NDJSON-over-HTTP (internal ingest endpoint) or direct DB write, the language choice is invisible to the core. Do the one-evening spike from the validation plan before betting. Rejected outright: `netcdfjs` (NetCDF-3 only — FCI files won't open), stale native `netcdf4` bindings. |
| Logging | **pino** (Fastify-native) | Structured JSON; **mandatory redact rules for outbound URLs** (FIRMS MAP_KEY is a path segment — R-11). |
| Ops plugins | `@fastify/sensible`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/under-pressure`, `@fastify/swagger` | Standard kit; under-pressure gives event-loop-aware 503s and hooks into `/readyz`. |

**GeoJSON serialization performance:** with full TypeBox response schemas, Fastify uses
`fast-json-stringify` — typically 2–5× `JSON.stringify` on shaped payloads. At our volume
(≤10³ features) either would do; the real reason to write full schemas is the **contract**
(validated fixtures, generated OpenAPI, shared client types). Do not hand-wave geometry as
`additionalProperties: true` — model `Point`/`Polygon` properly in `contracts/geojson.ts`
once. Add `ETag` (from max `seq`) + `Cache-Control: public, max-age=15` on `/events` so
polling fallback clients get cheap 304s.

### 5.10 Config, secrets, shutdown, health

**Config:** 12-factor env; `.env` via dotenv in dev only. `config.ts` is the *only* file that
touches `process.env`: parses into a TypeBox-validated `Config` at boot, crashes loudly on
any missing/invalid var. Injected as a value; no config imports from domain.

```ts
interface Config {
  role: 'web' | 'worker' | 'all';
  http: { port: number; host: string };
  db: { url: string; poolSize: number };
  firms: { mapKey: string; bbox: [number, number, number, number]; pollSeconds: number };
  effis: { wmsBaseUrl: string; cacheTtlSeconds: number };
  openMeteo: { baseUrl: string; cacheTtlSeconds: number };
  sse: { heartbeatMs: number; ringBufferSize: number; maxConnections: number };
  clustering: { attachRadiusM: number; epsM: number; coolingHours: number; outHours: number };
}
```

**Secrets** at MVP: `DATABASE_URL`, `FIRMS_MAP_KEY` (later: EUMETSAT key/secret, push VAPID
keys). Host secret store (Fly secrets / systemd `LoadCredential` / Docker secrets) — never in
the image, never in logs (pino redact), never in client-visible URLs (all upstream calls are
server-side; the EFFIS/weather proxies exist partly for this reason).

**Graceful shutdown** (SIGTERM/SIGINT, `close-with-grace` or equivalent, hard-exit timer 10 s):
1. Stop scheduler (no new job ticks); signal running jobs via `AbortSignal`, wait ≤5 s.
2. Broadcast SSE `reset {reason:'restart'}`; end SSE connections.
3. `fastify.close()` (drains in-flight HTTP).
4. Destroy pg pool. Order encoded as `onClose` hooks so tests exercise it too.

**Health (R-13):**
- `/healthz` — liveness: process alive, event loop responsive (under-pressure). No I/O.
- `/readyz` — readiness: DB `SELECT 1`. **Nothing else.** Upstream sources degraded ≠ not
  ready — serving stale data with honest freshness labels is the product working as designed.
- `/api/v1/meta/freshness` — the operational truth about sources; monitoring alerts fire from
  it (e.g. `consecutive_failures >= 3`, or `last_data_at` older than 2× expected cadence),
  and the UI renders it. Readiness and freshness never mix.

### 5.11 Testing approach

**Runner: Vitest** across all packages. **The ports & adapters payoff is that the hard 20% —
clustering, lifecycle, dedup, confidence — tests as pure functions with zero mocks.** Spend
the test budget there.

1. **Unit (domain/app)** — no I/O, table-driven:
   - clustering decisions: attach / create / merge-on-bridge; centroid drift; the 2-events-
     within-ε merge; merged-event ID stability.
   - lifecycle transitions incl. `cooling → active` reflare; fake `Clock` port.
   - confidence normalization (every row of the §5.3 table) and event-confidence scoring.
   - FIRMS CSV mapper against fixtures: golden normal file, quoted fields, malformed row
     (skip + count, never crash the poll), empty file, MODIS vs VIIRS column sets.
2. **Integration (real PostGIS via testcontainers)** — `@testcontainers/postgresql` with the
   `postgis/postgis:16-3.4` image; run dbmate migrations against the container; one container
   per suite-run, truncate between tests:
   - repo round-trips incl. geography correctness (a detection 2.9 km from a centroid *is*
     within the 3 km attach radius — this is precisely the class of bug unit tests can't see);
   - dedup upsert: same CSV ingested twice → identical row count; NRT→SP version → values
     refreshed, no new row, no SSE emit;
   - `ST_ClusterDBSCAN` reconciliation query against seeded multi-fire layouts;
   - `updated_after_seq` cursor semantics.
3. **API (fastify `.inject()`, no network)** — build the app with in-memory/stub ports:
   response-schema conformance for `/events` (validate against the *contracts* TypeBox schemas
   — the same artifact the client consumes), problem+json error shape, ETag/304, SSE route:
   headers, heartbeat frame, Last-Event-ID replay, `reset` on unknown ID.
4. **End-to-end slice (the money test):** recorded FIRMS CSV → undici `MockAgent` serves it →
   `poll-firms` job runs against testcontainers PostGIS → assert events created → `.inject()`
   `GET /events` → assert the GeoJSON a browser would render, including freshness member.
   One test, whole spine.
5. **Fixture strategy — start recording NOW, this fire season:** a `scripts/record-firms.ts`
   that hits the real API for the BG bbox and stores raw responses under
   `server/test/fixtures/firms/` with a manifest (capture time, source, bbox, day_range).
   Needed set: quiet day; major-fire day; empty response; two overlapping `day_range` windows
   (the dedup fixture); MODIS and VIIRS variants. This dovetails with validation-plan step 1
   (recommendation 12) — one week of recording yields both the latency ground-truth and a
   permanent regression corpus. Add the FCI granule from the planned spike as a future
   fixture.
6. **CI:** GitHub Actions; testcontainers works on hosted runners (Docker preinstalled).
   Pipeline: typecheck → lint (incl. import-boundary rules) → unit → integration → API/E2E.
   Target wall-clock <5 min.

---

## 6. Open questions for the team

1. **Hosting target?** The design assumes a persistent process behind an HTTP/2-terminating
   proxy/CDN (§5.2, §5.7). Hetzner VM vs Fly.io machine changes the SSE/proxy checklist
   details and the secrets mechanism. Needs a decision before deploy week — and it kills the
   "or serverless" option formally.
2. **EFFIS burnt-area perimeters: what is the actual machine-readable path?** WMS renders
   them, but ingesting *geometries* (for event context/history) needs WFS or a data-request
   export, and EFFIS access terms for automated pulls should be confirmed. Needs a 1-evening
   spike; until then perimeters are a display-only WMS layer.
3. **Merged-event UX contract:** is HTTP 200-with-`mergedInto` (my proposal, §5.6) acceptable
   to the frontend, or does it want the API to transparently resolve to the survivor?
   Decide before the client hardcodes either.
4. **No-auto-split policy (§5.4):** accepted trade-off at MVP? The failure mode is two nearby
   distinct fires rendered as one event until manually split. I claim it's rare and tolerable
   pre-v1; the product owner should sign off because it's user-visible.
5. **FCI adapter ownership & gate:** who runs the EUMETSAT spike, and what's the criterion
   for Node (h5wasm) vs Python sidecar? Proposal: if the spike decodes a FIR granule to
   normalized detections in <1 evening in either stack, pick Python (ecosystem gravity:
   eumdac/satpy) and keep it a sidecar container speaking the NDJSON ingest contract.
6. **Bbox scope as config:** MVP is BG+100 km, v2 is the Balkans. The design treats the bbox
   as one config value — confirm nothing in product plans needs *per-region* polling cadence
   or multiple bboxes before that assumption calcifies.
7. **Public API posture at MVP:** the endpoints are unauthenticated by design (public map).
   Confirm rate-limit numbers and CORS origin policy, and that `/api/v1/detections` (raw
   data) staying public is fine w.r.t. source attribution requirements (FIRMS/Copernicus
   attribution should be embedded in API responses' `attribution` field — cheap to add now).
8. **Retention/PITR for the append-only guarantee:** managed Postgres (Neon/Supabase) free
   tiers have limited backup windows. If `detections` is the reprocessing insurance, a weekly
   `pg_dump` to object storage is a one-cron safeguard — who owns setting it up?

---

*Review artifacts: repo/package skeleton (§5.1), process model (§5.2), dedup design (§5.3),
event-identity algorithm (§5.4), job table (§5.5), route table & contracts (§5.6), SSE
contract (§5.7), initial schema (§5.8), library matrix (§5.9), ops runbook seeds (§5.10),
test plan (§5.11). All are proposals for team review, not fiat — but each is concrete enough
to start coding against.*
