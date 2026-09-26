# Glossary & wording contract

*Status: normative.* This file has three jobs:

1. **Glossary** — one canonical name per concept, with the document that owns its
   full definition. Schema, API, code identifiers, docs, and UI copy use these names;
   synonyms are review errors.
2. **Wording contract** — the exact user-facing lifecycle copy (EN/BG), the official
   Bulgarian fire-status terms, and the never-send list. The CI wording lint
   (ADR-004 Decision 7, gates CI-10/CI-11) is built from §3, §3b, §4 and §5: alert
   and UI templates are linted against these tables, so a copy change is a PR to
   this file first, then to the templates.
3. **Frozen identity inputs** — §1a and §1b pin the exact strings and serialization
   that enter `detection_uid`. The detection archive is append-only and dedup is
   defined by those bytes, so they can never be corrected in place, only versioned.

## 1. Core entities and identifiers

| Term | Meaning | Owned by |
|---|---|---|
| **Detection** | One satellite hotspot observation (pixel center + timestamp + radiometry). Append-only, immutable, no public identity. Carries full provenance (source, product tier, `available_at`, raw confidence, FRP) and reserves pixel-footprint fields (`scan_km`, `track_km`). | ADR-002 D1 |
| **`detection_uid`** | `sha256(source \| acq_ts_iso \| lat_5dp \| lon_5dp)` — the idempotent ingest upsert key; re-polled rows are no-ops. Its four inputs are frozen in **§1a/§1b**. | ADR-002 D1, §1a/§1b |
| **Product tier** | `NRT` (near-real-time), `SP` (standard processing; replaces NRT via monthly partition swap), `GEO` (geostationary). Exactly one tier is polled per source (§1b rule 3). | ADR-002 D1/D7, §1b |
| **Cluster** | The ephemeral spatio-temporal working set linking detections over the trailing 72 h window. Recomputable at any time; never exposed in the API. | ADR-002 D1/D2 |
| **FireEvent** | The public, permanent fire entity a cluster is promoted to (1:1 with the working set; visibility is a scoring concern, not an identity concern). | ADR-002 D1/D2 |
| **`public_id`** | `fw-<year>-<5-char base32>` (e.g. `fw-2026-k3d7q`). Issued once, never re-used, never derived from geometry or time. Resolves forever (invariant I1). | ADR-002 D1/I1 |
| **Tombstone / `mergedInto`** | A merged event's registry row pointing at its survivor. API answers **200 with `mergedInto`** — never 404, never redirect-only. Alias chains are path-compressed (I2). | ADR-002 D3, ADR-003 D4 |
| **`possible_reignition`** | Relation from a new event to a nearby predecessor within the fuel-specific reignition window (§6). Copy says "possible reignition of <event>" and never asserts causality. | ADR-002 D2 |
| **`static_source`** | Invalidation reason for the static hot-source mask (Maritsa-Iztok mines/TPPs, Neftochim, cement works): those locations never become events. | ADR-002 D2/D6 |
| **`seq`** | Global monotonically-increasing sequence number: per-event version on the wire, SSE frame `id:`, snapshot `ETag` basis. | ADR-003 D1/D3 |
| **Snapshot** | The full active-event JSON (`/snapshot.json`) — the T1 default transport, mirrored to R2 as T2. Authority on the event *set*; `seq` is authority on each event's *version*. | ADR-003 D1/D3 |
| **Delivery tiers T0/T1/T2** | T0 SSE (opt-in enhancement, hard cap 5,000 conns), T1 CDN-cached polling (default for everyone), T2 static R2 fallback. Every feature must be fully functional on T1 alone. | ADR-003 D1 |
| **Reconciler** | The five-rule client store contract merging snapshots and deltas; property-tested with fast-check. | ADR-003 D3 |
| **Transport supervisor** | Client state machine `BOOT → POLLING → (SSE_CONNECTING → SSE_LIVE) → STATIC_FALLBACK`, silent fallback, 30 min promotion hysteresis. | ADR-003 D3 |
| **Watch zone** | A user-saved location + radius that arms alerts. Stored ~1 km-coarsened and app-layer encrypted; "no analytics or segmentation on zone locations, ever". | ADR-004 D8 |
| **Score** | Bounded logistic `P(real fire \| evidence)` over ≤12 features. Buckets: **Confirmed ≥ 0.75**, **Likely 0.45–0.75**, **Unverified < 0.45**. Unverified copy always includes "may still be a real fire". Score downgrades never notify. | ADR-002 D6, review 11 §3 |
| **E-accumulator** | Miss-evidence accumulator: weighted clear-sky missed overpasses driving `no_longer_detected` (threshold E ≥ 3.0; ≥ 5.0 for large events; cloud-gated; frozen during source outages). | ADR-002 D6, review 11 §5 |
| **T_LINK** | Maximum same-event temporal gap (fitted p99 intra-fire detection gap; expected 36–60 h). | ADR-002 D2 |
| **T_REIGNITE** | Cluster-level reignition linking window (fitted p95 inter-episode gap, expected 4–8 d, clamped by the fuel windows in §6). | ADR-002 D2 |
| **Outbox** | `alert_outbox` — transactional alert-decision log with mandatory provenance (`trigger_type`, `trigger_ref`, `rule_version`, `template_id`, stage timestamps) plus, since A1.1, the human trail (`actor_id`, `approver_id`, `approval_mode`, `approved_at`, `budget_override`) and A1.2's stored `priority`. Audit trail, latency instrumentation, and liability artifact in one. | ADR-004 D1, A1.1, A1.2 |
| **Notification gateway** | The only module that can reach a provider adapter (lint-enforced). Owns budgets, circuit breaker, token buckets, template rendering, the never-send lint, and the kill switch. | ADR-004 D2 |
| **Golden replay** | The deterministic fixture suite (scenarios S1–S9) whose double run must produce a byte-identical event registry. | ADR-002 acceptance, review 06 §5.2 |
| **Dataset entry (`DS-n`)** | One dated record per corpus version in `docs/data/DATASETS.md`. Identity is the tuple — plan id and digest, area, polling-bbox version, manifest sha256 at `--check` — never the disk. A fit, calibration, replay or checkpoint cites the entry, not "the backfill"; a new entry is the refit trigger. | review 23 E1, GATES §2 |
| **FRP** | Fire Radiative Power (MW) — radiometric intensity of a detection. | data sources |
| **FWI** | Canadian Fire Weather Index as harmonized by EFFIS — a **~8 km weather-based danger index**, never a statement that fire is present (§7). | review 12 §5.1 |

