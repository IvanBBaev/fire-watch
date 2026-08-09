# ADR-003: Read path — snapshot-first tiers with SSE as enhancement

*Date: 2026-07-30. Status: accepted (pre-code). Amended 2026-08-02 — see
"Amendment A1" below; where they conflict, the amendment wins.*

Inputs: reviews 02 (backend, SSE contract), 04 (SRE, transport inversion & degradation
ladder), 07 (product/UX, staleness honesty), 08 (frontend, reconciler + supervisor).
Companion to ADR-002 (identity semantics the read path must preserve) and ADR-005
(where the client code lives).

## Context

- The reference failure mode is a traffic spike during a major fire: exactly when the
  product matters most, load is 100–1000× baseline. A read path that requires a
  per-client server connection to *function* collapses then ("map fails open").
- The original ANALYSIS sketch treated SSE as the primary transport. Both engineering
  rounds inverted this (00-summary T2): **CDN-cacheable snapshot polling is the
  product; SSE is a latency enhancement** for the minority of sessions that benefit.
- One VM (ADR/review 04), Cloudflare free tier in front, R2 for static fallback. Fire
  data changes on satellite cadence (minutes), not milliseconds — a 30–60 s poll is
  *honest* relative to source latency (FIRMS ≤3 h, FCI 15–30 min).
- The client is a long-lived PWA session on flaky rural connections; correctness of the
  *client store* across transport switches, reconnects, and merges is part of the read
  path, not an afterthought (08 §5.2.4).

## Decision 1 — Three delivery tiers

| Tier | Transport | Who | Freshness | Cost model |
|---|---|---|---|---|
| **T0** | SSE `/api/stream` | opt-in enhancement | seconds | per-connection, capped |
| **T1** | poll `/snapshot.json` | **default for everyone** | 30–60 s | CDN-absorbed |
| **T2** | static snapshot on R2 | automatic fallback | ≤5 min | origin-independent |

- **T1 (default):** clients poll `GET /snapshot.json` every 30–60 s with jitter. The
  response is the full active-event set (list + geometry + per-event `seq`), edge-cached
  with `s-maxage=30, stale-while-revalidate=60`; `ETag` derived from the global max
  sequence number, so unchanged snapshots are 304s. A cursor variant
  `?updated_after_seq=N` returns only newer events for cheap incremental polls.
- **T0 (SSE):** explicit enhancement, never required for any feature. Hard cap **5,000
  concurrent connections**; beyond it the endpoint answers **503 + Retry-After** and
  clients silently stay on T1. Contract (02): event types `event.created`,
  `event.updated`, `event.status_changed`, `event.merged`, plus `freshness` and
  `reset`; `id:` = global monotonically-increasing sequence; server keeps a ~1,000-frame
  ring buffer to honor `Last-Event-ID` replay; keepalive comment every 25–30 s; SIGTERM
  drains by sending `retry:` and closing, clients resume via `Last-Event-ID` on the new
  process.
- **T2 (static):** the worker uploads the same snapshot JSON to R2 every cycle. If the
  origin is down or erroring, clients (and Cloudflare, via a worker route or plain
  redirect rule) fall back to the R2 URL. The map keeps working with data at most
  minutes old — a degraded product, not an outage.
- **Server-side transport control:** `/api/client-config` (cached, tiny) tells clients
  which tiers are currently enabled and the poll interval. Ops can turn SSE off or
  stretch the poll interval for the whole fleet *without a deploy* during an incident
  (04 transport inversion).

**Explicit decision on the open question "is SSE a product requirement?": no.** SSE is
an enhancement with an availability target of best-effort; every user-visible feature
must be fully functional on T1 alone, and CI runs the e2e suite in polling-only mode to
enforce it. (Rationale: the only data that is seconds-fresh is *our processing* of
sources that are minutes-to-hours old; paying availability risk for sub-poll latency
would be dishonest engineering — the honest-clock principle applied to transport.)

## Decision 2 — Staleness is first-class at every tier

