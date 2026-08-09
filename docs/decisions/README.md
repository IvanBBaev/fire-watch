# Architecture Decision Records

All ADRs were written pre-code (July 2026) from the twelve-review design corpus in
[`../reviews/`](../reviews/00-summary.md). Each ADR names its input reviews and is the
authoritative distillation: **where an ADR and a review conflict, the ADR wins.**
Amendments are appended to the original file and win over the original text; those
recorded below come from the second-round audit
([13](../reviews/13-second-round-audit.md)) and the corner-case register
([14](../reviews/14-corner-cases.md)) — each amendment names its source review.

| ADR | Title | Date | Status |
|---|---|---|---|
| [001](001-map-stack.md) | Map stack — MapLibre GL JS + self-hosted tiles | 2026-07-21 | Accepted; Amendments A1 2026-07-30, A2 2026-08-02 (review 14 §3) |
| [002](002-fireevent-identity-and-clustering.md) | FireEvent identity & incremental clustering | 2026-07-30 | Accepted; Amendments A1, A2 — 2026-08 (reviews 13 §3.3(15), 14 H1/H2/M5) |
| [003](003-read-path-tiers.md) | Read path — snapshot-first tiers, SSE as enhancement | 2026-07-30 | Accepted; Amendment A1 2026-08-02 (reviews 13 §3.5(25), 14 M1) |
| [004](004-alert-pipeline.md) | Alert pipeline — outbox, gateway, state machine, fail-closed budgets | 2026-07-30 | Accepted; Amendment A1 2026-08-02 (reviews 13 §3.5(22)/C5, 14 H4/M3/M4) |
| [005](005-frontend-stack.md) | Frontend stack — Preact + signals, framework-free core | 2026-07-30 | Accepted |

One-line summaries:

- **001** — MapLibre GL JS as the only rendering stack; self-hosted exploded z/x/y
  vector tiles + glyphs on R2 from MVP (A1.1); EFFIS overlays always proxied with
  serve-stale-on-error (A1.2); satellite imagery only via metered ArcGIS Location
  Platform, EOX dropped for its NC licence (A1.3); attribution as config-in-git with
  a CI presence test (A1.4). Amendment A2 pins three cases A1 left open: glyph ranges
  derived from the shipped tile extract, not Cyrillic alone (A2.1); a content-sanity
  check before an EFFIS 200 may be cached as good (A2.2); the ArcGIS quota cliff
  degrading server-side to "no toggle" via `/api/client-config` (A2.3).
- **002** — Three-layer model: immutable Detections → ephemeral Clusters → permanent
  FireEvents (`fw-<year>-<base32>`); attach-only GEO; deterministic merges with
  tombstones + in-transaction alert-state migration; no automatic splits; all
  parameters versioned config-as-data fitted on the 2020–2025 backfill; permanent
  invariants I1–I5 and the golden-replay acceptance suite. Amendment A1 adjudicates
  dedup as an intentional no-op, bars OSM element ids from event records (ODbL),
  records the 48 h map / 7 d permalink display window as status transitions and
  rewrites the NRT→SP swap as stage → sanity → partition swap → re-cluster
  (A1.1–A1.5); A2 freezes the E-accumulator per source with `retired` sources leaving
  the overpass set and a 14 d unobservable fallback, returns `officially_*` events to
  `active` on re-detection within T_LINK (as an `escalation`, never `new_fire`), pins
  `fw-<year>` as mint-year cosmetic, and adds fixtures S11/S12 plus the
  boundary-and-tie appendix (A2.1–A2.5).
- **003** — CDN-cached snapshot polling is the product (T1), SSE a capped opt-in
  enhancement (T0), R2 static snapshot the automatic fallback (T2); staleness is
  first-class in every payload; the five-rule client reconciler contract is
  property-tested; merged ids return 200 + `mergedInto`. Amendment A1 pins the numeric
  T0→T1 demotion triggers as L-2 pass criteria, the client-side T2 flip against a
  second R2 hostname, the `/api/v1` + RFC 7807 + rate-limit/CORS conventions,
  invariant R1 (every set-membership change is a `seq`-bumping status transition), the
  cursor variant as non-authoritative with a ≤10 min full-snapshot obligation, and
  server-time-offset staleness math (A1.1–A1.6).
- **004** — Transactional outbox with mandatory provenance; one notification gateway
  is the only sender (lint-enforced); per-(zone, event) state machine; score-gated
  alerting with zero single-low-confidence alerts; budgets, anomaly breaker, kill
  switch; the never-send list enforced as a CI template lint; GDPR posture fixed
  (Art. 6(1)(b), zone coordinates Art-9-grade in practice, erasure ≤30 d). Amendment
  A1 adds the `manual` trigger type with actor/approver provenance, priority
  (non-FIFO) dispatch, settled retention (24 months full, pseudonymized to 5 years),
  the T-approver solo fallback, an ingest-side breaker leg, reignition as
  `escalation`, the system gate vs per-zone sensitivity split with a 22:00–07:00
  quiet-hours default, zone creation seeding state without a send, erasure cancelling
  pending outbox rows, a 2 km minimum zone radius, escalation hysteresis and a
  deterministic B-budget cutoff (A1.1–A1.12).
- **005** — `core/` and `map/` are framework-free by construction
  (dependency-cruiser-enforced); Preact + signals only in `ui/`; Vite 8; CI-enforced
  bundle budgets (entry ≤85 / map ≤290 / critical ≤350 / CSS ≤20 KB gz); contracts
  consumed directly as TypeBox `Static<>`.

**Companion, not an ADR:** [`../OPERATIONS.md`](../OPERATIONS.md) is the normative
operations layer these ADRs assume — freshness budgets, the probe surface and
meta-alerting, SLOs and error budget, RTO/RPO and backups, upgrade triggers, secrets,
the host contract, the status page; it implements the ADRs above and never overrides
them.

## Conventions

- Format: Context → Decision(s) → Consequences; normative inputs cited as
  `review §section`.
- Status lifecycle: proposed → accepted → amended (`Amendment An` appended; the
  amendment wins) → superseded (the new ADR links back). Nothing is renumbered or
  deleted.
- Decisions made during implementation that change an ADR-level contract (schema
  partitioning details, deploy pipeline, the v2 B2B API surface) get new ADRs —
  they are not folded silently into code.