## 1a. Source-id registry — **frozen v1**

These are the *only* strings that may appear as `source` in a `detection_uid`. The id
is a permanent hash input over an append-only archive: it is written once and read
forever, so this table is **closed** — see the rules below for how it may grow.

| Canonical `source` | Queried product | Instrument / platform | Tier polled | Status | Notes |
|---|---|---|---|---|---|
| `firms:viirs:snpp` | FIRMS Area API `VIIRS_SNPP_NRT` | VIIRS 375 m / Suomi-NPP | `NRT` | active | S-NPP EOL anticipated late 2026 → flips to `retired`, id retained forever |
| `firms:viirs:noaa20` | FIRMS Area API `VIIRS_NOAA20_NRT` | VIIRS 375 m / NOAA-20 | `NRT` | active | Long-term backbone |
| `firms:viirs:noaa21` | FIRMS Area API `VIIRS_NOAA21_NRT` | VIIRS 375 m / NOAA-21 | `NRT` | active | Long-term backbone |
| `firms:modis` | FIRMS `MODIS_NRT` / `MODIS_SP` (archive queries only) | MODIS 1 km / Terra + Aqua | — (never polled live) | **retired** | Aqua shutdown ~Aug 2026, Terra ~Feb 2027; archive, backfill and fixture replay only (DATA-SOURCES A2). One id for both platforms — see rule 2 |
| `eumetsat:slstr:frp` | EUMETSAT Data Store `SL_2_FRP___` NRT | SLSTR 1 km / Sentinel-3A + 3B | `NRT` | active | One product name covers both platforms — see rule 2 |
| `lsasaf:seviri:frp-pixel` | LSA SAF LSA-502 (MSG SEVIRI) | SEVIRI ~4 km over BG | `GEO` | active | Attach-only, never creates or merges events (ADR-002 D2) |
| `lsasaf:fci:frp-pixel` | LSA SAF LSA-509 (MTG FCI) | FCI ~3–4.5 km over BG | `GEO` | active | Demonstration maturity — paired with LSA-502, never trusted alone (DATA-SOURCES A4) |

**Not registered** (produce no detection rows, therefore no uids): MSG `FIR`/`FIRC`
CAP alerts — a re-poll tripwire, not a detection source (DATA-SOURCES A5); EFFIS
burnt-area perimeters; FireSat and OroraTech (no v1 access); crowdsourced reports
(evidence, never detections). Any of them entering the pipeline requires a registry
version bump under rule 1.

**Rules (all frozen with the table):**

