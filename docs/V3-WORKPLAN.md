# Fire Watch v3.0 — parallel work plan

*2026-10-28.* How to build the items of [`V3-FEATURES.md`](V3-FEATURES.md) in parallel: one item
per branch, several sessions at once, without the branches getting in each other's way. The
feature analysis says *what* and *why*. This document says *who owns which file*, *in what order
items may start*, and *how shared files are edited*.

Nothing here changes scope. An item is still only built after the founder has ticked it (V3
§7), and every go-live gate in V3 §3 still applies.

## 1. How to work on an item

1. **Claim.** One item per session. Run from the main checkout:

   ```sh
   node ~/.claude/skills/%-start-on-roadmap/scripts/start.mjs claim --roadmap docs/V3-WORKPLAN.md
   # or a specific item:
   node ~/.claude/skills/%-start-on-roadmap/scripts/start.mjs claim --roadmap docs/V3-WORKPLAN.md --id V3-B3
   ```

   The claim is the branch `wp/<ID>`, checked out as a worktree in
   `~/Development/_branches/fire-watch-<ID>`. Another session cannot claim an item whose branch
   exists. The script reads this file **from committed `main`**, so a status change only counts
   once it is merged.
2. **Build** only inside the files the item owns (§4), plus the one-line or one-block edits to
   shared files that §3 allows.
3. **Close the row.** The item's last commit sets its own row in §2 to `done`. That is the only
   edit to §2 a branch makes. `TASKS.md` and V3 §7 are not edited in item branches. They are
   updated on `main` when the founder ticks the item.
4. **Merge** with the script. It rebases onto `main` under a lock, runs the gate and
   fast-forwards `main`:

   ```sh
   node ~/.claude/skills/%-start-on-roadmap/scripts/start.mjs merge \
     --gate "NODE_OPTIONS=--max-old-space-size=6144 pnpm run verify"
   ```

   Items with a migration also run the integration suite (Postgres via the `fwtest` colima
   profile, see `WORKLOG.md`) before merging. Exit 5 means a rebase conflict, 6 a red gate and
   7 that `main` cannot be fast-forwarded. Resolve them by the rules in §3 and run `merge`
   again. If the item is dropped, use `abandon` so the branch and worktree go away.
5. **Never push.** Pushing `main` is the owner's call.

**How many at once.** Up to four sessions. `verify` can be killed for memory (exit 137) when
several run together. Keep the Mac awake (`caffeinate`) during a wave.

## 2. Items

`Status` is `todo` (claimable once its `Deps` are `done`), `blocked` (needs something outside
v3, listed under *Build needs*) or `done` (merged). There is no `taken` status: the `wp/<ID>`
branch is the claim. `Deps` lists only IDs in this table. *Go-live gate* does not block building: the
item ships dark (feature flag off, or not linked) until the gate clears.

