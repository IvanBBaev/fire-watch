# Review 14 — Corner-case register for the distilled design

*Status: complete. Date: 2026-07-31. Scope: ADR-001..005 + GLOSSARY/GATES read
line-by-line for edge conditions; each case classified Covered / Partial / GAP.
Excludes everything already filed in review 13 (cited where adjacent).*

## 0. Method and headline

A corner-case pass over the accepted design: for every rule, ask what happens at the
boundary, at the tie, at zero, at forever, and across the seams (year, DST, border,
merge, deletion). The design is strong at the boundaries it *named* — S1–S9 fixtures,
the five invariants, and the reconciler property tests already cover the classic
identity/merge/replay corners. The gaps cluster where two subsystems meet and neither
ADR owns the seam.

**Result: 10 new gap clusters (4 high, 6 medium) + a minors bundle; 6 fixture
proposals (S11–S16). Nothing invalidates an ADR decision — every fix is an amendment
paragraph or a pinned rule.**

## 1. High-severity gaps

### H1 — The E-accumulator can deadlock: lifecycle states that never exit

ADR-002 D6, two distinct paths to a stuck-`active`-forever event:

1. **Permanent source loss.** "A source outage freezes E" is written for transient
   outages, but Terra/Aqua (MODIS) are end-of-life in exactly this period. A source
   that never comes back = its freshness budget is blown forever = **E frozen forever
   for every event** → nothing ever reaches `no_longer_detected` again. (Adjacent to
   review 13's constellation-replay gate, which covers *fitting*; this is the
   *operational* semantics.)
2. **Unbounded cloud.** >80% cloud ⇒ no accumulation, with no ceiling: a small grass
   fire under two weeks of overcast stays `active` indefinitely — dishonest in the
   other direction from the false-reassurance harm.