1. **Append-only, never edited.** Ids are hash inputs: no rename, no re-casing, no
   re-scoping (splitting `firms:modis` into per-platform ids later is a *rename* and is
   forbidden). A new source is a **v2 registry** = this table plus appended rows;
   existing rows keep their meaning forever. Retiring a source changes only `Status`;
   rows are never deleted.
2. **Platform comes from the queried product name, never from the CSV column.** FIRMS
   `satellite`/`instrument` values are inconsistent across products and vintages
   (`Terra`/`Aqua`/`T`/`A`; `N`/`1`/`N20`/`N21` — 03 §5.1.1 pitfall 5); the raw column
   is retained in provenance for audit only. This is why `MODIS_NRT` — one feed mixing
   Terra and Aqua, distinguishable only by that column — gets exactly one id.
3. **Form:** lowercase ASCII, `provider:instrument:platform` segments joined by `:`
   (the platform segment is omitted where the queried product does not distinguish
   one). Lowercase is not a convenience: it removes case-folding as a variable from a
   permanent hash input.
4. **Product tier is not part of the id** — it is the `product_tier` column on the row.
   Tier discipline is §1b rule 3.
5. **`Status` semantics.** `active` = in the v1 live-poll set (present or planned) and
   counted in the expected-overpass set. `retired` = never polled again and **removed
   from the expected-overpass set**, so it stops contributing missed-overpass weight to
   the E-accumulator and cannot freeze it by having a permanently blown freshness budget
   (ADR-002 D6; 14 H1). Historical rows and their uids stay valid forever.
6. **The registry is versioned config-as-data in git** (ADR-002 D5), loaded at startup;
   the `sources` DB table is a projection of it, not the authority.

*Adjudication:* the review layer proposed two conventions — `firms:viirs:snpp`
(02 §5.3) and `VIIRS_SNPP` (03 §5.1.2). This table settles on the namespaced lowercase
form and **supersedes both**: the provider segment keeps the same instrument distinct
when it can arrive through two providers, lowercase ASCII removes case ambiguity, and
the review-03 `MODIS_TERRA`/`MODIS_AQUA` split is derivable only from the CSV column
that rule 2 forbids.

## 1b. `detection_uid` canonicalization — **frozen v1**

`detection_uid = lowercase-hex sha256( source | acq_ts_iso | lat_5dp | lon_5dp )`.
The separator is one ASCII pipe `|`, no surrounding whitespace, no trailing separator;
the pre-image is ASCII bytes (UTF-8-compatible by construction). Any deviation is a
different id for the same physical detection, and the archive cannot be repaired
afterwards — hence every element below is pinned, not "conventional".

1. **`acq_ts_iso` = `YYYY-MM-DDTHH:MM:00Z`**, exactly 20 characters. Built as FIRMS
   `acq_date` + `lpad(acq_time, 4, '0')` — the zero-padding is mandatory, since FIRMS
   delivers `HHMM` without leading zeros (`"142"` = 01:42 UTC, 03 §5.1.1 pitfall 1).
   Seconds are always the literal `00`; the zone is always the literal `Z`. Never a
   local zone, never a numeric offset, no fractional seconds, no basic-format variant.
   Sources that deliver seconds (GEO slot times) are **truncated** toward the minute,
   never rounded.
2. **`lat_5dp` / `lon_5dp` = decimal strings with exactly 5 fraction digits**, rounded
   **half away from zero** (0.000005 → `0.00001`; −0.000005 → `-0.00001`). Sign is `-`
   for negatives and absent otherwise, trailing zeros are kept (`23.10000`), no
   exponent, no grouping separator, and negative zero normalizes to `0.00000`.
   Rounding is applied to the **decimal value as delivered by the source**, parsed as
   decimal — never through a binary float. `toFixed`, `printf("%.5f")` and friends are
   banned *as the specification*: they round the nearest IEEE-754 double, which is
   half-even at the binary level and platform-dependent at the tie. 5 dp ≈ 1.1 m, far
   below any sensor's geolocation accuracy, so the mode never affects clustering — it
   only has to be byte-stable forever.
3. **Exactly one product tier is polled per source** (`NRT` for the polar sources,
   `GEO` for the geostationary ones; the tier in §1a is the whole poll set). FIRMS RT /
   URT tiers are never polled even where offered: FIRMS re-delivers an RT row later as
   NRT with **revised geolocation**, which rounds to different `lat_5dp`/`lon_5dp` and
   therefore mints a **second uid for one physical detection** — duplicate rows that
   dedup cannot catch and that clustering would read as persistence. `SP` never enters
   through the poll loop; it arrives only via the ADR-002 D7 monthly partition-swap
   procedure.
4. **`source` is the §1a canonical id** — never the FIRMS API product name, never a CSV
   column value, never a display name.
