# Review 08 — Frontend / Map PWA Architecture

*Reviewer role: senior frontend engineer (map-heavy PWAs, MapLibre GL JS). Date: 2026-07-22.
Status: complete.*
*Inputs reviewed: `docs/ANALYSIS.md`, `docs/decisions/001-map-stack.md`,
`docs/reviews/00-summary.md`, `docs/reviews/04-sre.md` (transport tiers, tile math),
`docs/reviews/02-backend.md` (SSE contract, API surface, contracts package). Project is
pre-code.*

---

## 1. Summary verdict

**GO, with one architectural rule that must be enforced from the first commit: the frontend
core (event store, feed adapters, map controller) is plain TypeScript with zero framework
imports; the UI framework only renders panels around it.** Get that boundary right and every
other frontend decision in this document becomes cheap and reversible — including the
framework itself.

The upstream decisions make the frontend job unusually tractable:

- **The read-path tiers (T1 snapshot / T0 SSE / T2 static) are a gift.** The backend's
  contract — "on `reset` or first connect, snapshot via `GET /events`, then apply the
  stream" (02-backend §5.7) — collapses the classic realtime-map double-source problem into
  a small, testable reconciler. The frontend must honor that contract literally and resist
  every temptation to treat SSE as a source of truth.
- **The 5–10 min data cadence means the UI is not actually "realtime".** No requirement for
  60 fps data churn, no need for per-feature diffing, no WebSocket machinery. A full
  `setData()` of a few hundred GeoJSON features once a minute is trivial for MapLibre.
- **Static hosting only is fully compatible** with the product's SEO/permalink needs, with
  one edge-side trick for social sharing (§5.1.6).

Top-line recommendations (detail in §5):

1. **[MVP] Framework: Preact + @preact/signals** (~6 KB gz total) with a framework-free
   core. React-shaped and boring, 40 KB lighter than React, without Svelte's compiler
   coupling or Solid's mental-model tax. The honest matrix is in §5.1; because of the
   core/UI boundary this is a low-stakes decision — deliberately so.
2. **[MVP] One `FireEventStore` keyed by event UUID, one `FeedSupervisor` state machine**
   owning transport selection and degradation (poll → SSE upgrade → static fallback). All
   reconciliation rules in §5.2 — this module is the crown jewel and gets property-based
   tests (fast-check) before it gets a UI.
3. **[MVP] MapLibre integration as an imperative controller** outside the framework tree:
   single GeoJSON source + throttled `setData`, feature-state for hover/selection,
   `transformStyle` for light/dark switching so runtime layers survive. Pitfalls inventory
   in §5.3 (UUID feature-state ids, glyph fontstacks for Cyrillic, hillshade-not-terrain on
   weak GPUs).
