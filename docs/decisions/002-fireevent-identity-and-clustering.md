# ADR-002: FireEvent identity & incremental clustering

*Date: 2026-07-30. Status: accepted (pre-code), amended 2026-08 — Amendment **A1**
(review 13 §3.3 item 15) and Amendment **A2** (review 14 H1, H2, M5 + minors). Amendment
paragraphs are marked inline under the decision they change and are indexed in the
"Amendment log" at the end; where an amendment conflicts with the original text, **the
amendment wins**. No accepted decision is reversed — every amendment is a clarification,
a pin, or a superseded mechanic.*

This ADR resolves the single highest-risk domain decision identified by both review
rounds: how anonymous satellite detections become **stable, public, permalinkable fire
events**. It is the precondition for all ingestion code. Inputs: reviews 01 (architect),
02 (backend), 03 (geodata), 06 (QA), 07 (product/UX), 11 (data science, normative for
scoring/decay/tuning), 12 (fire domain, normative for vocabulary/reignition).

## Context

- Satellites deliver **point detections** (a pixel center + timestamp + radiometry).
  Users, permalinks, and alerts need **fires**: named, stable entities with a lifecycle.
  The mapping is many-to-many over time: one fire produces hundreds of detections; one
  detection batch can reveal that two "fires" were always one.
- Identity mistakes are product-fatal in ways ordinary bugs are not: a fire that changes
  URL mid-crisis breaks shared links exactly when sharing peaks; a spurious merge makes
  an alert say "your fire grew" about someone else's fire; a re-used ID after
  reprocessing silently re-alerts thousands.
- The pipeline is **incremental** (a poll loop appending small batches), while most
  clustering literature assumes batch runs. The design must define what happens *between*
  two consecutive polls, not just the final partition.
- Constraints already fixed elsewhere: single-writer worker (PG advisory lock, review
  01/04); append-only detections with NRT→SP monthly partition swap (03); alerts keyed
  per `(zone_id, event_id)` (06 R3, ADR-004); honest lifecycle vocabulary — the word
  "out" never appears (12 §4.3); "map fails open, alerts fail closed" (00-summary T3).

## Decision 1 — Three-layer model

| Layer | Table | Mutability | Identity guarantee |
|---|---|---|---|
| **Detection** | `detections` | append-only, immutable | `detection_uid` dedup key, no public identity |
| **Cluster** | `clusters` | ephemeral, recomputed | none — internal working set only |
| **FireEvent** | `fire_events` | stable registry | `public_id` permanent, survives merges |