5. **One implementation.** The serializer lives in `packages/contracts` and is the only
   code that may produce a uid; a property test asserts byte-stability across
   representative raw CSV rows from every registered source (14 H3, fixture corpus).
6. **Changes are versions, not fixes.** Altering rules 1–4 does not correct old rows —
   it silently re-partitions the archive. A future change means a parallel
   `detection_uid_v2` column, a documented migration, and a new golden-replay baseline.
   There is no in-place edit of this section.

## 2. Alert taxonomy

| Type | Trigger | Quiet hours |
|---|---|---|
| `new_fire` | first alertable detection of an event in a zone | overrides by default (user-changeable) |
| `escalation` | growth / status worsening | respected; folds into digest under suppression |
| `digest` | daily 09:00 summary | n/a |

- Gating: the **system** gate is score **≥ 0.45 (Likely+)** AND (≥2 detections OR 1
  night-time high-confidence detection). A **new zone is created stricter** than that —
  ≥ 0.75 (Confirmed), the recommended position — and the user opts down to 0.45, or to
  0.30 in zone settings only, behind an explicit warning (A1.7). The persistence
  condition is not user-adjustable. GEO detections alone never alert.
- **Zero alerts from a single low-confidence detection** — CI invariant.
- **There is no "resolved"/"safe" notification and never will be** (ADR-004 D4) —
  lifecycle and score downgrades never notify.

## 3. Lifecycle states and the wording ladder

Machine states (ADR-002 D6 — the *only* states; the word **"out" never appears** in
schema, API, or UI):

```
active -> signal_weakening -> no_longer_detected -> archived
                 |                    |
                 +--- (re-detection) -+--> active        [within T_LINK]
   officially_contained / officially_extinguished        [curated sources only]
```

Exact user-facing copy (review 12 §4.3). Templates parameterize the placeholders but
must not paraphrase these strings:

| State | EN copy | BG copy |
|---|---|---|
| `active` | Actively detected — last satellite detection HH:MM | Активно засичане — последно сателитно засичане HH:MM |
| `signal_weakening` (≥2 passes of falling FRP/count) | Weakening satellite signal over the last N passes — fires often re-intensify in the afternoon | Отслабващ сателитен сигнал през последните N наблюдения — пожарите често се разгарят отново следобед |
| `no_longer_detected` (≥N clear-sky expected passes missed) | **No longer detected by satellites since \<date HH:MM\>.** This does not mean the fire is out — satellites cannot see smoldering, burning under trees or through cloud. | **Не се засича от сателити от \<дата HH:MM\>.** Това не означава, че пожарът е изгасен — сателитите не виждат тлеене, горене под короните или през облаци. |
| `officially_contained` (curated) | Declared contained (локализиран) by authorities on \<date\> — source. Containment means spread is stopped; the fire may still burn inside the perimeter. | Обявен за локализиран от властите на \<дата\> — източник. Локализиран означава спряно разпространение; пожарът може още да гори в периметъра. |
| `officially_extinguished` (curated) | Declared extinguished (ликвидиран) by authorities on \<date\> — source. | Обявен за ликвидиран от властите на \<дата\> — източник. |
| `archived` | Event archived: no satellite detections for N days. New nearby detections may reopen it as a possible reignition. | Събитието е архивирано: без сателитни засичания от N дни. Нови засичания наблизо могат да го отворят отново като възможно повторно разгаряне. |

**These are fixed templates in both languages.** The only variable parts are the
placeholders (`<date HH:MM>`, `N`, and the attributed source link); rendered output must
match the string modulo substitution — paraphrase fails CI-11.

The two `officially_*` rows are **not** an instruction to reproduce arbitrary official
prose. The authority's statement is *linked and timestamped*, never pasted into the
state label: free text is unlintable, and unvetted official phrasing must not become our
copy. "Extinguished"/"изгасен" appears **only** in this officially-sourced tier, always
attributed with a link and timestamp.

## 3b. Degraded-state and empty-state copy

The states where the product knows *less* than usual — and therefore where false
reassurance is cheapest to produce. Same contract as §3: fixed templates in both
languages, placeholders only, **in CI-11 scope**.

