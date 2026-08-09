# ADR-005: Frontend stack — Preact + signals, framework-free core

*Date: 2026-07-30. Status: accepted (pre-code).*

Inputs: review 08 (frontend/PWA, primary), 07 (product/UX constraints the stack must
serve), ADR-003 (the reconciler/supervisor this code hosts). Closes 08 Q1 (framework
sign-off) and replaces the "React" placeholder in ANALYSIS.md.

## Context

- The frontend is a map-first PWA that must work on a **€150 Android on rural 3G/4G**
  during a fire: performance budget is a product requirement, not an optimization
  (map-ready ≤6 s on 4G / ≤15 s on 3G; critical path ≤350 KB gz).
- The heavy, irreplaceable dependency is **MapLibre GL** (~251 KB gz pinned) — the UI
  framework is the *residual* budget decision. React (~45 KB) + ecosystem habits
  (state libs, re-render-driven map updates) is where similar products lose their
  budget; the map itself never needs a VDOM.
- The long-lived state (event store, reconciler, transport supervisor, map controller)
  outlives any component tree and must be property-testable headlessly (ADR-003).

## Decision 1 — The core is framework-free by construction

`web/src/core/` (event store, feed adapters/reconciler, transport supervisor,
contracts) plus `web/src/map/` (MapLibre controller, layer registry) are **plain
TypeScript with zero framework imports**. The UI framework only renders panels/chrome.

- Enforced by **dependency-cruiser** rules in CI: `core` imports nothing from other
  app layers and never imports `maplibre-gl` or `preact`; `map` never imports `preact`;
  only `ui/` may.
- The map subscribes to the store **directly** (store → map controller callback),
  never through a framework render cycle — a 1,000-event `setData()` must not pay VDOM
  costs (throttled 1/s + rAF per 08 §5.3).
- Consequence: the framework choice below is a **two-way door** — swapping UI
  frameworks later touches `ui/` only.

## Decision 2 — UI framework: Preact + @preact/signals

- **Preact ~4 KB + signals ~2 KB gz** vs React ~45 KB: the entry budget (≤85 KB gz
  incl. boot, i18n, store) fits with room only this way.
- Signals map 1:1 onto the store's subscription model (fine-grained updates for the
  event list/detail panels without memo bookkeeping).
- **No `preact/compat` by default** (keeps React-ecosystem deps out of the bundle and
  the habit loop); compat is the documented escape hatch if a specific dependency ever
  justifies it.
- Routing: `preact-iso` (or `wouter-preact` if nesting demands) — file-size-class
  routing only. Map viewport state lives in the URL hash (`#map=z/lat/lon`) separate
  from the route; `/event/:id` handles `status:'merged'` payloads with a
  `replaceState` redirect to the canonical id (ADR-002 I1 on the client).

Rejected: **React** (budget + no benefit for this UI), **Svelte/Solid** (fine
technically; smaller ecosystems for our PWA/push/i18n needs and no team familiarity
edge over Preact's React-shaped API), **no-framework DOM** (the panels/forms/dialogs
are exactly what a small framework does better than hand-rolled DOM).

## Decision 3 — Build, types, contracts

- **Vite 8 (Rolldown)**, version pinned exact; TS `strict` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`.
- The frontend consumes **`@fire-watch/contracts` TypeBox schemas directly** via
  `Static<>` — no OpenAPI codegen step (OpenAPI is generated server-side as B2B docs
  only, v2). Client runtime validation = cheap structural guards at the transport
  boundary only.
- Performance budgets are **CI-enforced** (Lighthouse CI `budgets.json` per PR): entry
  ≤85 KB gz, map chunk ≤290 KB gz, critical path ≤350 KB gz, CSS ≤20 KB; UI fonts =
  system stack (0 bytes; map glyphs are self-hosted PBF per ADR-001 amendment).
  v1 telemetry: self-hosted `web-vitals` beacon, no third-party analytics (ePrivacy:
  keeps the no-cookie-banner architecture, 09 §4).

## Decision 4 — Scope confirmations (details owned by review 08)

The following review-08 designs are confirmed as the implementation baseline without
restating them: PWA cache tiers + SW update flow (§5.4), iOS Home-Screen push flow +
Telegram parity (§5.4.4), degraded-state single-banner priority (§5.6), typed-i18n
`Messages` modules `bg`/`en` with `Intl.*` only (§5.8), MapLibre patterns — promoteId
feature-state spike F-6, `transformStyle` restyling, zoom ladder, lite mode (§5.3),
fire-owns-red CI lint + CVD checks (06 §5.4).

## Consequences

- A second renderer (e.g. a future native shell or B2B embed) reuses `core/` + `map/`
  unchanged — the expensive logic is framework-independent forever.
- Preact's React-shaped API keeps onboarding cost near zero while the compat-free rule
  keeps the ecosystem door consciously guarded.
- Budgets in CI mean a dependency that blows 85 KB fails the PR — friction by design.
- Week-1 spikes carried from 08: F-6 (promoteId + feature-state on our UUID ids) and
  F-4 (`transformStyle` idempotence with `LayerRegistry.apply()`); plan B documented
  (numeric alias map) if F-6 fails.