1. **Detection** rows are never updated in place.
   `detection_uid = sha256(source | acq_ts_iso | lat_5dp | lon_5dp)` is the idempotent
   upsert key (03 §detection_uid); re-polled rows are no-ops. Each row carries full
   provenance (`source`, `product_tier NRT|SP|GEO`, `available_at`, raw confidence
   class, FRP) — this doubles as the licensing audit trail (09 §2.3).
   **Schema reserves per-source pixel-footprint fields** (`scan_km`, `track_km`,
   optional `footprint geometry`) even though MVP logic uses only points — required
   later for GEO/FCI fusion, and unrecoverable if not captured at ingest (06 Q8).

   > **Amendment A1.1 (2026-08 · review 13 §3.3(15), C7) — dedup is an intentional
   > no-op, not a refinement.** The upsert is `ON CONFLICT (detection_uid) DO NOTHING`.
   > A re-polled row is discarded in full: within a tier, later deliveries of the same
   > observation carrying a *refined* confidence class, processing version, brightness
   > or FRP are **deliberately thrown away** — the first-seen row is the archive record.
   > Rationale: a mutable detection row makes replay non-deterministic (I5) and silently
   > rewrites the evidence behind alerts that were already sent, so the archive would no
   > longer explain its own history. Review **02 §5.3's `ON CONFLICT … DO UPDATE SET
   > version/confidence/frp/brightness/raw` refinement semantics are superseded**, and
   > with them the 02 §5.11 integration expectation "NRT→SP version → values refreshed,
   > no new row" — cross-tier revision is handled **only** by the Decision 7 partition
   > swap, never by in-place update. Ingest still counts `inserted` vs `skipped` per
   > batch (both feed the ingest-anomaly breaker); only *inserted* detections proceed to
   > clustering and SSE.
   >
   > **Amendment A1.2 (2026-08 · review 13 §3.3(15); 09 §2.2.F, DATA-SOURCES) — ODbL
   > containment rule.** **No OSM element identifier (node/way/relation id) may ever be
   > stored in a fire-event record** — not on `fire_events`, not on `detections`, not on
   > any derived or exported public record. Nearest-place enrichment stores the settlement
   > *name and coordinates only*; mask cross-checks against OSM (`landuse=industrial`,
   > `man_made=works|flare|chimney`) are performed in a separable store and land in our
   > tables as geometry + our own key, never as an OSM key. Rationale: per the OSMF
   > Collective Database Guideline our fire database and OSM stay a mere *collective*
   > database only while the two datasets "do not reference each other" by database keys;
   > an OSM element id in a fire-event row is exactly such a reference and risks
   > share-alike (ODbL) contamination of the registry. This is a schema rule with a
   > lintable consequence: any column named `osm_*`/`*_osm_id` on the event or detection
   > tables is a review defect.
2. **Cluster** is the spatio-temporal working set the incremental algorithm maintains
   over the trailing window. Clusters have no public identity, may be rebuilt from
   detections at any time, and are never exposed in the API.
3. **FireEvent** is the public registry row a cluster is *promoted* to. Public identity
   is `public_id` in the form `fw-<year>-<5-char base32>` (e.g. `fw-2026-k3d7q`),
   generated once, never re-used, never derived from geometry or time (so it cannot
   change when either is revised). The DB primary key is a separate internal bigint —
   `public_id` is an API-layer concern (01).

   > **Amendment A2.1 (2026-08 · review 14 §3 minors) — `fw-<year>` is mint-year,
   > cosmetic only.** The `<year>` segment is the UTC calendar year in which the id was
   > *minted*, and nothing else. "Never derived from time" means never *semantically*
   > derived: no code path, query, route, partition, sort, or alert template may parse or
   > depend on that segment — it is a human-readable convenience for support and log
   > reading. It is therefore **never corrected**. An SP revision that moves `started_at`
   > across a New Year boundary (D7), or a merge survivor that lives into the next
   > calendar year, leaves the embedded year cosmetically wrong; that is the accepted
   > outcome, because mutating a published id would break I1 — the far larger harm. If a
   > display ever needs the fire's year, it reads `started_at`, never the id.

## Decision 2 — Incremental identity algorithm

Per ingest batch (one source poll), inside one transaction, on the single writer:

```
for each new detection d (ordered by available_at, source, lat, lon):
  candidates = active clusters with any detection within eps(d.source) of d
               and last_detection_at within T_LINK
  0 candidates -> create cluster (seed)
  1 candidate  -> attach d
  N candidates -> attach d; if d.source is a FINE source, merge clusters
                  (coarse/GEO detections NEVER trigger merges - attach to the
                  nearest candidate only)