| Template id | Surface / trigger | EN copy | BG copy |
|---|---|---|---|
| `stale_sources` | Global banner — snapshot `generated_at` past 2× cadence budget, **or** every active polar source past its freshness budget (12 H6) | **Satellite data delayed since HH:MM** — showing the last data we have. The absence of new detections is not evidence that the fire is out. | **Сателитните данни са забавени от HH:MM** — показваме последните налични данни. Липсата на нови засичания не е доказателство, че пожарът е изгасен. |
| `lifecycle_frozen` | Per-event badge while its sources are stale (E-accumulator frozen, ADR-002 D6) | Status not current — status tracking is paused while satellite data is delayed. | Статусът не е актуален — обновяването на състоянието е спряно, докато сателитните данни са забавени. |
| `empty_state` | Map / zone with no detections in the window (§5 rule 4) | No satellite detections in this area. This is not a statement that there are no fires. | Няма сателитни засичания в тази зона. Това не означава, че няма пожари. |
| `freshness_chip` | Global chip + per-event line (07 P2) | Observed \<observed time\> (\<relative age\>) · next update expected ~HH:MM–HH:MM | Засечено в \<час на наблюдение\> (\<изминало време\>) · следващо обновяване ~HH:MM–HH:MM |
| `freshness_chip_unknown` | Same, when the pass predictor has no window | Observed \<observed time\> (\<relative age\>) · next update time unknown | Засечено в \<час на наблюдение\> (\<изминало време\>) · следващо обновяване: неизвестно |
| `cloud_blind_close` | Event closed after ≥14 d with zero detections **and** zero accumulable overpasses (14 H1) | **No observation has been possible for N days** — continuous cloud cover. We do not know whether this fire is still burning: the event is closed because we cannot see it, not because it is out. | **От N дни наблюдение не е било възможно** — постоянна облачност. Не знаем дали пожарът още гори: събитието е затворено, защото не можем да наблюдаваме, а не защото пожарът е изгасен. |
| `official_then_redetected` | Satellite detections arriving after an official локализиран/ликвидиран statement (14 H2) | New satellite detections on \<date HH:MM\>, after the fire was declared \<contained\|extinguished\> by authorities on \<date\> — source. Both facts are shown as they stand. | Нови сателитни засичания на \<дата HH:MM\>, след като пожарът беше обявен за \<локализиран\|ликвидиран\> от властите на \<дата\> — източник. Показваме и двата факта; не преценяваме кой от тях е меродавен. |

**Rules:**

- **The freshness chip is a promise about the user, not the satellite.** The
  `~HH:MM–HH:MM` range is when we expect the *user* to know more (pass predictor +
  typical NRT/GEO lag), never a claim that an overpass will happen or that it will see
  anything. When the predictor has no window, render `freshness_chip_unknown` — never
  a guessed range, never a hidden chip.
- **One degraded slot.** The stale banner occupies a single strict-priority slot
  (ADR-003 D2, 08 §5.6); the user learns *how old the data is*, never *which transport
  tier they are on*. Two simultaneous banners is a visual-regression failure, not a
  styling preference. **One source being late is a layers-panel dot, not a banner**
  (08 §5.6 priority 4); the banner is reserved for the case 12 H6 is actually about —
  when we have lost *observation capability*, not one feed. Both paths use the same
  string; only the trigger differs, so an operator can never be tempted to invent
  softer copy for the smaller outage.
- **`official_then_redetected` never adjudicates.** No "the authorities were wrong", no
  "the fire was not actually contained", no comparative framing at all — both facts,
  both timestamps, both sources. On the alert side this copy may ride an `escalation`
  (a status worsening) and never a `new_fire`: the zone has already been notified about
  this event (ADR-004 D3).
- **Amendment dependency:** `cloud_blind_close` and `official_then_redetected` describe
  transitions that ADR-002 D6 does not yet contain (14 H1, 14 H2 propose them). The
  strings are frozen here so the CI-11 fixture corpus can be authored ahead of the ADR
  amendment; they render only once that amendment lands.
- **Every string in §3 and §3b is an allowlisted exception to CI-10** (§5.1): several
  of them contain banned vocabulary *inside an explicit negation*, which is exactly what
  makes them honest. The allowlist is keyed by template id and matches the whole string.

## 4. Official Bulgarian fire-status terms (quote-only)

| Term | Official meaning | Our usage rule |
|---|---|---|
| **локализиран** (localized/contained) | Spread has been stopped; the fire is **still burning** and frequently re-escalates (Sakar 2025). | Only when quoting an official statement, mapped to `officially_contained`, never in our own voice. |
| **ликвидиран** (extinguished) | Burning has ceased **and** reignition is excluded; only the fire authority declares it. | Only when quoting an official statement, mapped to `officially_extinguished`, never in our own voice. |

Getting these two words wrong is a domain-credibility failure: локализиран does
**not** mean the fire is over, and our UI must never imply it does.

## 5. The never-send list (12 §3.4 — 8 hard rules, enforced as CI lint)

Text that must never leave the system in our own voice, on any channel:

1. Any form of **"all clear"**, "safe", "safe to return", "danger passed".
2. **"Extinguished"/"изгасен"/"потушен" from our own data.** Only quoted official
   statements, attributed with link + timestamp.
3. **"Evacuate" / "prepare to evacuate" in our own voice.** We may relay an official
   order verbatim, attributed; push copy leads with the authority's name and links
   BG-ALERT / the municipal source.
4. **"No fires in your area" as reassurance.** The empty state says "no satellite
   detections", never "no fires".
5. **Directional predictions** ("heading for X"). Wind context yes; trajectory no.
6. **"Firefighters are (not) on scene"** unless quoting an official/media source,
   attributed.
7. Anything that **sends people toward a fire** (including "verify and report back").
8. **Health advice** beyond generic, sourced smoke guidance.

Banned-vocabulary list for the lint (own-voice contexts). EN: *out, all clear, safe,
safe to return, danger passed, extinguished, put out, under control, contained\*,
evacuate, prepare to evacuate, heading for, arson*. BG: *изгасен, изгаснал,
изгасване, изгасяване, потушен, потушаване, овладян, обезопасен, ликвидиран\*,
ликвидиране\*, локализиран\*, локализиране\*, евакуация, евакуирайте, подгответе се
за евакуация, палеж, „няма опасност“, „опасността премина“, „безопасно е“, „можете
да се върнете“, „пожарникарите са на място“, „пожарът се насочва към“*.
(\* = allowed only inside an attributed official quote / the curated `officially_*`
templates; see §5.1 for how the exemption is decided.)

Every alert footer carries: the source-attribution line, the LANCE-mirrored "not for
tactical decision-making" disclaimer, and the scope sentence "best-effort
informational monitoring — in an emergency call 112" (ADR-004 D7).

### 5.1 CI-10 lint specification

CI-10 is a *never-send* gate, not a style check: a violation blocks the merge. Its
behaviour is pinned here because "grep for bad words" both misses the real failures
and blocks the honest strings in §3/§3b.

1. **Input is rendered output, not source.** The lint renders every template id in
   §3, §3b, §5.2 and the alert/push/OG builders against a fixture set of events
   (each lifecycle state × each locale × the truncated push variant) and lints the
   *rendered* strings. Template source is linted too, so a banned word cannot hide
   in a branch no fixture reaches — but a template that renders clean and reads
   dirty is a false positive, and vice versa is the failure that matters.
2. **The rule.** A string fails when
   `banned(text, locale) AND NOT allowlisted(template_id, span)`.
   Both halves are required: the banned list alone would reject the §3/§3b strings
   that exist precisely to negate those words.
3. **Matching.** NFC-normalize, casefold, then match on **Unicode word boundaries**
   (`\b`-equivalent over the Cyrillic range), never substring: `out` must not fire on
   *outbox*, *about*, *layout*, *timeout*, *burnout*; `safe` must not fire on
   *safety* in the disclaimer footer. Multi-word entries match across a single run of
   whitespace, ignoring intervening punctuation.
4. **Bulgarian morphology.** BG entries are stored as **lemmas plus a generated
   inflection set**, not as literals: gender/number/definite forms
   (изгасен/изгасена/изгасено/изгасени/изгасеният), participles (изгаснал), and the
   verbal nouns (изгасване, изгасяване, потушаване, ликвидиране, локализиране) all
   match their lemma's rule. A new banned lemma ships with its inflection fixtures;
   the inflection table is data in `packages/contracts`, not a regex in the linter.
5. **Own-voice vs quoted context.** The quoted-context exemption applies **only** to
   never-send rules 2, 3 and 6 (extinguished/локализиран/ликвидиран, an evacuation
   order, firefighter presence) and **only** when the rendered span carries both a
   `source_url` and a `statement_ts` in the same template. There is no exemption,
   ever, for rules 1, 4, 5, 7 and 8 — "all clear", "no fires in your area",
   directional predictions, come-and-look copy and health advice are banned even
   inside a quote, because a quoted all-clear is still an all-clear on our surface.
6. **Allowlist granularity.** Allowlist entries are `(template_id, exact string)`
   pairs over whole frozen strings, never per-word. One character of drift loses the
   allowlist, so a paraphrase of a §3/§3b string fails CI-10 *and* CI-11 at once —
   that coupling is the point.
7. **Fixture corpus.** The gate ships with a good-must-pass / bad-must-fail corpus:
   the honest negations from §3/§3b on the pass side; on the fail side at minimum
   "the fire is out", "пожарът е изгасен", "no fires in your area", "няма пожари във
   вашия район", "safe to return", "можете да се върнете", "heading for Ivaylovgrad",
   "евакуирайте се", plus one paraphrase of each §3 string.