| ID | Item | Status | Deps | Build needs (outside V3) | Go-live gate | Migration | Est h |
|---|---|---|---|---|---|---|---|
| V3-P1 | Per-feature i18n catalog fragments | todo | — | — | — | — | 6 |
| V3-P2 | Event-detail section registry | done | — | — | — | — | 4 |
| V3-P3 | Outline time-series reader | todo | — | — | — | — | 6 |
| V3-P4 | Reserve the v3 source IDs | todo | — | — | — | 060 | 4 |
| V3-A1 | FireSat ingest adapter (fixtures first) | todo | V3-P4 | — | EFA access + terms (V3-Q5) | — | 24 |
| V3-A2 | Sentinel-3 SLSTR FRP adapter | todo | V3-P4 | — | CDSE account, NRT latency check | — | 20 |
| V3-A3 | Landsat active fire as confirmation | todo | V3-P4 | — | Balkan coverage confirmed | — | 10 |
| V3-A4 | Commercial constellation adapter | blocked | V3-P4 | Commercial contract (data format) | Paid tier | — | 16 |
| V3-A5 | GEO-created events, gated | blocked | — | V2-A3, GATE-v2 evidence, ADR-002 amendment | Same | — | 24 |
| V3-A6 | Cross-source agreement score | todo | V3-P2 | — | — | — | 10 |
| V3-B1 | Observed growth direction | todo | V3-P2, V3-P3 | — | V3-Q1 label | — | 16 |
| V3-B2 | Area-over-time chart | todo | V3-P2, V3-P3 | — | — | — | 8 |
| V3-B3 | "Quiet since" indicator | todo | V3-P2 | — | Copy keys | — | 8 |
| V3-B4 | Templated event brief | todo | V3-P2 | — | V3-Q2 | — | 16 |
| V3-C1 | Trip mode | blocked | — | v1 I2 polygon zones | — | 063 | 20 |
| V3-C2 | "Near me now", in-browser only | todo | — | — | — | — | 10 |
| V3-C3 | Offline and low-bandwidth mode | blocked | — | v1 PWA / service worker | — | — | 24 |
| V3-C4 | Accessible alert formats | todo | — | — | Founder copy | — | 12 |
| V3-C5 | Household readiness profile | todo | — | — | Founder content, DPIA note | 064 | 10 |
| V3-D1 | OGC API – Features endpoint | blocked | — | V2-G1 public API | V2-Q4 terms | — | 20 |
| V3-D2 | TypeScript SDK | blocked | — | V2-G1 OpenAPI document | npm org | — | 12 |
| V3-D3 | Fire Watch MCP server | blocked | — | V2-G1 public API | V2-Q4 terms | — | 16 |
| V3-D4 | Embeddable map widget | blocked | — | V2-G1 API keys | V2-Q3 / V3-Q7 pricing | 065 | 24 |
| V3-D5 | Changelog and status feed | todo | — | — | — | — | 6 |
| V3-E1 | Recovery monitoring (NDVI) | blocked | V3-P2, V3-P3 | V2-E1 dNBR job | — | 066 | 24 |
| V3-E2 | Post-fire hazard context | todo | V3-P2 | — | Founder wording | — | 16 |
| V3-E3 | Repeat-burn history | blocked | V3-P2 | V2-A5 history | — | — | 8 |
| V3-F1 | EDO drought indicator layer | todo | — | — | Licence confirmation | — | 10 |
| V3-F2 | Season-start digest | blocked | — | V2-B5, V2-C7 | — | — | 8 |
| V3-G1 | Municipal dashboard | blocked | — | V2-G3 org accounts, V2-A5 | — | 067 | 32 |
| V3-G2 | Cross-border picture | blocked | — | V2-H1 coverage, V2-H2 languages | — | — | 20 |
| V3-G3 | Bulk asset exposure screening | blocked | — | V2-G3, V2-A5, V2-D2 import | V2-Q3 pricing | 068 | 24 |
| V3-G4 | Org webhook templates (Teams, Slack, CAP) | todo | — | — | V3-Q4 for CAP only | 069 | 16 |
| V3-H1 | Public accuracy and latency page | todo | — | — | Founder sign-off (V3-Q6) | 062 | 16 |
| V3-H2 | "Why did / didn't I get an alert" | blocked | V3-P2 | V2-C6 decision log UI | — | — | 12 |
| V3-H3 | Detection provenance | todo | V3-P2 | — | — | 061 | 8 |
| V3-I1 | Multi-region read path | blocked | — | Second host | — | — | 32 |
| V3-I2 | Partitioned detection history | todo | V3-P4, V3-H3 | — | — | 070 | 16 |
| V3-I3 | Per-tenant rate limits and metering | blocked | — | V2-G6 billing hooks | — | 071 | 16 |

When a *Build needs* prerequisite lands on `main`, a commit on `main` flips that row from
`blocked` to `todo`. That is the only other edit to this table.

### What can run together

- **Free now, in parallel:** V3-P1, V3-P2, V3-P3, V3-P4, V3-C2, V3-C4, V3-C5, V3-D5, V3-F1,
  V3-G4, V3-H1. They share no owned file, and none of them depends on another.