Every payload (SSE `freshness` frames, snapshot body, R2 object) carries
`generated_at` plus per-source freshness metadata. The client always renders data age
from **server timestamps against the product's freshness budgets** — never from
transport liveness. A user on T2 sees the same banner semantics as a user on T0: they
learn *how old the data is*, not *which architecture tier they're on* (08 §5.6: same
banner, strict single-slot priority; T2 activation is not a distinct user-facing
state).

## Decision 3 — Client store contract (the reconciler)

The client keeps one event store fed by whichever transport is active. Five normative
rules (08 §5.2.4):

1. **Snapshot is the authority on the *set*; sequence is the authority on each event's
   *version*.** Apply a snapshot by upserting each event iff `f.seq >= stored.seq`.
   Remove a stored id absent from the snapshot only if `snapshot.maxSeq >
   events[id].seq`; two consecutive authoritative absences ⇒ unconditional remove.
2. **Deltas (SSE) upsert iff `d.seq > stored.seq`** — replayed frames are no-ops
   (idempotent). `event.merged` writes a client-side tombstone (`mergedInto`) that ages
   out after 24 h.
3. **Gap detection:** a frame with `id > maxSeq + 1`, a `reset` frame, or a reconnect
   hole beyond the ring buffer ⇒ force a snapshot fetch; buffer incoming deltas and
   apply them (rule 2) after the snapshot lands.
4. **Never delete on a delta; never create on a snapshot-miss.** Deletions require
   snapshot authority (rule 1); unknown ids in deltas are upserts.
5. **Clock discipline:** staleness always computed from server timestamps; absolute
   time is always displayed beside relative age (07).

Property-tested with fast-check (08): convergence (any interleaving of
snapshots/deltas reaches the server state), no seq regression, no zombie events, delta
idempotence, no flicker-delete.

**Transport supervisor** (state machine in the framework-free core, ADR-005):
`BOOT → POLLING (T1)` → optionally `SSE_CONNECTING → SSE_LIVE` (poller stopped, safety
snapshot every 10 min) → on error, **silent** fallback to `POLLING`;
`STATIC_FALLBACK (T2)` when the snapshot origin fails; auto-promotion back is
hysteresis-damped (30 min) to prevent flapping. Tab wake and `online` events force a
snapshot refetch before trusting any transport. Poll interval jittered 30–60 s per
`/api/client-config`.

## Decision 4 — Identity semantics on the wire

- Requests for a merged event id return **200 with `mergedInto`** (never 404) — the
  read-path half of ADR-002 I1/I2; the web app redirects to the canonical permalink
  with `replaceState`.
- Event payloads carry `seq`, `status` (ADR-002 lifecycle names), `generated_at`, and
  the score bucket — the client never computes lifecycle or confidence locally.

## Consequences

- The origin serves O(1) distinct responses per interval regardless of user count;
  spike survival is a CDN property, not a capacity plan. SSE capacity (5,000) is a
  *bonus pool*, not a promise.
- Every feature must be poll-complete before any SSE work lands; SSE ships only after
  T1+T2 pass the load battery (06 §5.6: 5k-conn soak, reconnect storm, p95 broadcast
  ≤2 s, 200 req/s REST p95 ≤300 ms).
- The reconciler contract is implementable and testable before any UI exists
  (property tests against a simulated server), and it pins client behavior for future
  native/B2B clients too.
- Freshness metadata is duplicated into every tier's payload — small cost, buys honest
  UX and the 04 meta-alerting hooks (`/api/health/freshness`).

## Amendment A1 (2026-08-02)

Outcome of review 13 §3.5 item 25 (demotion thresholds, T2 flip path, API surface
conventions from 02 §5.6) and review 14 (M1 and the client-clock-skew minor). Six
changes; everything not mentioned stands. Where the amendment and the original text
conflict, the amendment wins.

### A1.1 Automatic T0→T1 demotion has numeric triggers, and they are L-2 pass criteria

Decision 1 gave the transport supervisor a control surface but no thresholds — demotion
read as a manual ops act. Pinned from 04 §5.2.3:

**Demotion triggers (server-side, automatic).** The server flips
`/api/v1/client-config` to `transport: "poll"` when **any** of:

| # | Trigger | Window |
|---|---|---|
| 1 | concurrent SSE connections > cap (5,000) | instant |
| 2 | event-loop lag **p99 > 200 ms** | sustained 5 min |
| 3 | host CPU **> 80%** | sustained 5 min |

**Mechanics.** Live streams receive a `degrade` frame and are closed; the native
`EventSource` retry then meets the endpoint's `503 + Retry-After: 60` and the client's
error handler settles on T1. Demotion is **silent** — Decision 2 stands, users learn
data age and never which tier they are on. **Re-offer hysteresis: SSE is re-enabled
only after 30 min continuously below all three thresholds** (the same 30 min as the
supervisor's promotion damping in Decision 3).

**L-2 pass criteria.** The load battery (GATES L-2) does not pass on throughput numbers
alone; it must demonstrate the ladder:

1. Each of the three triggers, injected independently, flips `client-config` within one
   config TTL (≤30 s) and is visible in metrics.
2. The demoted fleet lands on T1 with **no data loss** — every client's store converges
   to server state across the switch (Decision 3 rules 1–4).
3. Edge cache hit ratio on `/snapshot.json` **≥ 95%** while the fleet is on T1
   (04 Appendix B).
4. No re-promotion before the 30-min window elapses (no flapping).
5. The existing L-2 numbers stand unchanged: 5,000-connection soak, reconnect storm,
   p95 broadcast ≤2 s, 200 req/s REST p95 ≤300 ms.

Configured-but-undemonstrated is a fail. (Sustained CPU >70% for 1 h *at T1*, or a
weekly event-loop-lag p99 >200 ms, is a VM-upgrade trigger — an ops-layer rule, not a
demotion trigger, and not this ADR's.)

### A1.2 The T2 flip is client-side against a second R2 hostname — never a Worker route

Decision 1's parenthetical "(and Cloudflare, via a worker route or plain redirect
rule)" is **withdrawn**. The normative failover path is exactly one mechanism
(04 §5.2.3):

- **The client-side transport supervisor is the only actor that flips to T2.** It
  fetches the snapshot from a **second hostname** bound directly to the R2 bucket
  (custom domain on the bucket: object storage plus CDN cache, **no compute in the
  path**). The hostname is **baked into the app shell at build time** and may be
  refreshed through `/api/v1/client-config`; the build-time value is what survives the
  case where client-config itself is unreachable.
- **Ruled out: a free-tier Cloudflare Worker route as the failover mechanism.** It puts
  compute on the one path whose entire purpose is to work while compute is failing; the
  free tier carries a daily request ceiling and a spike is precisely the event that
  blows through it; and a Worker can only react to what the *edge* observes — it cannot
  detect the failure mode that matters most here, an origin answering `200` with a
  stale snapshot. An edge redirect rule may exist as defense in depth, but nothing in
  the product may depend on it and it is never what L-2 or the failover demo exercises.
- **Flip conditions (client):** three consecutive unusable snapshot responses (network
  error, timeout, 5xx, or 429) spanning ≥2 poll intervals, **or** one successfully
  fetched snapshot whose `generated_at` is older than the T2 freshness bound (≤5 min,
  Decision 1 table) measured with the server-time offset of A1.6. A `429`/`503`
  additionally holds the next attempt until `Retry-After`.
- **Return to T1** follows the supervisor's existing 30-min hysteresis (Decision 3),
  unchanged: the T2 payload is honestly timestamped at every moment, so a damped return
  costs the user nothing but freshness they can see.
- **The R2 object gets its own liveness check.** A stalled upload job turns T2 from a
  fallback into a lie, so object age is monitored against the T2 freshness bound
  independently of origin health.

### A1.3 API surface conventions (02 §5.6) — versioning, errors, limits, CORS, attribution

No distilled document defined error semantics at all. Pinned:

**Prefix.** Every JSON API route lives under **`/api/v1`**. This renames the two paths
named in Decision 1: `/api/stream` → **`/api/v1/stream`**, `/api/client-config` →
**`/api/v1/client-config`**.

**Deliberately exempt**, because they are cache and probe artifacts rather than an
evolvable API contract, and their paths are load-bearing inside cache rules:
`/snapshot.json` and its R2 twin, `/healthz`, `/readyz`. The snapshot object versions
its shape **in the body** (`schema_version`) so a CDN object never needs path
negotiation. Field-naming convention is owned by `packages/contracts`, not by this ADR.

**Errors: RFC 7807 `application/problem+json`, one handler.**

- A **single** error handler is the only place that turns a thrown error into a
  response; no route emits an ad-hoc error shape.
- Members: `type` (a stable URI, `about:blank` when there is nothing to document),
  `title`, `status`, `detail`, `instance`, plus a correlation-id extension member that
  is also written to the log line.
- `detail` is public text: no stack traces, no SQL, no upstream URL bearing a
  credential.
- **Clients key their behavior off the status code and `Retry-After`, never off the
  problem body** — the body is for humans and logs. This binds the two places the read
  path errors on purpose: the SSE cap's `503 + Retry-After` (Decision 1) and any
  deliberate error the ops layer defines in preference to serving silently stale data.

**Rate limiting** (posture, values as config-as-data tunable without a deploy, like the
poll interval in Decision 1):

- The CDN-absorbed path is protected by its **cache rule, not an origin limiter** —
  `/snapshot.json` carries no meaningful per-IP throttle, because throttling it would
  penalize the default tier during exactly the spike it exists for.
- `/api/v1/stream` carries a **per-IP concurrent-connection cap** on top of the global
  5,000 cap (cheap DoS insurance, 02 §5.7).
- Uncached or upstream-costing routes (raw detections, weather, layer proxies) get
  materially harder per-IP limits; they are debug/power-user surfaces, not the product.
- Limits answer **`429` + `Retry-After`** in problem+json. A `429` counts as an unusable
  response for the client's T2 streak (A1.2): if the origin is shedding, shedding *to
  T2* is the designed outcome, since T2 costs the origin nothing.

**CORS:**

- Public read routes under `/api/v1`, and `/snapshot.json`:
  `Access-Control-Allow-Origin: *` for **GET/HEAD only**, no credentials. The data is
  public and third-party embeds are a product goal.
- Because credentials are never accepted on these routes, `Allow-Credentials` stays off
  and the wildcard is safe; a cookie or `Authorization` header on a public read route is
  a defect, not a feature.
- Authenticated surfaces (accounts, watch zones — ADR-004) use an explicit origin
  allowlist, never `*`. `Vary: Origin` wherever the header is computed rather than
  constant.

**Attribution member.** Every JSON API response and every snapshot object (origin and
R2) carries an `attribution` member holding the verbatim licence strings for the sources
represented in that payload. Rationale: a consumer who takes our API instead of our map
must inherit the obligation together with the data — attribution that lives only in the
map control is droppable by construction. The strings come from the same single registry
as the map credits (ADR-001 A1.4, `credits.ts`; verbatim text in `DATA-SOURCES.md`), and
the CI presence test guarding that registry (CI-13) covers the API response path too.

**Imported as conventions only.** 02 §5.6 also sketches payload details that ADR-002 has
since superseded — event ids are `fw-<year>-<base32>`, not uuids, and lifecycle names are
ADR-002's. Where that route table conflicts with ADR-002/003 on payload content, the ADRs
win; this amendment imports the surface conventions, not the field values.

**Left open on purpose.** This ADR's Consequences cite `/api/health/freshness` while
02 §5.6 names `/api/v1/meta/freshness`. The canonical freshness path is resolved by the
ops ADR, not here; whichever wins, it is a versioned API route rather than a probe and
therefore lives under `/api/v1`.

### A1.4 Invariant R1 — every set-membership change is a status transition that bumps `seq`

This is an invariant of the read path, on the same footing as ADR-002's I1–I5, not a
piece of implementation advice.

> **R1.** Membership of the active event set changes **only** through a status
> transition written to the database, and every such write increments the global
> sequence. The snapshot builder is a pure projection of stored status and **never
> applies a wall-clock filter** — no `now() - interval` predicate, no age-based
> exclusion, no "hide if older than" evaluated at snapshot-build time.

**Why it is an invariant.** The `ETag` derives from the global max seq, so an event that
left the set merely because time passed — the display-window rule (48 h on the map, 7 d
on the permalink), which performs no state write — would never move the ETag: clients
would receive `304` forever and keep a zombie event on screen. In season, other events
mask the bug because the max seq moves anyway; **off-season, with nothing else moving the
max seq, it is a real stuck state** (14 M1).

Consequences, all normative:

- Time-based product rules are implemented as **scheduled status transitions** — a job
  writes the transition when the window expires — never as a query filter. This binds
  the display-window rule and any future "hide X after Y" rule.
- The invariant binds the **R2 object too**: T2 is produced by the same builder from the
  same projection, so a wall-clock filter there would strand T2 clients identically.
- Acceptance: for **every** path by which an event leaves the set, the ETag before ≠ the
  ETag after. A removal that leaves the ETag unchanged is a failing build, not a latency
  quirk.

### A1.5 The cursor variant is not authoritative over the set

`?updated_after_seq=N` is a bandwidth optimization on the **version** axis only.
Decision 3 rule 1 is unchanged and now explicit about the cursor: **only a full snapshot
carries authority over the set.** A cursor response therefore can never justify a
removal, and a client polling cursors exclusively can never remove anything — it
accumulates zombie events indefinitely (14 M1, second leak).

- **Server:** a cursor response carries the global max seq and `generated_at` like a full
  snapshot, and is explicitly marked non-authoritative over the set (`partial: true`) so
  no client — ours or third-party — can mistake it for one.
- **Client (normative):** any client using the cursor variant **must fetch a full
  snapshot at least every 10 minutes** — the same cadence as the SSE safety snapshot in
  Decision 3. The 10-min timer runs independently of the poll timer, is reset by a full
  snapshot from any cause (tab wake, `online`, gap detection, transport switch, T2 flip),
  and is jittered like the poll.
- **Property-test obligation:** a cursor-only client converges within **at most one
  full-snapshot cycle** after a removal — fixture **S15**, fast-check, owned by the WP3
  client suite (14 §5). It joins the CI-8 reconciler property set, whose "no zombie
  events" property is today proven only for snapshot-fed clients.

### A1.6 Staleness math uses a server-time offset estimated from the `Date` header

Decision 3 rule 5 ("staleness always computed from server timestamps") pinned the inputs
but not the subtraction: `now − generated_at` still reads the device clock, so a device
hours off fabricates a staleness banner over fresh data, or hides one over stale data
(14 §3). Pinned mechanism, living in the framework-free core beside the reconciler:

- On every successful response — **including the `304`s that are a polling client's
  common case** — record the sample `(serverTime, monoAtReceive)`, where
  `serverTime = Date + Age + rtt/2`: the HTTP `Date` header, plus the response's cache
  `Age` (a CDN HIT serves a stored `Date`), plus half the measured request duration.
  Keep the **median of the last 5 samples**; `Date` has 1-second resolution, so treat an
  offset below 2 s as zero — the banner must not churn on rounding.
- **`serverNow() = serverTime + (monotonic now − monoAtReceive)`**, and staleness is
  `serverNow() − generated_at`: both terms are server-side quantities. The device clock
  never contributes an absolute timestamp, only elapsed time, and only from a
  **monotonic** source — so an NTP correction, a manual clock change, or a laptop
  resuming from sleep cannot move the banner. `serverTimeOffset = serverNow() − device
  now` is kept for diagnostics only.
- Absolute times displayed beside relative age (Decision 3 rule 5) are formatted from the
  **server** timestamp into the device's timezone. A wrong device *clock* must not shift
  a displayed observation time; only a wrong device *timezone* can, and that is visible
  and user-owned.
- If a response carries no usable `Date` (it should not — HTTP requires one), the offset
  holds its last known value, or 0 on a cold start, and the condition is logged. **The
  client never invents an offset and never falls back silently to the device clock.**
- Testable in the reconciler suite (CI-8 family): with the simulated device clock skewed
  ±6 h, the rendered staleness state is identical to the unskewed run.