8. **Same code path at runtime.** The gateway calls the same function before send
   (ADR-004 D7): CI-10 is the build-time run of a runtime guard, so a hotfixed
   template cannot bypass it.

### 5.2 Additional lintable copy contracts

Alongside the never-send list, these are positive obligations — each is a template
id with fixed EN/BG copy, in CI-11 scope and allowlisted for CI-10 where needed.

| Template id | Rule | EN copy | BG copy |
|---|---|---|---|
| `safety_no_travel` | **Mandatory line on every event page and every new-fire / escalation alert** (12 H2). | Do not travel toward the fire area — keep roads clear for responders. | Не пътувайте към района на пожара — пазете пътищата свободни за спасителните екипи. |
| `agri_burn_tag` | Context tag when the detection footprint falls on cropland (12 H4) and persistence is low. | Cropland — possible agricultural burn. | Земеделска земя — възможно селскостопанско палене. |
| `defer_road_closures` | Road status is **always deferred**, never asserted. | Road status: check the police / АПИ (link). | Състояние на пътищата: проверете при полицията или АПИ (връзка). |
| `area_both_units` | Area is always rendered in both units, дка first for BG readers. | ~320 ha (3 200 дка) | ~3 200 дка (320 ha) |

**Supporting rules:**

- **No routing, ever.** `safety_no_travel` is paired with a hard product rule: no
  directions, no "route around", no drive-time, no navigation deep-links, no
  nearest-road callouts. Any feature that would compute a path to or past an event
  is out of scope by definition, not by backlog priority.
- **The centroid is not a pin** (12 H2). Maps render the event as centroid +
  uncertainty area, never a road-snapped marker and never a house-level address; past
  roughly 1:25k the surface switches to the **detection footprint** rather than
  sharpening a point that would read as "go here". A permalink or OG card shows the
  same footprint, not a pinned coordinate.
- **`agri_burn_tag` is probabilistic and styled as such:** muted, secondary, never a
  headline, never the word "controlled" (we cannot know that it is). Tagged events
  render on the map but are suppressed from default zone alerts while persistence is
  low; a second qualifying pass promotes the event to normal handling and drops the
  tag (ADR-004 D4).
- **Both-units rule** (12 H8): 1 ha = 10 дка. It applies everywhere a number is shown —
  alerts, event page, embeds, permalinks, OG cards, press exports — because the
  single-unit variant is exactly what gets screenshotted out of context. Areas are
  rounded to two significant figures and prefixed `~`; the burned-area figure is
  always attributed to its source and never presented as measured by us.
- **Defer-always list (12 §3.3)** — four classes of statement we never make in our own
  voice, only link:
  1. **Evacuation and all-clear / return decisions** — mayor, governor or police only.
  2. **Suppression status** (локализиран/ликвидиран) — ГДПБЗН statements only, quoted
     with source and timestamp (§4, §3 `officially_*`).
  3. **Road closures** — police / АПИ. `defer_road_closures` is the only string we own
     here; we link, we never assert a road is open or closed.
  4. **Cause attribution** — never. "Arson"/"палеж" is criminal-investigation
     territory: the word never appears in our own voice, **there are no cause fields
     anywhere in the schema**, and we publish no commentary on response quality or
     mop-up adequacy (§6, 12 H9). This applies identically to archive and
     retrospective pages, where the temptation is strongest and the exposure the same.

## 6. Reignition windows (12 §4.4)

| Fuel / size | Window |
|---|---|
| Grass / agricultural, or event < 100 ha | 7 days |
| Shrub / mixed, or 100–1,000 ha | 14 days |
| Forest > 1,000 ha, or conifer / high-duff (smolder risk) | 21–30 days |

Over 90% of Bulgarian fires are human-caused: reignition copy never implies
inadequate mop-up by firefighters (the Slavyanka lawsuit precedent).

## 7. FWI danger classes (EFFIS-harmonized, 12 §5.1)

| Class | FWI |
|---|---|
| Very low | < 5.2 |
| Low | 5.2 – 11.2 |
| Moderate | 11.2 – 21.3 |
| High | 21.3 – 38.0 |
| Very high | 38.0 – 50.0 |
| Extreme | ≥ 50 |

FWI is a ~8 km **weather** index. Copy renders it as "danger level today", never as
"fire expected here".

## 8. Correctness metrics (ADR-004 D9, review 06 §5.1.2, review 11 §5.8)