```

- **Active window:** clusters remain attach-eligible for a trailing **72 h** past their
  last detection; beyond that they leave the working set (the event remains, see
  lifecycle).
- **ε per source** (initial values; tuned per Decision 5): VIIRS **1.0–1.5 km**; MODIS
  **max(3 km, 1.5·√(scan·track) km)** (footprint-aware — edge-of-swath MODIS pixels are
  ~4.8×2 km); SLSTR ~1.5 km; GEO (FCI/SEVIRI) **5–6 km**.
- **T_LINK** (same-event temporal gap): fitted as the **p99 intra-fire detection gap**
  on labeled backfill; expected range **36–60 h** (covers cloudy-day gaps without
  bridging separate fires).
- **Coarse sources are attach-only.** A GEO pixel is ~4×5 km at our latitude; letting it
  bridge two VIIRS clusters would manufacture chimera events. GEO detections can
  *corroborate* (score, persistence) but can neither create nor merge events. Events are
  created only when a cluster contains at least one fine-source detection.
- **Promotion:** a cluster becomes a FireEvent immediately on creation (the event
  registry mirrors the working set 1:1). Whether the event is *visible/alertable* is a
  score/gating concern (Decision 6, ADR-004), not an identity concern — this keeps
  identity deterministic and moves all judgment calls into scoring.
- **Ties, boundaries and degenerate inputs** in this algorithm (equidistant coarse
  attach, reignition parent choice, inclusive comparisons, missing MODIS footprint,
  unclassified fuel) are pinned in **Appendix A** (Amendment A2.5) — they are part of
  `clustering_params_v1` and are asserted by the double-run byte-diff.

### Reignition vs continuation

A new cluster appearing near a no-longer-detected event is either the same fire
(missed by satellites) or a reignition. Rule: within **T_LINK** → same event (attach);
past T_LINK but within the **fuel-specific reignition window** and within 2×ε → **new
event** carrying `related_event_id` + relation `possible_reignition` (UI copy:
"possible reignition of …" — never asserts causality, 12 §4.4); past the window →
unrelated new event.

Reignition windows (12 §4.4): **7 d** grass/agricultural or events <100 ha; **14 d**
shrub/mixed or 100–1,000 ha; **21–30 d** forest >1,000 ha or conifer/high-duff (smolder
risk). **T_REIGNITE** used for cluster-level linking is fitted as the p95 inter-episode
gap (expected 4–8 d) and clamped by the fuel window. Static-mask locations (industrial
heat sources) never become events at all — they are filtered at scoring with reason
`static_source` (Decision 6).

## Decision 3 — Merge semantics

When fine detections bridge clusters A and B:

1. **Survivor** = min by `(started_at, −detection_count, id)` — the oldest event wins;
   ties broken by size then internal id. Deterministic, replay-stable.
2. Losers become **tombstones**: `fire_events.merged_into = survivor_id`, no row
   deletion, aliases retained forever. Lookups resolve alias chains with **path
   compression** (each resolution rewrites intermediate pointers to the final survivor),
   so chains stay O(1) amortized and cycles are impossible (I2).
3. Detections and derived aggregates (hull, max FRP, detection_count, started_at) are
   re-attributed to the survivor in the same transaction.
4. **`migrateAlertState` runs in the same transaction** (06 R3): the survivor inherits
   the *most-advanced* notified state of **all** parents per `(zone_id, event_id)`, so a
   merge can never re-classify an already-notified fire as "new" for any zone. The
   emitted SSE frame is `event.merged { losers: [...], survivor }`.
5. **API contract:** any request for a merged `public_id` returns **200 with the
   tombstone's `mergedInto`** pointing at the canonical id — never 404, never 301-only
   (clients need the body to update stores). The web app `replaceState`s to the
   canonical URL (08 §5.2).

**Permalink stability is a formal acceptance criterion of this ADR** (07 Q1): a shared
event URL resolves to the same fire — directly or via `mergedInto` — for the lifetime of
the archive. Verified by golden-replay scenario S2 and a dedicated property test.

## Decision 4 — Splits: curated only at MVP

- **No automatic splits.** Automatic splitting reassigns detection history between
  identities and cannot be done deterministically with our data density; a wrong split
  is worse than a conservative non-split (12).
- Operational guardrail: when an event's hull diameter exceeds **20 km**, it is flagged
  `needs_review` for a human decision (the 15–25 km range from reviews resolved to
  20 km — larger than any plausible single BG fire front, smaller than obvious chimera
  cases).
- **Curated split** (admin tool, v1): operator draws the partition; the **plurality of
  recent detections keeps the existing `public_id`**; minority side gets a new id with
  `split_from` relation. Alert state: both sides inherit the parent's notified state
  (never re-"new").

## Decision 5 — Parameters are versioned config-as-data, fitted not guessed

All thresholds above (ε table, T_LINK, T_REIGNITE, decay weights, score coefficients)
live in a versioned config object (`clustering_params_v1`, …) **in git**, loaded at
startup, with the **version recorded on every event and alert row** (06 §5.7). Changing
a parameter is a PR + shadow-mode diff, not a live tweak. **Appendix A** (Amendment
A2.5) is part of this config spec: the boundary and tie rules that determinism depends
on are versioned and changed under exactly the same regime as the thresholds.

Initial fitting (week-1 backfill task, 00-summary): grid search (~600 configs) over the
2020–2025 FIRMS SP backfill labeled against EFFIS burnt-area perimeters (11 §4).
Acceptance thresholds: pairwise **recall ≥0.95**, **precision ≥0.98**; over-split ratio
mean **≤1.15** / p95 **≤2**; chimera rate **≤3%**; timeline agreement ±12 h **≥90%**.
Selection uses the **plateau rule** (pick the center of the widest acceptable region,
never argmax — argmax overfits label noise). Re-tuned annually pre-season; season
splits per 11 §8 (fit 2020–23, calibrate 2024, test 2025 touch-once).

## Decision 6 — Confidence score and lifecycle (normative summaries)

These are owned by reviews 11/12 in full detail; the ADR fixes their *contract* with
identity:

**Score** (11 §3, supersedes 03 §5.2.3): per-event bounded logistic
`P(real fire | evidence)` over ≤12 features (best-pixel pseudo-probability,
persistence, multi-source, night flag, spatial coherence, FRP, FWI, minus agri-mask,
scene-edge, glint terms). Buckets: **Confirmed ≥0.75**, **Likely 0.45–0.75**,
**Unverified <0.45**. Hard overrides bypass the formula: static-source mask → score 0 +
`invalidated`; water/glint guard. Unverified copy always includes "may still be a real
fire" (false-reassurance guard). **Score downgrades never notify.** Scoring never
changes identity — an invalidated event keeps its id and history.

**Lifecycle** (12 §4.3 wording ladder — these are the *only* states; the word "out"
never appears in schema, API, or UI):

```
active -> signal_weakening -> no_longer_detected -> archived
  ^              |                    |
  |              +--- (re-detection) -+--> active        [within T_LINK]
  |
  |  officially_contained / officially_extinguished      [curated sources only]
  |              |
  +--------------+  (re-detection within T_LINK)         [escalation, never new_fire]