4. **[MVP] PWA with a hand-written (injectManifest) service worker** implementing three
   cache tiers that mirror the SRE ladder: precached shell, cache-first LRU tiles
   (~80 MB budget), network-first snapshot with stale fallback + the staleness banner as
   one shared mechanism. Web Push permission is asked only at watch-zone creation, never
   on load. **iOS verification result: Home Screen web apps and their Web Push remain
   fully supported in the EU** — the 2026 blog posts claiming otherwise recycle Apple's
   *reversed* Feb 2024 plan (Apple's own DMA page is unambiguous; §5.4.4).
5. **[MVP] Performance budget: ≤ 350 KB gz JS on the critical path** (MapLibre v6 is
   251 KB gz of it — verified), map-ready ≤ 6 s on a €150 Android over 4G, ≤ 15 s on 3G;
   panel shell interactive before the map chunk loads. Lighthouse CI budgets in the repo
   from commit 1; WebPageTest on a Moto-G-class device before each fire season.
6. **[MVP] Degraded states are designed screens, not error handlers** — a single
   source-health model drives one banner slot with strict priority; the user never sees
   "connection error", they see an honest timestamp. "Map fails open" is a frontend
   feature more than a backend one.

Everything here fits the €6–21/mo envelope: hosting is Cloudflare Pages/R2 static
(€0), no SSR server, no paid frontend SaaS.

---

## 2. Strengths in the upstream decisions (frontend perspective)

- **MapLibre GL JS (ADR-001) is the right call and needs no revisiting.** Data-driven
  styling covers the age/intensity encoding from the style spec alone; `feature-state`
  covers hover/selection without re-uploading data; the raster-dem hillshade covers the
  terrain-readability requirement without 3D terrain's GPU cost.
- **The seq-cursor design (02-backend §5.6) is exactly what a client reconciler wants.**
  A global monotonic `seq` on every event, carried in SSE frame ids AND in event
  properties, gives the client one integer to reason about for gap detection, idempotent
  replay, and stale-snapshot rejection. Most realtime maps never get this and pay for it
  with zombie markers.
- **The freshness foreign member on every FeatureCollection** means the staleness banner
  needs no separate endpoint on the happy path — the data payload carries its own honesty.
- **"Fire owns red/orange" (ADR-001 + QA G12)** is a strong constraint that makes the
  degraded-state design easier: system/status UI is structurally barred from panic colors.
- **`@fire-watch/contracts` (02-backend §5.1)** already plans for the web app importing
  the exact TypeBox schemas the server validates with — the single highest-leverage
  type-safety decision in the project. §5.9 confirms and extends it.
- **The T2 static snapshot on R2** means the frontend can be built so that *total origin
  death* degrades to a labeled, read-only map — a property almost no consumer map app has,
  available here nearly for free.

---

## 3. Risks & gaps (severity-ranked, frontend scope)

| # | Severity | Risk | Notes |
|---|---|---|---|
| F-1 | **High** | **Snapshot+SSE reconciliation bugs** — zombie events (SSE resurrects what a newer snapshot removed), duplicate render after replay, regression to older state when a CDN-stale snapshot lands after fresh deltas | The classic double-source failure family; §5.2 rules + property tests are the mitigation. This is the module where a bug costs user trust directly ("the fire disappeared / came back"). |
| F-2 | **High** | **iOS alert reach gap**: Web Push on iOS requires the app to be installed to the Home Screen first; users who never install get no push at all | Not a 2026 regression (EU support verified fine, §5.4.4) but an inherent iOS constraint. Mitigation: install-first UX for iOS + Telegram as the co-equal channel (already v1 scope). |
| F-3 | **Med-High** | **MapLibre bundle growth**: v6.0.0 is 251 KB gz (966 KB min) and the project has an open issue about unmonitored growth per release | Pin the version; adopt tree-shaken imports when stable; own bundle budget in CI so an upgrade can't silently eat the budget. §5.5. |
| F-4 | **Medium** | **Style switching (light/dark) silently dropping runtime layers/sources** — `setStyle()` resets everything not in the new style JSON | Use `transformStyle` + an idempotent LayerRegistry; §5.3.5. A known MapLibre footgun. |
| F-5 | **Medium** | **Service-worker staleness during an incident**: a cached app shell serving old code while a season hotfix sits undeployed on clients | SW update flow with user-visible "new version" affordance + max-age discipline on the SW file itself; §5.4.1. |
| F-6 | **Medium** | **Feature-state id pitfalls**: event ids are UUIDs; GeoJSON feature ids + `promoteId` string behavior must be verified on our MapLibre version or hover/selection breaks subtly | Cheap spike task; fallback design (numeric alias map) in §5.3.2. |
| F-7 | **Medium** | **Weak-GPU rendering**: hillshade + many symbols on €100–150 Android GPUs (Mali-G5x class) can drop the map below usable FPS | Lite-mode heuristic + hillshade-only (no `setTerrain`); §5.3.6. |
| F-8 | **Low-Med** | **Visual-regression flakiness** on a WebGL canvas (fonts, AA, driver variance) | Deterministic harness rules in §5.7.4; run on one pinned browser/OS in CI only. |
| F-9 | **Low-Med** | **Permalink SEO/social-preview gap** on pure static hosting (event pages are client-rendered) | Edge OG-tag injection at v1; Google renders JS fine; §5.1.6. |
| F-10 | **Low** | **Attribution non-compliance** as sources accumulate (OSM + OpenFreeMap/Protomaps + Terrarium + NASA + EUMETSAT/LSA SAF + EFFIS/EU) | One credits module as the single registry; §5.3.7. |

---

## 4. Recommendations (mapped to risks; tagged [MVP]/[v1]/[v2])

1. **(F-1) [MVP]** Implement `FireEventStore` + `FeedSupervisor` + reconciler as pure TS
   with the invariants in §5.2.4, and land the fast-check property suite in the same PR.
   No map code before this module is green.
2. **(F-2) [v1]** iOS enable-alerts flow: detect iOS-Safari-not-installed and walk the
   user through Add to Home Screen *before* requesting push permission; offer Telegram
   linking as the primary alternative in the same screen. Never dead-end an iOS user.
3. **(F-3) [MVP]** `budgets.json` + Lighthouse CI asserting total JS and per-chunk sizes;
   MapLibre version pinned exactly; upgrades go through a PR that shows the size delta.
4. **(F-4) [MVP]** All runtime layers/sources are added only through a `LayerRegistry`
   whose `apply(map)` is idempotent; style switching uses `setStyle(next, {transformStyle})`
   and re-runs the registry on `style.load` as a belt-and-braces.
5. **(F-5) [MVP]** SW registered with `updateViaCache: 'none'`; on `waiting` worker, show a
   toast "Updated version available — reload"; auto-activate after 24 h. During fire season
   this is the difference between a hotfix reaching users in minutes vs days.
6. **(F-6) [MVP]** Week-1 spike: verify string-UUID `promoteId` + `setFeatureState` on the
   pinned MapLibre version; if flaky, ship the numeric alias map from day one.
7. **(F-7) [MVP]** Lite mode: no hillshade, simplified halo/labels — auto-enabled by
   heuristic (`navigator.deviceMemory ≤ 2`, WebGL renderer string, first-frame timing),
   user-overridable in settings.
8. **(F-8) [v1]** Visual regression only on the two style variants + the four degraded
   states, single pinned environment, fixture data, animations off.
9. **(F-9) [v1]** Cloudflare Pages Function (or the already-budgeted Workers Paid) injects
   `og:title`/`og:description`/`og:image` into the cached shell for `/event/:id` from the
   edge-cached event JSON. Static hosting stays; no SSR framework enters the stack.
10. **(F-10) [MVP]** `credits.ts` is the single registry of every data/tile source with its
    required attribution string and URL; the map control, the About page, and the alert
    email footer all render from it.

---

## 5. Frontend deep dive

### 5.1 Framework decision

#### 5.1.1 What the framework is actually for here

MapLibre owns the canvas and its own render loop. The "app" around it is: a detail panel,
an event list, settings/zones screens, banners, routing, and the boot sequence. That is a
small-to-medium CRUD-ish surface with one unusual requirement: it must not be in the data
hot path. Detections → store → map goes **store → map controller directly** (a plain
subscription), never store → framework render → map. Once that rule is set, the framework
question is: what renders panels most maintainably for one senior TS developer on a
low-end-Android budget, for the next 5+ years, with static hosting.

#### 5.1.2 The honest matrix

Sizes are min+gz for the runtime a hello-world ships, from current (2026) public data
([index.dev comparison](https://www.index.dev/skill-vs-skill/frontend-react-vs-preact-vs-solidjs),
framework docs; MapLibre from [Bundlephobia](https://bundlephobia.com/package/maplibre-gl)):

| Option | Runtime gz | Pros for this app | Cons for this app |
|---|---|---|---|
| Vanilla TS (+ lit for templating) | 0 (+~5 KB Lit) | Zero dependency risk; forces the framework-free core | Panels/forms/routing grow; hand-rolled reactivity becomes a private framework nobody else maintains; testing story thinner. Viable, but the discipline cost exceeds Preact's 6 KB |
| **Preact + signals** | **~4.6 + ~1.7 KB** | React-shaped (boring, stable, 10+ yrs, API churn near zero); signals give fine-grained panel updates straight off the store; `preact/compat` escape hatch if a React-only lib is ever truly needed | Slightly smaller ecosystem than React proper; devtools good but not React-grade |
| React 19 | ~45 KB | Largest ecosystem; "default" choice | Pays ~40 KB for features this app doesn't use (concurrent rendering, RSC ecosystem gravity pulls toward SSR frameworks we explicitly don't want) |
| Svelte 5 | ~2–6 KB | Smallest output; excellent DX | Compiler-coupled: the 4→5 runes migration showed real churn cost for a solo maintainer; SvelteKit's gravity (its router/SSR/adapters) is machinery we'd fight, and using Svelte without Kit is a less-trodden path |
| Solid | ~7.5 KB | Best raw reactivity perf | Perf headroom we don't need (panels are cheap); subtler mental model (no re-render; JSX that isn't React) raises long-term "future me" maintenance risk for no payoff here |

#### 5.1.3 Recommendation

**[MVP] Preact + @preact/signals, no compat layer by default.** Reasons, in order:

1. **Bundle**: ~6 KB vs React's ~45 KB. Next to MapLibre's 251 KB the *relative* saving is
   modest, but on rural 3G (~1.6 Mbit/s effective) 40 KB is ~2 s of transfer — and the
   framework is in the *first* chunk (panel shell), which we want interactive before the
   map chunk arrives (§5.5.2). The first chunk is where small matters most.
2. **Longevity/boredom**: Preact has held a stable React-shaped API for a decade; the
   knowledge is transferable in both directions. For a solo maintainer, API churn is a
   bigger tax than ecosystem size.
3. **Signals fit the architecture**: panels subscribe to store-derived signals; no
   re-render storms, no memoization ceremony, and the mental model matches the "one store,
   many small views" shape of this app.
4. **We are not using the map-wrapper ecosystem anyway** (no react-map-gl — wrappers fight
   the imperative controller pattern and lag MapLibre releases), which removes the main
   reason people pick React for map apps.

**Fallback stance:** because the core is framework-free, swapping Preact for React (or
anything) later touches only `ui/`. If a genuinely needed dependency demands React,
`preact/compat` covers most cases at +2 KB. This is a two-way door by construction.

ANALYSIS.md §5 says "React/Vite" in the architecture sketch — treat that as a placeholder
(same family, same Vite toolchain); this review formalizes the choice as Preact. Record it
in a short ADR-005 (frontend stack) alongside the transport ADR so it's decided once.

#### 5.1.4 Routing

**[MVP]** Client-side routing needs are tiny: `/`, `/event/:id`, `/settings`, `/zones`
(v1), `/about`, `/credits`. Use `preact-iso`'s router or `wouter-preact` (~2 KB) — not a
data-router framework. Deep links must encode map state in the URL hash
(`#map=7.2/42.7/25.3` Mapbox-style) *separately* from the route path, so `/event/:id`
plus hash restores both selection and camera. The event permalink must survive event
merges: on load, if the API returns `status: 'merged'` with `mergedInto`, the app
redirects (`replaceState`) to the canonical id — the backend guarantees merged ids keep
resolving (02-backend §5.6).

#### 5.1.5 Static hosting

**[MVP]** Cloudflare Pages (or R2 + CDN) for the shell — consistent with SRE §5.2.1
("App shell (PWA): Cloudflare Pages or R2; free, effectively infinite scale"). No SSR
server exists in this architecture, period. All environment differences (API origin, R2
snapshot fallback URL, tile origins) are baked at build time into a small `config.ts` —
the T2 fallback hostname *must* be in the shell (SRE §5.2.3), not fetched.

#### 5.1.6 SEO & social previews without SSR

Three consumer classes, three answers:

- **Google/Bing crawlers** execute JS: the client-rendered event page with proper
  `<title>`/meta set via the router is indexed. Fire events are ephemeral; organic search
  is not the growth channel — social sharing during incidents is.
- **[MVP] Static prerender for the static pages**: `/`, `/about`, `/credits` prerendered
  at build (vite-plugin or a 20-line script that renders the shell with meta) — costs
  nothing, covers the "site looks real" baseline.
- **[v1] Edge OG injection for `/event/:id`**: Facebook/Telegram/Twitter scrapers do *not*
  run JS. A Pages Function reads the edge-cached event JSON and string-replaces the OG
  block in the cached shell (`og:title: "Fire near Karlovo — active, 14 detections"`,
  `og:image` from a pre-rendered static map thumbnail endpoint [v2]). ~50 lines, no SSR
  framework, and it is the single highest-leverage growth feature in this list: shared
  links during a fire *are* the marketing.

### 5.2 State architecture: snapshot + SSE without double-source bugs

#### 5.2.1 Module breakdown (ports & adapters, client side)

```
web/src/
├── core/                     # ZERO framework imports; zero maplibre imports
│   ├── store/
│   │   ├── event-store.ts    # Map<uuid, FireEvent>; maxSeq; derived indexes (by status, bbox)
│   │   ├── reconciler.ts     # applySnapshot(), applyDelta(), applyReset() — pure functions
│   │   ├── freshness.ts      # source-health model; staleness computation (mirrors server)
│   │   └── selection.ts      # selected/hovered event id (UI state that map+panels share)
│   ├── feed/
│   │   ├── port.ts           # DataFeedPort interface (below)
│   │   ├── snapshot-poller.ts# T1: fetch /snapshot.json every 30–60 s (jittered)
│   │   ├── sse-feed.ts       # T0: EventSource wrapper, typed events, Last-Event-ID
│   │   ├── static-fallback.ts# T2: R2 snapshot URL, last-resort
│   │   └── supervisor.ts     # THE state machine: transport choice, degradation, wake/online
│   └── contracts/            # re-exports from @fire-watch/contracts (TypeBox Static types)
├── map/                      # maplibre only; imports core (read), never ui
│   ├── controller.ts         # owns the Map instance lifecycle
│   ├── layer-registry.ts     # idempotent apply() of all runtime sources/layers
│   ├── fire-layers.ts        # events source + circle/fill/symbol layer specs
│   ├── overlay-layers.ts     # EFFIS proxy raster layers, hillshade
│   ├── styles.ts             # light/dark style URLs + transformStyle logic
│   └── credits.ts            # attribution registry (also imported by ui/)
├── ui/                       # Preact; imports core signals + map controller API
│   ├── app.tsx, router …
│   ├── panels/  (event-detail, event-list, layers, settings, zones[v1])
│   ├── banners/ (source-health banner slot — §5.6)
│   └── push/    (permission flow, iOS install walkthrough [v1])
├── sw/service-worker.ts      # injectManifest source (§5.4)
└── boot.ts                   # composition root: store + supervisor + map + ui wiring
```

Import rules enforced with dependency-cruiser (same discipline as backend §5.1): `core`
imports nothing internal; `map` and `ui` import `core`; nothing imports `ui` except the
entrypoint; `core` never imports `maplibre-gl` or `preact`.

#### 5.2.2 The port

```ts
// core/feed/port.ts — illustrative
export interface FeedMessage {
  kind: 'snapshot' | 'delta' | 'reset' | 'freshness';
  snapshot?: EventsSnapshot;         // full FeatureCollection + freshness + maxSeq
  delta?: SseEventFrame;             // event.created|updated|status_changed|merged, seq
  freshness?: Freshness;
}
export interface DataFeedPort {
  start(cursor: { lastSeq: number | null }): void;
  stop(): void;
  onMessage(cb: (m: FeedMessage) => void): void;
  onStatus(cb: (s: 'connecting' | 'live' | 'degraded' | 'dead') => void): void;
}
```

`SnapshotPoller`, `SSEFeed`, `StaticFallback` implement it. The store never knows which
transport fed it — that is the whole point, and it is what makes the reconciler testable
with scripted interleavings.

#### 5.2.3 Transport supervisor state machine

```
BOOT ──snapshot ok──► POLLING (T1, default)
 │                      │  client-config offers SSE AND user on "live" tier?
 │ snapshot fails       ▼
 ▼                    SSE_CONNECTING ──open──► SSE_LIVE (T0; poller stopped,
STATIC_FALLBACK (T2)    │ error/503                     slow safety poll q10min)
 (R2 URL; keep           ▼                                │ error / event:degrade / reset-gap
  retrying T1 with      POLLING  ◄────────────────────────┘   (silent fallback; NO user-facing error)
  backoff + jitter)
```

Rules the supervisor owns (not the adapters, not the UI):

- **Boot:** always snapshot first (from SW cache if network is slow — §5.4.2), then maybe
  upgrade. The map renders from the first snapshot; SSE is never on the critical path.
- **SSE→polling is silent** (task constraint, and correct UX): the only user-visible
  signal anywhere is data age, never transport identity.
- **Tab wake** (`visibilitychange` → visible): if `now - lastAppliedAt > snapshotTTL`
  (60 s), fire an immediate snapshot fetch before resuming the regular cadence. SSE, if
  it survived the background throttle, is *also* re-validated: a snapshot refetch after
  wake is mandatory because background tabs miss ring-buffer windows (server keeps ~1,000
  frames; a phone asleep for an hour has no replay path).
- **`online` event / network regain:** same as tab wake. `offline`: stop timers, mark
  source-health `offline`, serve from store + SW cache.
- **Jitter:** poll interval 30–60 s uniformly jittered per client so a spike of clients
  doesn't phase-lock on the CDN TTL boundary.

#### 5.2.4 Reconciliation rules (the crown jewel)

State: `events: Map<uuid, FireEvent>`, `maxSeq: number`, `lastSnapshotAt: string`.
Every event carries its own `seq` (02-backend: bumped on every write of that event).

1. **Snapshot is the authority on the *set* of events; seq is the authority on each
   event's *version*.** On `applySnapshot(s)`:
   - For each feature `f`: upsert only if `f.seq >= events[f.id].seq` (a CDN-cached
     snapshot can be up to TTL older than deltas already applied — never regress a
     fresher event to a staler version).
   - Removal: an id present in store but absent from the snapshot is removed **only if**
     `s.maxSeq > events[id].seq` — i.e., the snapshot is provably newer than our last
     knowledge of that event. Otherwise keep it one cycle (it may be newly created via
     SSE and missing from the just-expired cached snapshot). Two consecutive authoritative
     absences ⇒ remove unconditionally. This single rule kills both zombie-resurrection
     *and* flicker-delete.
   - `maxSeq = max(maxSeq, s.maxSeq)`; `lastSnapshotAt = s.freshness.generatedAt`.
2. **Deltas apply per-event by seq:** `applyDelta(d)` upserts iff `d.seq > events[d.id].seq`
   (idempotent under SSE replay after reconnect — replayed frames are simply no-ops).
   `event.merged` writes the tombstone (`status:'merged', mergedInto`) — the renderer drops
   it, the router uses it for redirects; tombstones age out of the store after 24 h.
3. **Gap detection:** SSE frame ids are the global seq. If an incoming frame id `> maxSeq + 1`
   isn't explained by replay, OR the server sends `reset`, OR `EventSource` reconnects and
   the first frame implies a hole → supervisor forces a full snapshot fetch, *then* resumes
   applying buffered deltas (buffer while the snapshot is in flight; apply after, rule 2
   makes replays safe). Never try to be clever about partial gaps — the snapshot is cheap
   (tens of KB) and the cadence is minutes.
4. **Never delete on delta, never create on snapshot-miss:** deltas only upsert/tombstone;
   snapshots are the only remover (rule 1). One-way doors prevent the two sources from
   fighting.
5. **Clock discipline:** all staleness math uses server timestamps (`generatedAt`,
   `lastObservedAt`) against `Date.now()` with a tolerated skew; the banner says
   "data from 14:02" alongside "X min ago" so a wrong client clock can't lie alone.

These five rules, plus "store is the single writer to the map source", are the complete
defense against the classic bugs: zombie markers, duplicate events after reconnect,
stale-snapshot regression, delete-flicker, and background-tab time travel. §5.7.1 turns
each rule into a property test.

#### 5.2.5 UI state vs domain state

Selection, hovered id, open panel, layer toggles, locale → tiny signal atoms in `core`
(selection) or `ui` (purely presentational). Persisted user prefs (layers, lite mode,
locale) → `localStorage` behind a versioned `prefs.ts`. Watch zones and auth [v1] are
server state accessed through plain fetch hooks — no query library at MVP (two endpoints
don't justify TanStack Query; revisit at v1 when zones/auth arrive).

### 5.3 MapLibre integration patterns

#### 5.3.1 Data flow into the map

**One GeoJSON source `fire-events`, updated via `setData()`, throttled to at most 1/s and
coalesced through `requestAnimationFrame`.** At 10²–10³ features (ANALYSIS §5) full
replacement is microseconds of work; per-feature diffing (`updateData` partial updates)
is complexity with zero user-visible benefit at a 5–10 min data cadence. A second source
`fire-detections` (detail dots) is populated lazily only when zoom crosses the detection
threshold or an event panel opens (fetch `/events/:id/detections`).

#### 5.3.2 Feature-state for hover/selection

`feature-state` is the right mechanism (no data re-upload on hover). Requirement: stable
feature ids. Our ids are UUID strings; plan A is `promoteId: 'id'` on the source and
string ids through `setFeatureState`. **Verify on the pinned MapLibre version in week 1**
(F-6): string promoteId works for GeoJSON sources in current MapLibre, but this exact
path has a history of edge cases across versions (notably ids in `queryRenderedFeatures`
round-trips). Plan B (10 lines): store keeps `uuid ↔ smallint` alias map, features get
numeric ids. Hover styling via
`['case', ['boolean', ['feature-state', 'hover'], false], …]`; selection likewise, plus a
dedicated top "selected-ring" layer filtered by id for the emphasized outline.

#### 5.3.3 Zoom-dependent FireEvent rendering

| Zoom | Representation | Layer |
|---|---|---|
| z ≤ 7.5 | Dot: `circle-radius` interpolated from `maxFrpMw` (clamped), `circle-color` by status/age (new = hottest hue, cooling = desaturated), halo for `new` | `fire-dot` (circle) |
| 7.5 < z ≤ 11 | Event footprint: convex-hull polygon (`properties.hull` when backend ships it [v1]; centroid-dot fallback until then), fill 20–30 % + outline; dot persists as the anchor | `fire-hull` (fill+line) |
| z > 11 | Individual detections from `fire-detections`, sized by FRP, opacity by age; hull outline stays | `detection-dot` |

Transitions via `interpolate` on zoom for radius/opacity — no layer visibility popping.
Age encoding must also carry a **non-color channel** (QA CVD requirement): use shape/halo
(new = pulsing halo [respecting `prefers-reduced-motion`], cooling = hollow ring), not hue
alone.

Event labels (nearest settlement + status) as a symbol layer with
`symbol-sort-key: -maxFrpMw` so the biggest fire wins collisions, `text-variable-anchor`
so labels slide rather than vanish, and `text-optional: true` keeping the icon when text
collides.

#### 5.3.4 Cyrillic labels & glyphs

- Basemap labels: `text-field: ['coalesce', ['get', 'name:bg'], ['get', 'name']]` (ADR-001).
- **Glyphs are server-rendered PBF ranges** (fontstack protocol) — the style's `glyphs`
  URL must point at a fontstack that actually contains Cyrillic (Noto Sans covers it).
  Self-host the glyph ranges on R2 next to the tiles [MVP per SRE amendment — own tiles
  are Phase 1]; a session touching Bulgaria pulls only the ~2–3 ranges covering
  U+0400–U+04FF plus Latin — a few hundred KB, cached for a year (content-hashed path).
  Do not depend on a third-party glyph server: it is the same availability trap as
  third-party tiles.
- Collision behavior is script-agnostic in MapLibre (box-based), but Cyrillic labels for
  BG settlements average longer than their Latin twins — set `text-max-width` ~8 em and
  test label density over Rila/Pirin villages at z10–12 with real tiles, not lorem data.

#### 5.3.5 Light/dark style switching without losing runtime layers

`map.setStyle(url)` rebuilds the style tree and **drops every runtime source/layer**. Two
defenses, use both:

1. `setStyle(nextUrl, { transformStyle: (prev, next) => merge our sources/layers into next })`
   — supported in current MapLibre; keeps fire layers across the swap atomically.
2. `LayerRegistry.apply(map)` is idempotent (`addSource/addLayer` if absent) and re-runs on
   every `style.load` — covers any path that recreates the style (including error recovery).

Dark style is a **separate style JSON generated from the same source-of-truth style spec**
(a small build script emits both variants from one base + two palettes) — never runtime
paint mutation of a hundred layers. This also gives QA's style-lint two static artifacts
to check the fire-owns-red rule against (§5.7.4). Switch trigger: manual toggle +
`prefers-color-scheme` default. Overlay opacity (EFFIS raster) needs a per-variant value —
danger-class colors sit differently on dark.

#### 5.3.6 Terrain performance on weak GPUs

- **Hillshade ≠ terrain.** Use a `raster-dem` source (Terrarium) with a `hillshade` layer
  only. Do **not** call `setTerrain()` (3D mesh) at MVP — it doubles per-frame cost and
  memory on exactly the Mali/Adreno-budget GPUs our rural users hold, for zero product
  value on a top-down fire map. Revisit only with the [v2] satellite/inspection mode.
- Terrarium tiles cap at useful z≤12 for hillshade; set `maxzoom` on the DEM source so
  the GPU doesn't upsample garbage.
- **Lite mode** (F-7): heuristic on boot — `navigator.deviceMemory ≤ 2`, known-slow
  `WEBGL_debug_renderer_info` strings, or first-interaction frame time > 50 ms ⇒ disable
  hillshade, drop label density one notch, disable the pulsing-halo animation. Store the
  decision; expose the toggle in settings. The map must stay honest and readable at
  15 fps on a €100 phone — fire data first, shading second.
- All DEM/hillshade traffic goes through our proxy/R2 mirror (SRE §5.2.1: "don't send users
  direct in volume; be a good citizen").

#### 5.3.7 Attribution (legal requirement, not decoration)

Single registry (`map/credits.ts`), rendered three ways: compact `AttributionControl` on
the map (collapsible on mobile), full `/credits` page, alert-email footer. Required
entries:

| Source | Required text |
|---|---|
| Basemap data | `© OpenStreetMap contributors` (ODbL) — always |
| MVP tiles (while on public instance) | `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` — [their stated requirement](https://openfreemap.org/) |
| Own tiles (Phase 1 per SRE) | `Protomaps © OpenStreetMap` (or OpenMapTiles credit if that schema is kept) |
| Hillshade/DEM | Terrarium/Mapzen composite notice (USGS, EU-DEM et al.) on the credits page; `Terrain: Mapzen/AWS Terrain Tiles` short form |
| Hotspots | `Fire data: NASA FIRMS` (NASA requests acknowledgment; we cite prominently — it is also a trust signal) |
| Geostationary [v1] | `EUMETSAT / LSA SAF MTG FCI` per their terms (re-verify wording at integration, per ANALYSIS §6.4) |
| Danger/burnt areas | `© European Union, Copernicus Emergency Management Service (EFFIS)` |

OpenFreeMap terms re-verified 2026-07: free, no limits, no API key, no registration; no
SLA (which is why SRE moved own-tiles to Phase 1). Nothing in their terms blocks our MVP
usage.

### 5.4 PWA & offline strategy

#### 5.4.1 Service worker: three cache tiers (injectManifest, not generateSW)

`vite-plugin-pwa` in `injectManifest` mode — our caching logic is too tiered for config-only
generation; Workbox libraries (routing, strategies, expiration) inside a hand-written SW.

| Tier | Content | Strategy | Budget / TTL |
|---|---|---|---|
| Shell | hashed JS/CSS/HTML, manifest, sprite, core glyph ranges | Precache (Workbox manifest) | ~0.5 MB; new SW activates per F-5 flow |
| Tiles | basemap vector tiles, glyph PBFs, hillshade/DEM | Cache-first + `ExpirationPlugin` LRU | **Basemap+glyphs 60 MB, DEM/hillshade 20 MB** (~80 MB total, maxAge 30 d). Rationale: a Bulgaria-wide z0–z14 pyramid is a few GB (SRE) — never cache it all; 80 MB ≈ the user's home region + one trip, and stays far under iOS quota pressure. Content-hashed URLs make invalidation free on tile refresh |
| EFFIS overlay tiles | proxy raster tiles | Stale-while-revalidate, maxAge 30 min | small (≤ 10 MB); these change ~daily upstream, proxy TTL 10–15 min |
| Snapshot | `/snapshot.json` | **Network-first with 4 s timeout → cache fallback**, always re-cache on success | single entry; the fallback IS the offline map state |
| API detail | `/events/:id`, detections, weather | Network-first, 60 s cache fallback | small LRU (50 entries) |
| Never cached | SSE, auth [v1], push subscribe | Network-only | — |

The staleness banner mechanism is *shared* across all tiers: whatever fed the store
(network, SW cache, R2 static) the banner reads only `freshness.generatedAt` — "one
mechanism, three tiers" (SRE §5.2.3) extended into the client.

**[v2] Offline map packs** (hikers/firefighting volunteers): pre-download a region's tile
pyramid into a dedicated cache on demand. Note the interaction with PMTiles: single-file
+ HTTP Range means the SW must cache *ranges* — this is exactly why the SRE-recommended
exploded z/x/y tree on R2 is also the offline-friendly layout. Design the pack feature
against exploded tiles.

#### 5.4.2 Boot order for perceived speed

SW serves cached shell → panel skeleton + last cached snapshot render **before** the map
chunk finishes loading (list view first paint) → map chunk hydrates the canvas → live
snapshot replaces cache. On a cold cache over 3G the user sees the event *list* with real
(cached or fresh) data seconds before the basemap appears. The map is the hero, but the
list is the ambulance.

#### 5.4.3 Web Push (VAPID) — permission UX

- **Never prompt on load.** The permission ask happens exactly once, contextually: the
  user creates a watch zone / taps "Alert me about this fire" [v1]. Two-step soft prompt:
  our own explainer sheet ("You'll get a notification when a new detection appears within
  N km — typical delay is 15 min–3 h depending on satellites") → only on explicit accept
  do we call the browser prompt. A denial at browser level is near-irreversible UX-wise;
  the soft prompt absorbs the "no". Show the honest-latency copy *in the ask* — it is
  both ethics (ANALYSIS §6.4) and expectation management that reduces uninstalls.
- Subscription lifecycle: `pushsubscriptionchange` handler re-subscribes and re-posts;
  on `410 Gone`-pruned subscriptions (backend prunes), the app shows "your alerts stopped
  working — re-enable" on next visit (SRE §5.7). VAPID public key baked at build; private
  key never near the frontend (tier-0 secret).
- Payload discipline: pushes are small (event id + template key + distance); the
  notification click opens `/event/:id`. All content localized *at display time* in the
  SW (`notificationclick`/`push` handlers import the same i18n messages).

#### 5.4.4 iOS reality check (verified 2026-07, primary sources)

- **Web Push on iOS exists since 16.4 but only for Home Screen web apps** — a Safari tab
  can never subscribe ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- **EU status — verified against Apple directly:** Apple's DMA compliance page states,
  after the February 2024 back-and-forth: *"we will continue to offer the existing Home
  Screen web apps capability in the EU… built directly on WebKit"*
  ([developer.apple.com/support/dma-and-apps-in-the-eu](https://developer.apple.com/support/dma-and-apps-in-the-eu/)).
  Several 2026 SEO-blog guides (mobiloud, magicbell, webscraft) still claim "EU PWAs open
  in Safari tabs with no push" — that is the *reversed* plan reported as current; treat
  those sources as unreliable. Bulgarian iOS users get push, provided they install.
- **Declarative Web Push** (Safari/iOS 18.4+): push without SW wake-up, better delivery
  reliability ([WWDC25 session](https://developer.apple.com/videos/play/wwdc2025/235/)).
  [v1] Adopt it *additively* — the JSON payload format is designed to coexist with classic
  push; feature-detect and prefer it on supporting clients.
- **iOS 26** (current major): sites added to the Home Screen now open as web apps **by
  default**, which lowers the install-flow friction our alert reach depends on
  ([2026 iOS PWA guide](https://www.mobiloud.com/blog/progressive-web-apps-ios) — this
  specific claim matches WWDC25 materials).
- Consequence (F-2): the iOS enable-alerts flow is: detect standalone-mode
  (`display-mode: standalone`) → if in-tab, show the A2HS walkthrough (localized, with
  screenshots) → after install, ask permission inside the app. And always offer Telegram
  as the equal-rank channel — for iOS users in practice it is the *better* one.

#### 5.4.5 Add-to-home-screen strategy

- Android/Chrome: capture `beforeinstallprompt`, suppress the mini-infobar, surface our
  own "Install" affordance in two places: settings, and a *post-value* moment (user just
  viewed a fire or created a zone — never on first load).
- iOS: no event exists; the walkthrough sheet above, shown only on the alert flow or
  settings, never as a nag.
- The PWA manifest: `display: standalone`, `theme_color` per variant, maskable icons,
  `shortcuts` to "Fires near me" [v1]. Measure installs via `appinstalled` +
  `display-mode` media query in the RUM beacon.

### 5.5 Performance budgets

#### 5.5.1 The budget table [MVP — enforced in CI]

| Chunk | Contents | Budget (gz) |
|---|---|---|
| `entry` | Preact+signals, router, store+feed core, panel shell, i18n (active locale) | **≤ 85 KB** (framework ~6, app code target ~50–70) |
| `map` (lazy, prefetched immediately) | maplibre-gl, controller, layers | **≤ 290 KB** (MapLibre v6.0.0 = 251 KB gz min+gz, [Bundlephobia](https://bundlephobia.com/package/maplibre-gl); +codesize headroom ~40) |
| `settings`/`zones` [v1] | forms, push flow | ≤ 30 KB, lazy |
| `admin`/curation [v1] | separate route, lazy, ideally separate build | not on any user path |
| **Critical path total** | entry + map | **≤ 350 KB gz** |
| CSS | one file | ≤ 20 KB gz |
| Fonts (UI) | **system font stack — 0 bytes** (§5.8.3) | 0 |

MapLibre is 72 % of the critical path — which is exactly why the framework choice (6 vs
45 KB) is *secondary* and why the map chunk is split: the entry chunk renders a usable,
data-bearing event list at ~85 KB. Watch F-3: MapLibre has an open
[bundle-size monitoring issue](https://github.com/maplibre/maplibre-gl-js/issues/7255)
and v5→v6 kept growing; the "import just Map" tree-shaken path (~210 KB) is worth
adopting when it stabilizes, behind our own budget assertion either way.

#### 5.5.2 Target-device math

Reference device: €150-class Android (e.g. Redmi 13C / Galaxy A15: 4–8× Cortex-A5x,
Mali/PowerVR budget GPU) — this *is* the rural-BG install base. Networks: good 4G
(9 Mbit/s), rural 3G (1.6 Mbit/s, 300 ms RTT).

| Metric | 4G target | 3G target |
|---|---|---|
| First contentful paint (skeleton) | ≤ 1.8 s | ≤ 4 s |
| Event list interactive (entry chunk + snapshot) | ≤ 3 s | ≤ 8 s |
| **Map-ready** (basemap tiles + fire layer painted) | **≤ 6 s** | **≤ 15 s** |
| Repeat visit (SW warm) map-ready | ≤ 2.5 s | ≤ 4 s |

Transfer sanity: 350 KB gz ≈ 1.9 s at 1.6 Mbit/s pure transfer; parse/compile of ~1 MB
min JS on a budget SoC ≈ 1.5–3 s; tiles for one viewport ≈ 300–600 KB. The 3G cold
map-ready lives or dies on tile weight — another reason the own-tiles pipeline should
build a *lean* Balkans extract (drop POI/housenumber layers below z14 in the style).

#### 5.5.3 Measurement

- **[MVP] Lighthouse CI** in GitHub Actions on every PR: mobile emulation (moto-G-power
  preset, slow-4G throttle), `budgets.json` asserting the chunk table above + TTI; fails
  the PR on regression. This is the frontend twin of QA's style-lint gate.
- **[MVP] WebPageTest** (free tier) manual runs from an EU location on a real mid-range
  Android: at feature milestones and in the April pre-season fire drill (SRE App. B gets
  a line item: "WPT run on reference device, compare against budget table").
- **[v1] Micro-RUM, self-hosted:** `web-vitals` library → `navigator.sendBeacon` to our
  API (LCP/INP/CLS + map-ready custom mark + device class). No third-party analytics —
  consistent with the security review's third-party-minimization stance. A 30-line
  Fastify route and one Grafana panel.
- Custom marks: `performance.mark('fw:snapshot-applied')`, `'fw:map-idle'` — map-ready is
  *our* metric; Lighthouse can't see it.

### 5.6 Degraded & error states as first-class UI

Principle: **the user never debugs our infrastructure.** Every degraded state maps to one
calm, informative presentation; red/orange remain reserved for fire (QA G12 — this rule
applies to banners too: the offline banner is neutral gray/blue, *never* alarm-colored).

Single source-health model in the store feeds a **single banner slot** with strict
priority (one banner at a time; lower states are shown in the layers panel instead):

| Priority | State | Detection | UI |
|---|---|---|---|
| 1 | Device offline | `navigator.onLine` + fetch failures | "Offline — showing data from 14:02" + last-sync age; map keeps working from SW caches |
| 2 | Data stale (any tier) | `generatedAt` older than 2× cadence budget | "Satellite data is 27 min old" — neutral tone, with a "why?" popover explaining source cadence honestly |
| 3 | Origin down, T2 active | supervisor in STATIC_FALLBACK | Same staleness banner — the user learns the *age*, not the architecture. Optional link to status page (SRE §5.3.3) |
| 4 | Upstream source stale | per-source freshness from payload | No banner; a dot in the layers panel per source ("VIIRS: 4 h ago — normal; FCI: stale") — QA/SRE's "silence is suspicious" surfaced honestly but calmly |

Non-banner degradations:

- **SSE down → polling:** completely silent (supervisor, §5.2.3). Freshness is already
  minute-scale; the user cannot perceive the difference, so telling them would be noise.
- **EFFIS proxy down:** the layer toggle becomes disabled with tooltip "Fire danger layer
  temporarily unavailable (source: Copernicus EFFIS)"; if tiles were cached, show them
  with the layer's own "as of <date>" chip. Detection: N consecutive tile errors on that
  source (`map.on('error')` carries the source id).
- **Tile server down:** MapLibre keeps already-rendered/cached tiles; SW serves its 60 MB
  LRU for revisited areas. For never-cached areas: after N tile errors, `LayerRegistry`
  swaps to the **fallback style** — a 2 KB inline style (plain background color, country
  borders from a tiny embedded GeoJSON) that keeps fire layers, labels and interactions
  fully working. "Map fails open": worst case is fire dots on a beige canvas with an
  honest banner — still a useful product.
- **Snapshot 4xx/parse failure** (as opposed to network): treat as stale, keep last good
  state, report to Sentry — never clear the store on a bad payload (quarantine instinct,
  mirroring the backend's anomalous-batch guard).
- **WebGL unavailable/context-lost:** show the event *list* as the primary surface with a
  static "map unavailable on this device" note; `webglcontextlost` → `restore` handler
  re-runs LayerRegistry. The list-first boot order (§5.4.2) means this is a graceful
  subset, not a special mode.

Every state above is a Playwright fixture scenario (§5.7.3) and two visual-regression
shots (light/dark). Degraded states that aren't tested don't exist.

### 5.7 Testing strategy

#### 5.7.1 Unit — the reconciler gets property-based tests [MVP, before UI]

Vitest + **fast-check**. Model-based testing: a reference "perfect server" model generates
a ground-truth event timeline; generators produce arbitrary interleavings of:

- full snapshots taken at arbitrary (including stale-within-TTL) points,
- SSE delta subsequences with duplications (replay) and gaps,
- `reset` frames, reconnects, tab-sleep windows (no messages, then wake),
- offline/online transitions, T2 fallback payloads (older snapshots).

Invariants asserted (each maps to a §5.2.4 rule):

1. **Convergence:** after any interleaving ending with one fresh authoritative snapshot,
   store state equals server state exactly.
2. **No regression:** an event's rendered `seq` never decreases.
3. **No zombies:** an event removed by a newer snapshot never reappears except via a
   delta with strictly greater seq.
4. **Idempotence:** applying any delta (or snapshot) twice ≡ once.
5. **No flicker-delete:** an event created via SSE survives one stale-snapshot absence.

Plus example-based tests for the named scenarios: midnight-UTC day-range artifacts, merge
tombstone → redirect, wake-after-8h. Freshness math and the supervisor state machine get
plain unit tests (fake timers). This suite is the project's frontend crown jewel and runs
in milliseconds — a pre-commit hook, not just CI.

#### 5.7.2 Component

`@testing-library/preact` for panels: event detail renders FRP trend from fixture
detections, banner slot shows exactly one banner at right priority, push flow renders the
iOS walkthrough when `standalone` is false. Shallow and few — panels are thin by design;
don't test the framework.

#### 5.7.3 E2E — Playwright against fixture snapshot + mock SSE [MVP smoke, v1 full]

- Test harness: static file server with a **fixture `snapshot.json`** (drawn from the
  week-1 FIRMS backfill fixtures — same golden data QA uses) + a ~50-line Node **mock SSE
  server** that plays scripted frame sequences (created/updated/merged/reset/gap) with
  controllable timing. The app under test gets its API origin pointed at the harness via
  build config — no app-code test hooks.
- MVP smoke (mirrors QA §5.3): boot → map renders → event marker visible → click →
  panel shows detail → staleness banner appears when the harness serves an old
  `generatedAt`.
- v1 suite: the degraded-state matrix (§5.6) — kill snapshot mid-session → T2 URL served;
  SSE gap → silent snapshot refetch (assert via network log, *and* assert no error UI
  appeared); offline emulation → banner + cached tiles; SW update flow.
- Determinism rules for anything that screenshots the canvas: fixture data only, local
  tiles (tiny recorded tile set or the fallback style), `fadeDuration: 0`, animations off,
  `map.once('idle')` before assert, fonts self-hosted (already true).

#### 5.7.4 Visual regression + style-lint coordination

- Playwright `toHaveScreenshot` on: map default view light+dark, event selected
  light+dark, each banner state, panel on mobile viewport. One pinned browser (Chromium)
  on one pinned CI image; `maxDiffPixelRatio` tuned once. Run on PRs touching `map/` or
  styles; nightly otherwise (F-8: keep the flaky surface small).
- **QA's style-lint (fire-owns-red) needs lintable artifacts:** our style build (§5.3.5)
  emits `style.light.json` / `style.dark.json` as build outputs — the CI script checks
  every non-`fire-*` layer's paint colors against the forbidden hue range, and the CVD
  simulation runs on the fire palette. Frontend's obligation: stable layer-id prefixes
  (`fire-*` reserved) — put that in the LayerRegistry's contract and lint it.

#### 5.7.5 Web Push E2E feasibility — verdict: don't chase full E2E

Real push delivery E2E (browser → push service → SW → notification) is not automatable
cross-browser: headless Chromium can grant permission and expose a fake `PushManager`,
but the push-service leg (FCM/Mozilla/Apple) cannot be mocked end-to-end reliably, and
iOS not at all. Practical split:

- **Automated:** subscription *flow* test in Playwright (grant permission via context
  options → assert a valid `PushSubscription` POSTed to the mock API, correct VAPID key);
  SW `push` event unit test via direct `dispatchEvent` in a worker test env (payload →
  correct localized notification options); `notificationclick` routing test.
- **Manual, gated:** one real push to a physical Android + one installed-iOS device in the
  pre-season drill and before any alert-path release — this matches QA's checklist item
  ("one real push received on a physical device") and closes the gap honestly.

### 5.8 i18n (BG default + EN; more later per security/expansion)

#### 5.8.1 Mechanism [MVP]

No i18n framework. Typed message modules per locale, code-split so a session pays only
for its language:

```ts
// core/i18n/messages.ts — the contract: one interface, N implementations
export interface Messages {
  event: { status: Record<FireStatus, string>; lastPass(time: string): string; … };
  banner: { stale(minutes: number): string; offline(since: string): string; … };
}
// bg.ts / en.ts implement it; TS errors on any missing key = the "extraction" tooling.
const load = { bg: () => import('./bg'), en: () => import('./en') };
```

Interpolation is plain template functions (full TS checking of arguments — better than
any string-DSL). Pluralization via `Intl.PluralRules` in the two helpers that need it
(BG: one/other — simple). If the language count grows past ~4 with an external
translator [v2], migrate to Paraglide-style compiled catalogs; the `Messages` interface
makes that a mechanical move. The SW imports the same modules for push-notification text
(§5.4.3).

Locale selection: `localStorage` override → `navigator.language` prefix → `bg` default;
`<html lang>` kept in sync (screen readers, hyphenation). Route-based locale prefixes are
unnecessary for an app of this shape (and hurt permalink simplicity); an explicit `?hl=`
param supports shareable-language links for media embeds [v2].

#### 5.8.2 Dates, numbers, units

`Intl.DateTimeFormat`/`RelativeTimeFormat`/`NumberFormat` with the active locale —
zero-KB, correct Bulgarian output ("преди 25 мин"). House rules: times shown in
**Europe/Sofia** regardless of device TZ (fires are *at* a place; a traveling user must
see local-to-the-fire time) with the zone made explicit; absolute timestamp always
alongside relative age (§5.2.4 clock discipline); metric only (ha, km, km/h; FRP in MW
with a "what is this" popover). One `format.ts` module; no date library — `Temporal` is
available in 2026 evergreen browsers but even it is unnecessary at this scope.

#### 5.8.3 Cyrillic fonts

- **UI: system font stack** (`system-ui, -apple-system, Roboto, …`) — 0 bytes, complete
  Cyrillic on every platform, best rendering on cheap Androids. A brand webfont is a [v2]
  aesthetic decision; if taken, WOFF2 with `unicode-range`-split cyrillic subset
  (~20–25 KB) + `font-display: swap`, and it still never blocks first paint.
- **Map: glyph PBFs** are independent of UI fonts (§5.3.4) — Noto Sans ranges self-hosted.
  The two systems intentionally do not share fonts; matching them visually is a styling
  nicety, not a requirement.

### 5.9 Build & tooling

#### 5.9.1 Vite — confirmed, with a version note

Vite remains the right tool. As of mid-2026 **Vite 8 (Rolldown-powered) is the current
stable line** ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8-beta),
[releases](https://vite.dev/releases)); Vite 7 is the conservative fallback. Recommend
starting on the current stable 8.x — the Rolldown migration mostly removes config
(esbuild/Rollup split gone) — and pinning exact versions (same discipline as MapLibre).
Plugins: `@preact/preset-vite`, `vite-plugin-pwa` (injectManifest), a ~30-line custom
plugin for the two-variant style build (§5.3.5). TypeScript `strict: true` plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — the
reconciler is exactly the code where `noUncheckedIndexedAccess` earns its keep.

#### 5.9.2 Shared types: TypeBox contracts package — recommended over OpenAPI codegen

The backend review already established `@fire-watch/contracts` (TypeBox, zero runtime
deps). **Frontend consumes it directly; no OpenAPI codegen step.** Rationale:

- `Static<typeof FireEventProps>` gives compile-time types with *zero* generated code,
  zero drift window, one source of truth — the schema literally is the server's runtime
  validator. OpenAPI codegen adds a generation step, a second artifact to review, and
  lossy translation (TypeBox → OpenAPI → TS round-trips degrade unions/literals).
- Runtime validation on the client: cheap **structural guards only** at the trust
  boundary (does the payload have `freshness.generatedAt`? is `seq` a number?) — do not
  ship TypeBox's compiler to the browser for full validation; the payload comes from our
  own server, and the failure mode is handled by the quarantine rule (§5.6).
- OpenAPI still happens — *generated from* TypeBox on the server side — but as [v2] B2B
  API documentation output, not as the frontend's type source.

#### 5.9.3 Repo layout (monorepo-lite — extends 02-backend §5.1)

```
fire-watch/                    # pnpm workspace (as per backend review)
├── packages/contracts/        # @fire-watch/contracts — TypeBox schemas (shared)
├── server/                    # @fire-watch/server — Fastify (backend review's layout)
├── web/                       # @fire-watch/web — this document's §5.2.1 layout
│   ├── public/                # manifest, icons, robots
│   ├── src/{core,map,ui,sw}/
│   ├── styles/                # base style spec + palettes → build emits 2 style JSONs
│   └── test/{unit,e2e,fixtures}/
└── (docs/, infra/ as established)
```

One workspace, three packages, no more. CI: web package gets typecheck → lint (incl.
dependency-cruiser boundaries) → unit → build → Lighthouse-CI budgets → Playwright smoke;
style-lint + CVD check run on the emitted style JSONs (QA's scripts). Deploy: build
output → Cloudflare Pages (static), fully decoupled from the server's VM deploy — the
frontend can ship during a backend freeze and vice versa.

---

## 6. Risks ranked (consolidated)

1. **F-1 Reconciliation correctness** — highest product-trust impact; fully mitigable
   with the §5.2.4 rules + §5.7.1 property suite. Must be done before any map UI.
2. **F-2 iOS alert reach** — inherent platform constraint; mitigated by install-first
   flow + Telegram parity. Accept and design for it; do not promise "push on iPhone"
   in marketing copy without the install caveat.
3. **F-3 MapLibre bundle & upgrade drift** — pin + budget CI; adopt tree-shaken imports
   when stable.
4. **F-7 weak-GPU rendering** — lite mode + hillshade-only; test on the real reference
   device before season.
5. **F-5 SW update staleness** — update flow discipline; rehearse a "frontend hotfix
   reaches clients" drill alongside SRE's April checklist.
6. **F-4/F-6 MapLibre footguns (style switch, feature-state ids)** — cheap, known
   mitigations; both are week-1 spike items.
7. **F-8/F-9/F-10** — low; scheduled into v1 as noted.

## 7. Open questions (for the product owner / next ADRs)

1. **Framework sign-off:** this review recommends Preact over the "React" placeholder in
   ANALYSIS §5. Any reason (planned collaborator with React-only experience, a specific
   React library on the roadmap) to pay the 40 KB and choose React proper? Decide in
   ADR-005; the framework-free core makes either answer safe.
2. **Admin/curation UI** (curated incident log, v1): same PWA behind auth, or a separate
   minimal app? Recommendation: separate lazy route group in the same repo, separate
   chunk, server-gated — but confirm scope before v1 planning (affects auth/session work
   from the security review).
3. **Media embed** (business model mentions licensing the live map embed): an embeddable
   build changes CSP/frame-ancestors (security review's note), routing, and attribution
   layout. Is [v2] embed real enough to reserve URL/architecture space now (`/embed`
   route, postMessage API)?
4. **Map label language toggle:** always `name:bg`-first, or should the EN UI locale also
   switch map labels to `name:en`/`name`? (Cheap either way — one `setLayoutProperty`
   sweep or a per-locale style pair — but a product decision about identity: a Bulgarian
   map with Latin labels reads differently to diaspora vs foreign users.)
5. **RUM/analytics stance:** §5.5.3 proposes a self-hosted `web-vitals` beacon (no
   third-party). Does the privacy posture (security review) allow even first-party
   device-class + timing collection without a consent banner, and do we want *any* usage
   analytics beyond it at MVP?
6. **Offline packs priority:** is the [v2] offline region-pack feature (hikers, volunteer
   crews) real demand or imagined? It constrains the tile-layout decision (exploded z/x/y
   favored — which SRE recommends anyway) and adds meaningful SW complexity.
7. **`hull` geometry timing:** the zoom-ladder (§5.3.3) upgrades from dots to event
   polygons when the backend ships hulls. Is that MVP or v1 on the backend roadmap? The
   frontend renders either, but the visual identity of the product differs noticeably.
8. **Reference device procurement:** which exact €150-class Android do we buy for the lab
   shelf (and the April drill)? One physical device beats every emulator; it should be
   named in the QA launch-gate checklist.

---

## Appendix — Sources verified for this review (2026-07-22)

- Apple, DMA and apps in the EU (Home Screen web apps continue, on WebKit) —
  https://developer.apple.com/support/dma-and-apps-in-the-eu/
- WebKit: Web Push for Web Apps on iOS/iPadOS (16.4, Home-Screen-only) —
  https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- WWDC25: Declarative Web Push (Safari/iOS 18.4+) —
  https://developer.apple.com/videos/play/wwdc2025/235/
- iOS PWA state 2026 incl. iOS 26 open-as-web-app default (secondary; EU claims therein
  rejected against Apple's page above) —
  https://www.mobiloud.com/blog/progressive-web-apps-ios
- OpenFreeMap (free, no limits/keys; attribution requirement; no SLA) —
  https://openfreemap.org/
- maplibre-gl v6.0.0 bundle size: 965,967 B min / 250,692 B gz —
  https://bundlephobia.com/package/maplibre-gl
- MapLibre bundle-size monitoring issue (growth per release) —
  https://github.com/maplibre/maplibre-gl-js/issues/7255
- Framework size comparison (React/Preact/Solid, 2026) —
  https://www.index.dev/skill-vs-skill/frontend-react-vs-preact-vs-solidjs
- Vite 8 (Rolldown) announcement & releases —
  https://vite.dev/blog/announcing-vite8-beta , https://vite.dev/releases