All metrics are computed **per calendar week in season**, over the full AOI and
per-zone where noted, by the weekly QA report job; the continuous ones are also live
dashboard series. There is no authoritative real-time ground truth for "there is a fire
at X", so each truth proxy is biased in a known direction and the set triangulates
(06 §5.1.1).

**Alertable event** — a FireEvent that meets the **default-sensitivity** gating of
ADR-004 D4: score **≥ 0.45** AND (**≥ 2 detections** OR **1 night-time high-confidence
detection**), GEO-only never qualifying — *regardless of whether any user zone actually
matched*. Every metric below that says "alertable" uses this population, so event-level
precision does not move with how many users happen to exist.

| Abbr | Name | Formula | Truth source | Cadence | Target |
|---|---|---|---|---|---|
| **PCR** | Perimeter Coverage Rate (recall proxy) | Of EFFIS BA perimeters ≥ N ha intersecting the AOI, the fraction for which **a FireEvent exists** whose detections intersect the perimeter buffered by **2 km** and whose `started_at` ≤ perimeter end date. Report N = 50 and N = 10. **Event-based**: counted per perimeter covered, never per alert dispatched. | EFFIS BA | weekly, retro | ≥ 95% (N = 50), ≥ 85% (N = 10) |
| **CER** | Corroborated Event Rate (precision proxy) | corroborated alertable events ÷ all alertable events, where corroboration is within 7 d by ≥1 of: (a) EFFIS BA overlap as in PCR, (b) ≥2 further detections in later overpasses, (c) a curated news-log entry within **5 km / ±1 d**. | all three | weekly, retro | ≥ 80% |
| **ZAP** | Zone Alert Precision | dispatched alerts whose triggering event is corroborated (CER rule) ÷ all dispatched alerts. The user-experienced precision. | all three | weekly, retro | ≥ 85% |
| **DAR** | **Duplicate** Alert Rate | alerts repeating the same `(zone, event, alert_type)` semantic content within the suppression window ÷ total alerts dispatched. Merge/split re-notifications count as duplicates **unless** they carry an escalation. | own logs | continuous | ≤ 5% shadow → ≤ 1% steady |
| **FLR** | Flapping Lifecycle Rate | events with **≥ 3 lifecycle direction reversals within 48 h** ÷ active events. High FLR predicts duplicate alerts and UX distrust. | own logs | continuous | flag + review (no numeric gate) |
| **FER** | False Extinguish Rate | events that re-attach a detection **within 72 h** of entering `no_longer_detected` ÷ events entering `no_longer_detected` in the window — i.e. the declaration was premature. Computable on backfill by replaying the rule, and continuously in production; it is the **fitting objective** for the E weights and E_min, not just a dashboard number. | own logs / replay | continuous + on backfill | ≤ 5% overall, ≤ 10% large-event class |
| **PLB** | Pipeline Latency Budget compliance | p50/p95 per stage from the recorded stage timestamps — stage table below. | own logs | continuous | total ≤ 15 min p95 |

- **Large-event class** (FER ≤ 10%, and the E ≥ 5.0 threshold): hull ≥ 100 ha OR
  `max_frp` ≥ 100 MW OR peat/landfill fuel (ADR-002 D6). One definition, both uses.
- **FER is the canonical name.** ADR-002 D6 and GATES §2 previously called the same
  quantity the "false-event-resurrection rate"; both now read FER. It is one metric with
  one row, and "resurrection rate" is no longer used anywhere.
- **DAR expands to Duplicate Alert Rate** (06 §5.1.2). ADR-004 D9 previously glossed it
  as "dubious-alert rate" and now reads the canonical expansion; thresholds were not
  touched by the naming fix.

### 8.1 PLB stage budgets (the part we control)

| Stage | Timestamps | Budget (p95) |
|---|---|---|
| Source row available → ingested | `available_at`* → `ingested_at` | ≤ poll interval + 2 min (≤ 12 min at 10-min polling) |
| Ingested → event created/updated | `ingested_at` → `event_updated_at` | ≤ 60 s |
| Event updated → alert decision | `event_updated_at` → `decided_at` | ≤ 10 s |
| Alert decision → provider ack | `decided_at` → `provider_ack_at` | ≤ 60 s push, ≤ 5 min email |
| Event updated → SSE broadcast sent | `event_updated_at` → broadcast | ≤ 2 s |
| **Total controllable, detection row → push ack** | | **≤ 15 min p95** |

\* `available_at` is approximated as the poll time of the first poll that returned the
row. **Upstream source latency (`acq_ts` → `available_at`, up to ~3 h for FIRMS NRT) is
measured and displayed honestly but never budgeted** — it is not ours to control, and
it is the number behind the freshness copy in §3b.