```

> **Amendment A2.2 (2026-08 · review 14 H2) — the `officially_*` states are no longer
> terminal.** As originally drawn they had no outgoing transition, yet Bulgarian fires
> routinely re-flare after being declared **локализиран**, and our satellites will
> contradict the official statement inside T_LINK. Amended rules:
>
> - **Re-detection within T_LINK returns the event to `active`.** Any fine-source
>   detection that attaches to the event under Decision 2 while it sits in
>   `officially_contained` or `officially_extinguished`, with a gap `≤ T_LINK` from the
>   last detection, transitions it back to `active`. Past T_LINK the unchanged
>   reignition rule applies (new event + `possible_reignition`).
> - **The official statement is preserved as history, never overwritten.** The event
>   keeps the declaration, its timestamp, and its ГДПБЗН attribution, and continues to
>   display them after the return to `active`. Satellite data never sets and never
>   clears an `officially_*` state — those remain curated-source-only in both
>   directions.
> - **The alert is an `escalation`, never a `new_fire`** (it is a status worsening of an
>   event the zone was already notified about). This also settles the alert-type
>   ambiguity review 13 raised for the within-T_LINK case; per-`(zone_id, event_id)`
>   state is untouched, so no zone can be re-classified as "new".
> - **The copy states both facts and adjudicates neither** — new satellite detections at
>   `<t>`, after the official declaration at `<t0>`. We never say the authority was
>   wrong, never say the fire is out, and never explain the discrepancy. The exact
>   EN+BG strings are a GLOSSARY §3 row in CI-11 scope (owned by the GLOSSARY task, not
>   by this ADR).
>
> Asserted by fixture **S12**.

Transition to `no_longer_detected` uses the **miss-evidence accumulator E** (11 §5):
each *clear-sky* overpass that should have seen the fire but didn't adds weight (VIIRS
night 1.25, VIIRS day 1.0, MODIS 0.5, SLSTR 0.75, GEO 0.05 per 10-min slot capped
1.0/day and only while last FRP ≥ 1.5× the GEO detection floor). Cloud gating via
hourly cloud_cover: >80% no accumulation, 50–80% half weight, <50% full. Transition
requires **E ≥ 3.0** (**≥ 5.0** for large events: hull ≥100 ha OR max_frp ≥100 MW OR
peat/landfill fuel) **AND ≥24 h since last detection AND misses spanning both diurnal
phases**. Guardrails: **FER** (False Extinguish Rate — re-attach within 72 h after
`no_longer_detected`) **≤5%**, **≤10%** for large events — measured continuously; a
**source outage freezes E** (no accumulation while a source's freshness budget is
blown, 04); large events fade on the map but persist listed ("fade-and-persist").

> **Amendment A2.3 (2026-08 · review 14 H1) — the E-accumulator must not deadlock.**
> Two paths could leave an event stuck in `active` forever. Both are closed:
>
> 1. **The outage freeze is per-source, never global.** "A source outage freezes E" is
>    scoped to the *blown* source only: while source `s` is outside its freshness budget
>    it contributes no expected overpasses and no miss weight, and **every other source
>    keeps accumulating E normally**. A global freeze was never intended and is
>    superseded. Thresholds (E ≥ 3.0 / ≥ 5.0) are **not rescaled** when a source drops
>    out — a thinner constellation simply takes longer to reach them, which is the
>    honest behaviour.
> 2. **A `retired` source leaves the expected-overpass set entirely.** Terra/Aqua
>    (MODIS) reach end-of-life inside this project's window; a permanently dead source is
>    not an outage and must not be treated as one — with an outage freeze it would freeze
>    E forever and nothing would ever reach `no_longer_detected` again. The frozen
>    source-id registry therefore carries a **status** per source
>    (`active | degraded | retired`) with the **date the status took effect**; a source
>    that is `retired` as of a given instant is removed from the PassPredictor's expected
>    passes from that instant on and produces neither misses nor freezes. Because the
>    effective date is recorded, a replay of an earlier period reproduces the
>    constellation *as it was then* (I5). Retirement is a config-as-data change under
>    Decision 5 (PR + version recorded on the event), never a live toggle. (The registry
>    column itself is owned by GLOSSARY §1 / `packages/contracts`, not by this ADR.)
> 3. **Hard unobservability fallback (ceiling on the cloud gate).** `>80%` cloud yields
>    no accumulation and had no ceiling, so a small fire under weeks of overcast stayed
>    `active` indefinitely — dishonest in the opposite direction from false reassurance.
>    Rule: **≥ 14 consecutive days** with **zero detections** *and* **zero accumulable
>    overpasses** (every opportunity gated out by cloud, or no opportunity existed at
>    all) transitions the event to `no_longer_detected` **regardless of E**. The
>    transition is recorded with `reason = unobservable` and renders the **dedicated
>    cloud-fallback copy variant (GLOSSARY §3b)**, which says that *observation was
>    impossible for N days* — it must never say or imply that a satellite looked and saw
>    nothing, and never that the fire is out. Re-detection afterwards behaves exactly
>    like any other re-detection (within T_LINK → `active`). Because this transition is
>    not a miss-evidence conclusion, it is **excluded from the FER numerator** and
>    reported as its own class in the decay-honesty dashboard (11 §9.3 "cloud-frozen
>    events"), so the fallback can never be used to flatter the FER metric.
>
> Asserted by fixture **S11**.

> **Amendment A1.3 (2026-08 · review 13 §3.3(15); 00-summary T8, 07) — display window.**
> An event that stops being detected does not vanish from the product at the moment of
> the state transition. Normative display window: **48 h on the map** after the event
> goes inactive (rendered gray/faded, per the fade-and-persist rule large events stay
> *listed* beyond that), and **7 d reachable in the active feed by permalink**; after 7 d
> the event leaves the active set and is served from the archive. Leaving the active set
> never affects resolvability — I1 is unconditional and a permalink answers 200 forever.
> **Implementation constraint (ties to ADR-003 / review 14 M1):** both boundaries are
> **status transitions written by the lifecycle tick job**, which bump the global `seq`;
> they are *never* wall-clock filters applied at snapshot-build time, otherwise the last
> event of the season would linger in client stores indefinitely. This rule was resolved
> in 00-summary T8 but was, until this amendment, recorded in no normative document.

## Decision 7 — Reprocessing and replay discipline

> **Amendment A1.4 (2026-08 · review 13 §3.3(15), C7; procedure per 03 §5.3 + §5.2.5)
> — D7's first bullet is rewritten.** It previously read: *"SP rows land in a staging
> partition, `detection_uid` alignment is verified, the partition is swapped."* That
> check is **impossible by construction**: SP reprocessing shifts coordinates and
> lat/lon are inside the hash, and rows appear and disappear between tiers, so NRT and
> SP uids for "the same" observation generally differ and cannot be aligned row-level.
> Review 03 explicitly forbids row-level NRT↔SP matching (R1; §4 recommendation 1
> "never attempt row-level NRT↔SP matching — swap whole month-partitions"; §5.1.1
> pitfall 6). The replacement procedure is below; the "identity is not re-derived"
> guarantee is refined, not dropped, in step 6.

**NRT→SP promotion — the normative procedure** (whole-month, never row-level):

1. **Stage.** SP rows for month `M` load into a staging partition beside the live NRT
   partition. `detection_uid` is computed for SP rows by the same canonical serializer
   as NRT, but **no attempt is made to align SP uids with NRT uids** — they are
   separate observations in the archive, not two versions of one row.
2. **Sanity checks (count + coverage), all fail-closed.** Before any swap: SP row count
   versus the NRT count for `M`; per-source and per-day coverage (no day non-empty in
   NRT may be empty in SP); every `acq_ts` inside `M`; all geometry inside the polling
   bbox; uid uniqueness within the staged partition. The numeric bands live in
   config-as-data (Decision 5) and are fitted on the first two observed real swaps;
   until they are fitted the swap is operator-confirmed. **Any failed check aborts the
   swap and leaves the NRT partition live** — a missing month of SP is a nuisance, a
   half-swapped month is a corrupted archive.
3. **Swap.** Detach the NRT partition and attach the SP partition in one transaction.
   The detached NRT partition is **retained** (append-only archive discipline: nothing
   is deleted — it is the evidence for every alert sent from it).
4. **Re-cluster, scoped to that month only.** An offline clustering run covers `M`
   extended by `T_LINK` on both edges (so events crossing a month boundary are
   clustered consistently), reading — never rewriting — detections outside `M`. The run
   writes to `clustering_runs` + `event_detections.clustering_run_id` and **never
   overwrites the live assignment** (03 §5.2.5).
5. **ID-preserving promotion (03 §5.2.5).** Promoting the run to live matches each new
   cluster to existing events by **detection-set Jaccard overlap ≥ 0.5 → the old
   `public_id` is kept**. Unmatched new clusters get fresh ids; unmatched old events are
   retired but keep resolving (I1) — with `mergedInto` where the SP evidence folded them
   into a survivor, otherwise archived with reason `superseded_by_sp`; never deleted,
   never re-used. Matching is deterministic: greedy in descending Jaccard, each old
   event claimable at most once, ties broken by **oldest event** then lowest internal id.
   Without this mechanic a shadow diff is a wall of renumbered ids and cannot be
   reviewed — the promotion PR carries an event-level diff (kept / new / retired /
   merged counts plus the permalink-resolution delta) as its evidence.
6. **What identity guarantees survive.** Identity is still **never re-derived in the
   online path**: no ingest, poll, or aggregate recompute may retroactively merge events,
   and SP corrections adjust geometry and score, not history. Identity changes only
   through the reviewed offline promotion in step 5, under the Jaccard rule, and that run
   emits **zero alerts** (I4) and requires `--allow-revive` to revive an archived event.
   Event aggregates (hull, max FRP, `detection_count`, `started_at`) are recomputed from
   the promoted assignment in the same transaction.

Unchanged by this amendment:

- **Reprocessing and backfill runs never emit alerts.** Reviving an archived event in
  any offline run requires an explicit `--allow-revive` flag (I4).
- The whole pipeline is **deterministic**: virtual clock injected as a port; batch
  ordering fixed as `(available_at, source, lat, lon)`; no RNG anywhere in
  identity/scoring paths. Same fixtures → byte-identical event registry, twice in CI
  (06 §5.2).

## Invariants (testable, permanent)

- **I1 — Permanent resolution:** every `public_id` ever issued resolves forever (live,
  archived, or tombstone with `mergedInto`); never 404, never re-used.
- **I2 — Alias convergence:** merge alias chains are acyclic and path-compressed;
  resolution is O(1) amortized and total.
- **I3 — Atomic merge:** detection re-attribution, aggregate recompute, tombstone
  write, and `migrateAlertState` commit in one transaction; a merge can never cause a
  "new fire" alert for a zone already notified about any parent.
- **I4 — Replay silence:** reprocessing/backfill emits zero alerts; revival requires
  `--allow-revive`.
- **I5 — Determinism:** identical input fixtures produce byte-identical registry state
  under the fixed ordering and virtual clock.

## Acceptance criteria

ADR-002 is *implemented* when the golden-replay suite (06 §5.2) passes:

1. Fixture format: `manifest.json`, `firms/*.csv` (original columns),
   `availability.json` (models NRT lag), `effis/ba-perimeters.geojson`,
   `open-meteo/*.json`, `zones.json`, `expected.json` asserting **outcomes** (event
   count, lifecycle sequences, merge structure, alert decisions) — not internals.
   `expected.json` lifecycle names use the Decision 6 states (the `"out"` naming in
   06's illustrative example is superseded by 12 §4.3).

   > **Amendment A1.5 (2026-08 · review 13 §3.3(15)) — GEO-only expectations are
   > superseded.** Review 11 §9.4 (and its §3 worked examples) describe a **GEO-only
   > cluster/event** scored into the Unverified bucket, echoing 03's earlier
   > `unconfirmed` GEO policy. Under Decision 2 a GEO-only cluster **never becomes an
   > event** (events require at least one fine-source detection, and coarse sources are
   > attach-only), so a GEO-only event row cannot exist and no `expected.json` may assert
   > one — those assertions would be permanently unreachable. **ADR-002 D2 wins.** The
   > 11 §9.4 GEO-only example survives only as a *scoring unit-test vector* at function
   > level (score the feature bundle, assert the bucket), never as an event-level fixture
   > expectation; the same applies to any GEO-only alert or map-visibility assertion.
   > Where 11 §9.4 uses `"out"` (S7), the Decision 6 names apply as above. Revisit at
   > GATE-v2 if FCI operational maturity justifies GEO-created events.

2. Scenarios **S1–S6 minimum** before first ingest code merges to main: S1 Slavyanka
   border-crossing (cross-border cluster, one event), S2 Sakar/Harmanli merge
   (permalink survives), S3 agri-burn FP (never Confirmed, no alert), S4 industrial
   static source (never an event), S5 single-detection noise (Unverified, no alert),
   S6 megafire cooling + reignition (fuel-window relation, no false
   `no_longer_detected`). S7–S9 (cloudy gap, source outage, UTC/DST) before season.

   > **Amendment A2.4 (2026-08 · review 14 H1, H2, §5) — two lifecycle fixtures added,
   > one noted as foreign-owned.** Both new scenarios join S7–S9 in the pre-season set
   > (they exercise lifecycle, which lands in WP2/WP3, not first ingest):
   >
   > - **S11 — a source is retired mid-replay** (MODIS, at a pinned instant inside the
   >   scenario). Assert: **E keeps accumulating from the remaining sources**; the
   >   retired source contributes no expected overpasses and no miss weight after its
   >   effective date and no freeze; the event still reaches `no_longer_detected`
   >   (the lifecycle progresses — this is the H1 deadlock regression test); a replay of
   >   the pre-retirement window reproduces the old constellation byte-identically (I5).
   > - **S12 — re-detection within T_LINK after `officially_extinguished`.** Assert:
   >   return to `active`; the official statement preserved in history with attribution;
   >   the dual-fact copy rendered; alert type **`escalation`, never `new_fire`**, and no
   >   re-"new" for any zone already notified (I3 semantics hold).
   > - **S16 — fire straddling the polling-bbox edge** is **owned by DATA-SOURCES' bbox
   >   rule** (bbox ⊇ alertable area buffered ≥ 2·ε_max + max zone radius, review 14 M2),
   >   not by this ADR — but it *replays through this suite*: assert one event, correct
   >   geometry, no bbox-induced split and no bbox-induced miss in the E-accumulator.
   >   Recorded here so the replay owner is unambiguous.
3. Double-run byte-identical diff in CI (I5).
4. Permalink property test (I1/I2) and merge-alert property test (I3).
5. Zero single-low-confidence alerts across all fixtures (shared invariant with
   ADR-004).

## Consequences

- Ingestion code is unblocked: `detections` schema (with footprint reserve), the
  incremental loop, and the event registry can be built directly from this document.
- The working set (clusters) is rebuildable, so bugs in clustering are recoverable by
  replay — only `fire_events` identity rows are truly precious.
- Attach-only GEO means FCI latency benefits show up as *corroboration speed* (score,
  freshness), not as event creation — accepted trade-off; revisit at GATE-v2 with FCI
  operational maturity.
- No automatic splits means a rare chimera event can persist until curated — accepted;
  the 20 km flag bounds the damage window.
- Every parameter change is a PR with shadow-mode evidence; slower iteration, but alert
  behavior can never drift silently (ties into 06 §5.7 release regime).

## Appendix A — Boundary and tie rules (`clustering_params_v1`)

> **Amendment A2.5 (2026-08 · review 14 M5).** These pins are part of the versioned
> clustering config spec of Decision 5 (same PR + shadow-diff regime, version recorded on
> every event and alert row) and are **asserted by the existing double-run byte-diff CI
> check** (I5, acceptance criterion 3). Each is individually trivial; each is
> replay-breaking if left to the implementer.

1. **Coarse/GEO attach-nearest, equidistant candidates → lowest cluster id.** A GEO or
   other coarse detection attaches to the nearest candidate cluster only (D2). When two
   or more candidates are exactly equidistant under the fixed distance computation, the
   detection attaches to the candidate with the **lowest internal cluster id** — never
   insertion order, never `public_id`, never "first found".
2. **`possible_reignition` parent selection → nearest centroid, then oldest.** When
   several old events lie inside the applicable window and 2×ε, the relation points at
   the event whose **centroid is nearest** to the new cluster's first detection; ties are
   broken by the **oldest event** (`started_at`), then lowest internal id. Exactly one
   `related_event_id` is written.
3. **All window comparisons are inclusive (`≤` / `≥`).** A quantity exactly equal to a
   bound is *inside* it: `Δt ≤ T_LINK`, `Δt ≤ 72 h` (active window), `Δt ≤ W_fuel`
   (reignition windows), `d ≤ ε` and `d ≤ 2·ε` (spatial), and likewise for
   minimum-duration and threshold conditions: `Δt ≥ 24 h` since last detection,
   `Δt ≥ 14 d` unobservable fallback, `E ≥ 3.0` / `E ≥ 5.0`, Jaccard `≥ 0.5`. There is no
   exclusive comparison anywhere in the identity or lifecycle paths.
4. **MODIS ε with missing or zero footprint → nadir 1.0 × 2.0 km, never NaN.** When
   `scan_km` or `track_km` is missing, null, non-finite or `≤ 0`, E1 CSV validation
   substitutes the **nadir footprint 1.0 km (scan) × 2.0 km (track)** *before* ε is
   computed, so `ε = max(3, 1.5·√(1.0·2.0)) = 3 km`; a NaN must never reach the
   clustering loop. The substitution sets `footprint_defaulted = true` on the row and is
   counted per batch, so a source silently dropping the columns is visible rather than
   silently re-shaping ε.
5. **Reignition window for unclassified or mixed fuel → 14 d.** When `land_cover_class`
   is null/`unclassified`, or no class holds a ≥ 50% majority under the hull, the
   **middle band (14 d)** applies — never the 7 d or the 21–30 d band. The fuel bands
   themselves (D2) are unchanged.

## Amendment log

| # | Date | Source | Lands in | What |
|---|---|---|---|---|
| A1.1 | 2026-08 | 13 §3.3(15), C7 | D1.1 | Dedup is `DO NOTHING`; 02 §5.3/§5.11 refinement semantics superseded |
| A1.2 | 2026-08 | 13 §3.3(15), 09 §2.2.F | D1.1 | ODbL: no OSM element IDs in fire-event records |
| A1.3 | 2026-08 | 13 §3.3(15), 00-summary T8 | D6 | Display window: 48 h map / 7 d permalink, as status transitions |
| A1.4 | 2026-08 | 13 §3.3(15), 03 §5.3/§5.2.5 | D7 | NRT→SP rewritten: stage → sanity → swap → month-scoped re-cluster → Jaccard ≥ 0.5 promotion |
| A1.5 | 2026-08 | 13 §3.3(15), 11 §9.4 | Acceptance 1 | GEO-only event expectations superseded by D2 |
| A2.1 | 2026-08 | 14 §3 minors | D1.3 | `fw-<year>` is mint-year cosmetic, never corrected |
| A2.2 | 2026-08 | 14 H2 | D6 diagram | `officially_*` re-detection within T_LINK → `active`, escalation not `new_fire` |
| A2.3 | 2026-08 | 14 H1 | D6 | Per-source E freeze; `retired` sources leave the overpass set; 14 d unobservable fallback |
| A2.4 | 2026-08 | 14 H1/H2/§5 | Acceptance 2 | Fixtures S11, S12; S16 noted as DATA-SOURCES-owned but replayed here |
| A2.5 | 2026-08 | 14 M5 | Appendix A | Boundary and tie rules pinned in `clustering_params_v1` |