- **After V3-P2 merges:** V3-A6, V3-B3, V3-B4, V3-E2, V3-H3 in parallel. Each adds one section
  file.
- **After V3-P2 + V3-P3:** V3-B1 and V3-B2 in parallel. Both read the series, neither owns it.
- **After V3-P4:** V3-A1, V3-A2 and V3-A3 in parallel. Each is its own adapter directory.
- **Serial by design:** V3-I2 runs alone on the detections table, after V3-P4 and V3-H3. It must
  not be claimed while another branch has a migration touching `detections`. Check `git branch
  --list 'wp/*'` before claiming it.

## 3. Rules for shared files

Most conflicts in this repo come from about a dozen files that many items touch (by churn since
2026-10-20: `TASKS.md`, the i18n catalogs, `bundle-budgets.ts`, `styles.css`,
`types.generated.ts`, `map-controller.ts`, `schema.integration.test.ts`, `erasure-plan.ts`,
`worker.ts`). Each rule below turns an edit to one of them into either *no edit* or *an
append-only block that merges as "keep both sides"*.

| Shared file | Rule | On rebase conflict |
|---|---|---|
| `server/db/migrations/NNN_*.sql` | Use **only** the number reserved in §2. 037–059 stay for wave-0 / v2 work; 072–079 are spare and handed out by editing §2 on `main` first. Gaps are fine: `checkMigrations` is set-based. An advisory lock class follows the number (`pg_advisory_xact_lock(7063, …)` for 063). | None expected. Before launch (K4) out-of-order merges are fine. After K4, renumber at merge to the next free number above the highest applied one. |
| `server/src/db/types.generated.ts` | Never hand-edited. Regenerate with `pnpm --filter server run db:codegen` against a database with all migrations applied. | Take either side, re-run codegen after the rebase, commit the result. |
| `server/src/db/schema.integration.test.ts` | Do not add to it. Each item adds `server/src/db/<item>.schema.integration.test.ts`. | — |
| `web/src/core/i18n/{messages,en,bg}.ts` | Each item adds **one new top-level namespace**, inserted directly after the anchor namespace assigned in §4. All three files use the same anchor. Never edit keys inside another namespace. New strings go into `PENDING_FOUNDER_REVIEW` as one block, with a `// V3-XX` comment. Frozen glossary strings (CI-10/11) are not touched. Once V3-P1 lands, a fragment file replaces all of this. | Keep both sides. Anchors are distinct, so a conflict means two items picked the same anchor: move the later one. |
| `packages/contracts/src/sources.ts` | Only V3-P4 edits `SOURCE_IDS`, `SOURCE_REGISTRY` and `SOURCE_REGISTRY_VERSION`. It adds all four v3 sources (disabled) and their catalog labels at once. A1–A4 flip only their own entry's enable flag. | — |
| `packages/contracts/src/credits.ts` | One `Credit` entry per new data source, appended, with a `// V3-XX` comment. | Keep both sides. |
| `packages/contracts/src/problem-codes.ts` (and the web's total record over it) | New codes in one block at the end, under `// V3-XX`, with names prefixed by the feature (`trip_…`, `embed_…`). | Keep both sides, in both files. |
| `server/src/app/api-composition.ts`, `worker.ts`, `web/src/ui/logic/routes.ts` (`ROUTE_TABLE`), `web/src/ui/layers-panel.tsx` | One line, or one block, per item, appended at the end of its list, with a `// V3-XX` comment. Logic goes in the item's own files. A new route is covered by CI-18 automatically, so it must render at all four viewports. | Keep both sides. |
| `web/budgets/bundle-budgets.ts` (`LAZY_ROLES`) | One new line per new lazy root, with its own regex. Never widen another item's regex or a shared alternation. New UI is lazy: `criticalPath` (already over budget, a founder call) must not grow by a byte. | Keep both sides. |
| `web/src/map/layer-registry.ts` | Not edited. A new overlay lives in its own `web/src/map/<name>-layer.ts` and inserts itself with `firstFireLayer(host)`, as wind, lightning and swaths do. New colours stay out of the red family (CI-14, fire owns red). | — |
| `web/src/ui/event/event-details.tsx` | Not edited after V3-P2. An item adds `web/src/ui/event/sections/<slot>-<name>.section.tsx`, using the slot number given in §4. | — |
| `web/src/styles.css` | Not edited. Each item ships its own CSS file next to its component and uses the existing tokens. | — |
| `server/src/core/observability/metric-catalog.ts` | New descriptors in one block per item, with names prefixed by the feature. | Keep both sides. |
| `server/src/core/erasure/erasure-plan.ts`, `account-export/export-schema.ts`, `docs/legal/README.md` | An item that stores personal data (C1, C5, D4, G1, G3, I3) adds its tables to the plan and the export, and bumps the plan version (currently v8) **in its last commit before merge**. | Both sides bumped: keep both tables, set the version to one above `main`'s, re-run the erasure tests. |
| `docs/TASKS.md`, `docs/V3-FEATURES.md` | Not edited in item branches (see §1, step 3). | — |

## 4. Ownership per item

*Owns* lists paths created by the item that nobody else edits. *i18n after* is the anchor
namespace for the item's own namespace. *Slot* is the event-detail section order. Existing
sections sit at 100 (static source), 200 (protected site), 300 (land cover), 400 (lightning), 500
(fire outline), 600 (CEMS), 700 (detections), 800 (before/after) and 900 (where).

| ID | Owns | i18n namespace (after) | Slot |
|---|---|---|---|
| V3-P1 | `web/src/core/i18n/fragments/`, the merge step, its governance tests | — | — |
| V3-P2 | `web/src/ui/event/sections/` (registry, `import.meta.glob` loader, one `LAZY_ROLES` rule covering all section files) | — | — |
| V3-P3 | `server/src/core/outlines/series.ts`, its read route and contract type | — | — |
| V3-P4 | migration 060; the four source entries; their catalog labels | — | — |
| V3-A1 | `server/src/adapters/firesat/`, fixtures, F15 TLE entry | — | — |
| V3-A2 | `server/src/adapters/slstr/`, NetCDF fixtures | — | — |
| V3-A3 | `server/src/adapters/landsat/` (attach-only) | — | — |
| V3-A4 | `server/src/adapters/commercial/` | — | — |
| V3-A5 | `server/src/core/promotion/geo-created.ts` | `geoCreated` (after `signIn`) | — |
| V3-A6 | `server/src/core/scoring/agreement.ts`, section file | `sourceAgreement` (after `nav`) | 650 |
| V3-B1 | `server/src/core/outlines/direction.ts`, section file, `web/src/map/direction-layer.ts` | `observedDirection` (after `tierLabel`) | 520 |
| V3-B2 | section file, chart component | `areaOverTime` (after `statusShort`) | 540 |
| V3-B3 | `web/src/ui/event/quiet-since.ts`, section file | `quietSince` (after `lifecycle`) | 660 |
| V3-B4 | `web/src/core/event-brief/` (fragment registry), section file | `eventBrief` (after `status`) | 150 |
| V3-C1 | `server/src/core/zones/trip/`, migration 063 | `tripMode` (after `layers`) | — |
| V3-C2 | `web/src/core/near-me/`, `web/src/ui/near-me.tsx` | `nearMe` (after `shareCard`) | — |
| V3-C3 | the service worker's offline cache module, `web/src/ui/pages/text-list.tsx` | `offline` (after `passes`) | — |
| V3-C4 | `server/src/core/alerts/formats/` | `accessibleAlerts` (after `dataExport`) | — |
| V3-C5 | `server/src/core/preferences/readiness.ts`, migration 064 | `readiness` (after `ogImage`) | — |
| V3-D1 | `server/src/core/ogc/`, its routes | — | — |
| V3-D2 | `packages/sdk/` (new workspace package) | — | — |
| V3-D3 | `packages/mcp/` (new workspace package) | — | — |
| V3-D4 | `web/src/embed/` (own HTML entry and budget), migration 065 | `embed` (after `playback`) | — |
| V3-D5 | `server/src/core/changelog/`, `docs/changelog/` | `changelog` (after `ageWindow`) | — |
| V3-E1 | `server/src/core/recovery/`, migration 066, section file | `recovery` (after `meteoalarm`) | 870 |
| V3-E2 | `server/src/core/post-fire/`, `web/src/map/post-fire-layer.ts`, section file | `postFireHazard` (after `filters`) | 860 |
| V3-E3 | section file | `burnHistory` (after `onboarding`) | 850 |
| V3-F1 | `server/src/adapters/edo/`, `web/src/map/drought-layer.ts`, its layers option | `drought` (after `search`) | — |
| V3-F2 | `server/src/core/digest/season-start.ts` | `seasonStart` (after `settings`) | — |
| V3-G1 | `server/src/core/municipal/`, `web/src/ui/pages/municipal.tsx`, migration 067 | `municipal` (after `about`) | — |
| V3-G2 | `web/src/ui/pages/cross-border.tsx` | `crossBorder` (after `privacy`) | — |
| V3-G3 | `server/src/core/exposure/`, migration 068 | `assetScreening` (after `disclaimer`) | — |
| V3-G4 | `server/src/core/webhooks/templates/`, migration 069 | `orgIntegrations` (after `listInView`) | — |
| V3-H1 | `server/src/core/accuracy/`, `web/src/ui/pages/accuracy.tsx`, migration 062 | `accuracy` (after `mapControls`) | — |
| V3-H2 | `web/src/ui/why-alert/`, section file | `whyAlert` (after `accessibility`) | 950 |
| V3-H3 | migration 061, section file | `provenance` (after `measure`) | 750 |
| V3-I1 | deploy config, `server/src/core/transport/region.ts` | — | — |
| V3-I2 | migration 070, `server/src/core/history/archive.ts` | — | — |
| V3-I3 | `server/src/core/metering/`, migration 071 | — | — |

Paths are where the item's code is expected to live. If the code calls for a different place, keep
the principle: the item creates its own directory or file and does not take over one another item
owns.

## 5. The four prep items

They exist only to take the worst hotspots out of the way, and each is small. P2, P3 and P4 are
real prerequisites (see §2 `Deps`). P1 is optional: until it lands, the anchor rule in §3 covers
the catalogs.

- **V3-P1 — i18n fragments.** Each feature keeps its strings in `fragments/<name>.{en,bg}.ts`,
  typed by augmenting `interface Messages` with its own namespace. The locale catalog merges the
  fragments at build time, and stays one lazy chunk per locale (CI-12 `locale` role). Done
  when CI-10/11, the catalog-render test and the `PENDING_FOUNDER_REVIEW` assertion pass over the
  merged catalog, and one existing namespace (`beforeAfter`) has been moved into a fragment as
  the proof.
- **V3-P2 — event-detail section registry.** Section files under
  `web/src/ui/event/sections/` are found with `import.meta.glob` and ordered by their slot
  prefix. Each is a lazy chunk under one `LAZY_ROLES` rule. The existing sections keep their
  order (slots in §4). Done when the event page renders identically (e2e + a11y sweep) and an
  empty section file at a new slot appears in the right place in a test.
- **V3-P3 — outline time-series reader.** A pure function from an event's stored outlines to an
  ordered series (time, area, centroid), plus the read path the web needs. B1, B2 and later E1
  only consume it.
- **V3-P4 — reserve the v3 source IDs.** Adds `firesat`, `slstr`, `landsat` and the commercial
  source ID, all disabled, to `SOURCE_IDS` and `SOURCE_REGISTRY`, with one
  `SOURCE_REGISTRY_VERSION` bump, any database constraint in migration 060, and their catalog
  labels (pending founder review). Every `Record<SourceId, …>` in the code stays total. After
  this, the source adapters never edit a shared source file.

## 6. Status

*2026-10-28 — plan only. No item claimed. Items stay unbuilt until the founder ticks them (V3
§7).*