**Fix (ADR-002 D6 amendment):** (a) E freezes per-source, not globally — a source
marked `retired` in the source registry leaves the expected-overpass set entirely
(registry gains a status column; ties into the review-13 source-id registry);
(b) hard fallback: ≥14 d with zero detections **and** zero accumulable overpasses →
`no_longer_detected` with a dedicated copy variant ("no observations possible due to
cloud cover for N days") added to GLOSSARY §3b. Fixture **S11**: replay with one
source retired mid-scenario; assert lifecycle still progresses.

### H2 — `officially_contained` / `officially_extinguished` have no outgoing transitions

The ADR-002 D6 diagram gives re-detection arrows only from `signal_weakening` and
`no_longer_detected`. The officially_* states are terminal as drawn — yet Bulgarian
fires routinely re-flare after "локализиран", and satellites will contradict the
official statement within T_LINK. Undefined today: does the event return to `active`
(our data contradicting the authority — copy-sensitive), or does nothing happen
(alert gap on a real re-flare)? Review 13 flagged only the *alert-type* ambiguity
past T_LINK; the state machine itself is the bigger hole.

**Fix (ADR-002 D6 amendment):** within T_LINK, re-detection returns the event to
`active`, preserving the official statement as history; copy states both facts
without adjudicating ("Нови сателитни засичания на <дата>, след като пожарът беше
обявен за локализиран на <дата>") — new GLOSSARY §3 row, EN+BG, in CI-11 scope.
`escalation` alert allowed (it is a status worsening). Fixture **S12**.

### H3 — `detection_uid` canonicalization is under-specified (permanently unfixable)

The uid hashes `source | acq_ts_iso | lat_5dp | lon_5dp`, but three inputs have no
pinned serialization, and any later "fix" silently breaks idempotency across the
append-only archive:

- **acq_ts_iso format**: FIRMS delivers `HHMM` (no seconds); is the canonical form
  `2026-08-01T13:05:00Z` or `13:05Z`? Zero-pad rule for `acq_time=5`? Must be one
  frozen function in `packages/contracts`.
- **Rounding mode for 5dp**: half-up vs half-even vs truncate differ across
  languages/libs; `toFixed` alone is not a spec.
- **Product tier is not in the hash but affects duplication**: FIRMS re-delivers the
  same detection through RT→NRT with *revised geolocation* → different rounded
  coords → different uid → duplicate rows dedup cannot catch. The source registry
  must pin exactly one product tier polled per source (poll NRT only).

**Fix:** a "uid canonicalization" subsection in the frozen source-id registry
(review 13 §3.1 item 5 grows these three rules). Property test: canonical
serializer is byte-stable across representative raw CSV rows.

### H4 — A zone created over an already-active fire fires a "new fire" push

ADR-004 D3 state starts at `none` per `(zone_id, event_id)`. The most common
onboarding path during a fire — user hears about the fire, installs, draws a zone —
would immediately push `new_fire` for a week-old event: alarming, confusing, and it
reads as "the fire just started". Nothing in ADR-004 or the GLOSSARY taxonomy
addresses alert semantics for *pre-existing* events at zone creation.

**Fix (ADR-004 D3 amendment):** on zone creation, seed state for all currently
alertable events intersecting the zone as `notified_new` (no send); the zone-creation
UI shows those fires inline ("вече активни пожари във вашата зона") — an onboarding
surface, not a push. Fixture **S13**: zone created mid-scenario; assert zero sends
for pre-existing events, normal alerts for subsequent ones.

## 2. Medium-severity gaps

### M1 — Set-membership changes that don't bump `seq` are invisible to clients

ADR-003: ETag derives from global max seq; removal requires
`snapshot.maxSeq > events[id].seq`. Two leaks:

- The **display-window rule** (gray 48 h on map / 7 d permalink, review-13 lost item)
  removes events from the active set by *time passing* — no state write, no seq bump.
  In-season other events mask this (maxSeq moves anyway); off-season the last event
  of the year can linger client-side indefinitely.
- The **cursor variant** `?updated_after_seq=N` returns only newer events and is
  never authoritative on the set; a client polling only cursors can never remove
  anything (zombie events).

**Fix (ADR-003 D1/D3 amendment):** invariant — *every* set-membership change is a
status transition that increments global seq (no wall-clock filters at snapshot-build
time); clients using the cursor variant must fetch a full snapshot at least every
10 min (same cadence as the SSE safety snapshot). Add a fast-check property:
cursor-only client + removal converges after ≤1 full-snapshot cycle.

### M2 — The polling bbox is not config, and its edge truncates fires

DATA-SOURCES says "a Balkans bbox" — nowhere pinned. A fire straddling the bbox edge
gets half its detections: wrong geometry, wrong E-accumulator (overpasses "should
have seen" pixels outside the box), possible split identity. S1 (Slavyanka) tests
the *country* border, not the *query* border. **Fix:** the bbox polygon becomes
config-as-data (versioned, like clustering params) with the rule *bbox ⊇ alertable
area buffered ≥ 2×ε_max + max zone radius*; fixture **S16** places a fire on the
bbox edge and asserts the buffer absorbs it.

### M3 — Outbox rows pending at zone/account deletion

At-least-once dispatch + 6 h queue expiry means a deleted account can still receive
an alert minutes after erasure. Provider-side pruning doesn't help — the endpoint is
still live at the provider. **Fix (ADR-004 D8):** account/zone deletion cancels
pending outbox rows (`status = cancelled_erasure`) in the same transaction; gateway
re-checks subscription liveness at dispatch. One integration test.

### M4 — ~1 km zone coarsening vs small zone radii

Stored zone centers are coarsened ~1 km (ADR-004 D8) — but alert geometry and
distance bands are computed from the stored center. A 500 m-radius zone with 1 km
coarsening error alerts on the wrong area and states wrong distances. **Fix:** pin
minimum zone radius ≥ 2 km (documented as a privacy-by-design consequence in the
zone UI), or compute containment pre-coarsening and store only band results. The
first option is simpler and honest; recommend it.

### M5 — Determinism micro-spec bundle (I5 depends on these)

Unpinned tie-breaks and boundaries, each individually trivial, all replay-breaking:

- GEO/coarse attach "nearest candidate only": equidistant tie → pin lowest cluster id.
- `possible_reignition` with multiple candidate parent events in range → pin
  parent-selection rule (nearest centroid; tie → oldest event).
- T_LINK / 72 h-window / reignition-window boundary comparisons: inclusive or
  exclusive — pin `≤` everywhere in the config spec.
- MODIS eps `max(3, 1.5·√(scan·track))` with missing/zero scan-track → NaN poisons
  clustering; pin default (treat missing as 1.0×2.0 nadir) inside E1 CSV validation.
- Fuel-specific reignition window for unclassified land cover → pin default 14 d
  (middle band).

**Fix:** one "boundary and tie rules" appendix in the clustering config spec
(`clustering_params_v1`), asserted by the double-run byte-diff (already CI).

### M6 — Alert-side DST has no fixture, and the calendar hands us a free test

S9 covers UTC/DST for ingest/lifecycle (ADR-002 acceptance) — but quiet hours
22:00–07:00 and the 09:00 digest are *local-time* (Europe/Sofia) rules in ADR-004,
untested across transitions. **The DST fallback (25 Oct 2026, 04:00→03:00) lands
inside the live shadow window** — the shadow diff that weekend is a free real-data
DST test if someone looks. Spring-forward 28 Mar 2027 lands inside the spring-burn
shadow. **Fix:** fixture **S14** (decision at 02:30 local on both transition nights;
assert quiet-hours classification and single digest); add "review the 25–26 Oct
shadow diff for time-window anomalies" to the CP1 protocol checklist.

## 3. Minors bundle

- **Glyph ranges (ADR-001 A1.1):** only Cyrillic is named; the Balkans extract
  renders Greek and Turkish labels near the border (S1 is literally on the Greek
  border) → include Greek U+0370–03FF and Latin-Extended in the self-hosted PBF
  build or border labels render as tofu.
- **`fw-<year>` is mint-year, not semantics:** ADR-002 says the id is "never derived
  from time" yet embeds the year; an SP revision moving `started_at` across New Year
  (or a survivor living into the next year) makes the embedded year cosmetically
  wrong. One sentence in D1: the year is mint-time cosmetic, never load-bearing,
  never corrected.
- **EFFIS proxy content check (ADR-001 A1.2):** serve-stale-on-error catches HTTP
  errors only; EFFIS occasionally returns 200 with an error/blank image → cheap
  content sanity (content-type + non-trivial byte size) before caching as "good".
- **Esri quota cliff degrade path (A1.3):** metering alarm exists; pin the client
  behavior — toggle disabled via `/api/client-config`, not a broken layer.
- **B=500 cutoff:** pin deterministic recipient order at the budget boundary
  (decision order), and emit a metric for sends deferred to T-approve so a stale
  approval arriving after queue expiry is *visible*, not silent.
- **Escalation re-trigger hysteresis:** "growth/status worsening" needs a pinned
  rule (upward threshold crossings fire once; re-crossing after a downgrade requires
  a new higher watermark) — FLR monitors flip-flop but nothing prevents it.
- **Client clock skew:** staleness "from server timestamps" still subtracts client
  now; pin server-time-offset estimation (Date header) in the reconciler so a
  wrong client clock can't fake a staleness banner (or hide one).
- **Multi-zone same user, same event:** digest floor dedups the *send*; pin which
  zone's template/distance band renders (nearest zone).
- **`available_at < acq_ts` sanity:** clamp/flag in CSV validation (clock skew
  upstream would corrupt the fixed batch ordering).

## 4. Confirmed covered (no action)

For the record, corner cases probed and found already handled: merge cascades and
alias cycles (I2 path compression), permalink of merged ids (200 + `mergedInto`,
S2), re-polled row idempotency (uid no-op), replay silence (I4, `--allow-revive`),
single-detection noise (S5), static sources (S4), agri-burn FP (S3), cross-*country*
border clustering (S1), megafire cooling + reignition relation (S6), transient
source outage (S8), cloudy *gap* (S7), SSE replay/gap/reset (ring buffer + reconciler
rules 2–4), snapshot/delta interleaving (fast-check properties), merge re-alert
suppression (I3 `migrateAlertState`), score-downgrade silence, tab-wake refetch,
T0 cap fail-silent to T1.

## 5. Fixture additions proposed

| # | Scenario | Asserts |
|---|---|---|
| S11 | Source retired mid-replay (MODIS) | E still accumulates from remaining sources; lifecycle progresses |
| S12 | Re-detection within T_LINK after `officially_extinguished` | Return to `active`, dual-fact copy, escalation (not new_fire) |
| S13 | Zone created over an active event | Zero sends for pre-existing events; normal alerts afterward |
| S14 | Alert decisions at 02:30 local on 25 Oct 2026 / 28 Mar 2027 | Quiet-hours classification stable; exactly one 09:00 digest |
| S15 | Cursor-only polling client + event removal | Convergence after ≤1 full-snapshot cycle (fast-check, client suite) |
| S16 | Fire straddling the polling-bbox edge | Buffer absorbs it; one event, correct geometry |

## 6. Where these land

All fixes are amendments/pins, no decision reversals: ADR-002 D1/D6 (H1, H2, H3
partly, M5, mint-year note), ADR-003 D1/D3 (M1, clock-skew minor), ADR-004 D3/D8
(H4, M3, M4, B-budget + escalation minors), ADR-001 A1 (glyphs, EFFIS content check,
Esri degrade), source-id registry / `packages/contracts` (H3, retired-source status),
clustering config spec (M2, M5), CP1 protocol checklist (M6). Sequencing joins the
review-13 §3 schedule: H3 belongs with §3.1 (before first production write); H1/H2/M2/
M5 with §3.4 (before WP2 clustering); H4/M3/M4 with §3.5 (before WP6/WP7); the rest
are non-urgent pins.
