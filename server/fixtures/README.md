# Golden-replay fixtures

Every directory here is one scenario from the register in `docs/GATES.md` §1.1. A fixture
is checked-in data, not code: it records what the satellites handed us and what the system
must conclude from it, so that a change in the clustering engine either reproduces those
conclusions or explains itself.

## Layout

```
<fixture-id>/
  manifest.json     what the scenario is, and everything the replay must be pinned to
  poll-01.json      one poll, in the order it arrived
  poll-02.json
  observations.json optional — what else was true while the satellites looked
  expected.json     the outcomes the scenario asserts
```

## `manifest.json`

| Field | Why it exists |
|---|---|
| `id` | `S1`…`S16` for the register; a local name for harness-only fixtures. |
| `title`, `asserts` | One line each, printed when the fixture fails. |
| `required` | `pre-merge`, `pre-season` or `suite` — the "Required" column of GATES §1.1. The gate reads this field. |
| `owner` | The work package that maintains it. |
| `engine` | Which engine replays it — `identity` (the real clustering/merge/reignition path), `alert` (that same path with the D9 alert gate wired behind it) or `smoke` (the harness placeholder). Declared, never inferred: `harness-smoke` has to keep running against the placeholder after the real engine exists, and an identity fixture is never asked to pin a gating config it does not exercise. |
| `clockStart` | The virtual clock's start instant. Without it the fixture means something different on the day CI runs it. |
| `mode` | `live` (forward replay) or `offline` (reprocessing/backfill). An `offline` fixture that emits an alert fails — that is gate CI-6. |
| `allowRevive` | Reviving an archived event on a replay has to be said out loud (invariant I4). |
| `configVersions` | Parameters are versioned data (ADR-002 D5). A fixture that does not pin them silently changes what it asserts the next time someone tunes `eps`. The key is the config's own `name` — `clustering_params`, not `clustering` — and the engine refuses to run against a version it was not pinned to. |
| `inputs` | Poll files, in arrival order. Plain file names — no paths. |
| `expected` | The expectations file. |
| `observations` | Optional. The observation-context file — cloud, source outages, official statements, and (for an `alert` fixture) the zones watching and the scores in force. Without it a fixture can only say what the satellites delivered, so the scenarios that turn on what we could *not* see cannot be written down. Omit it where the scenario asserts nothing of the sort. |

## Poll files

```json
{
  "availableAt": "2026-08-02T11:41:00Z",
  "detections": [
    {
      "detectionUid": "<sha256 hex>",
      "source": "firms:viirs:snpp",
      "acqTsIso": "2026-08-02T11:24:00Z",
      "latCanonical": "41.85012",
      "lonCanonical": "26.14003",
      "confidence": "nominal",
      "frpMw": 12.5,
      "dayNight": "D"
    }
  ]
}
```

`availableAt` is when **we** could first have seen the row, not when the satellite observed
it — the latency between the two is what several scenarios are about. A row may carry its
own earlier `availableAt`; it may never be later than the poll that returned it.

Coordinates are canonical 5-decimal text, never floats: they are part of the
`detection_uid` pre-image (GLOSSARY §1b) and a float would reintroduce the formatting
question the canonical form exists to close.

An empty `detections` array is legal and meaningful — a poll that succeeds and returns
nothing is a healthy poll.

### Editing a row means recomputing its id

`detection_uid` is `sha256(source | acq_ts_iso | lat_5dp | lon_5dp)`. Nudging a coordinate
without recomputing the digest produces a fixture that asserts something which cannot
happen in production, so the loader recomputes every id and refuses the fixture on a
mismatch. Use `detectionUid` from `@fire-watch/contracts/node`.

The order rows appear in the file does **not** matter: the runner sorts every batch by the
fixed key `(available_at, source, lat, lon, detection_uid)` before the engine sees it.
`harness-smoke/poll-01.json` is deliberately written out of that order to keep the point
visible.

## `observations.json`

A tick is not a function of detections alone. It also reads the sky, whether each source
was inside its freshness budget, and whether an authority has said anything — and a
fixture that cannot state those cannot express S7's cloudy gap, S8's transient outage or
S12's re-detection after an official extinguishment. An `alert` fixture states two more
things, because the gate cannot be replayed without them: who was watching, and how sure
we were.

```json
{
  "cloudCover": [
    { "fromIso": "2026-08-03T00:00:00Z", "toIso": "2026-08-06T00:00:00Z", "percent": 10 }
  ],
  "outages": [
    { "source": "firms:viirs:noaa20", "fromIso": "2026-08-03T00:00:00Z", "toIso": null }
  ],
  "declarations": [
    {
      "detectionUid": "<sha256 hex>",
      "state": "officially_extinguished",
      "declaredAtIso": "2026-08-05T09:00:00Z",
      "attribution": "ГДПБЗН, РДПБЗН Хасково"
    }
  ],
  "zones": [
    {
      "zoneId": "zone-svilengrad",
      "accountId": "acct-01",
      "createdAtIso": "2026-08-20T04:00:00Z",
      "minScore": 0.45,
      "timezone": "Europe/Sofia",
      "quietHoursStart": "22:00",
      "quietHoursEnd": "07:00",
      "newFireOverridesQuietHours": false,
      "distanceKm": 3.2
    }
  ],
  "scores": [
    { "detectionUid": "<sha256 hex>", "fromIso": "2026-08-20T03:20:00Z", "score": 0.82 }
  ]
}
```

All five arrays are optional and default to empty. An unknown top-level key is refused
rather than ignored, unlike in the manifest: every field the manifest reads is required,
so a typo there fails loudly on what it displaced, whereas a typo'd `"clouds"` here would
read as "no cloud at all" and leave the fixture green while asserting the opposite of what
its author wrote.

`toIso: null` is an outage that is still open. `attribution` is the authority's own name,
rendered to the user as it writes it, and may not be empty — an unattributed official
statement is exactly the thing the product may never show.

`zones` and `scores` are read only by the `alert` engine, and both are inputs to the gate
rather than outcomes it decides:

- A **zone** is compared against the other zones of its own `accountId` and no one else's,
  because "the nearest of my zones" is a statement about one person's zones (ADR-004
  A1.7/A1.12). `createdAtIso` is when it was drawn: the gate is not evaluated for it before
  that instant, and the first evaluation at or after it is the silent seeding one (A1.8),
  which is the whole of S13. `distanceKm` is stated per zone because nothing in the repo
  computes zone geometry yet, and `zoneId` must be unique — a zone id is its state key.
- A **score** names its event by a detection the event holds, since public ids are minted
  at replay time. It takes effect at `fromIso` and holds until the next entry, so a fixture
  raises a score by adding a row rather than by editing history, and an event that absorbed
  a scored one inherits the score — which is what the merge said. Nothing in the repo
  computes a score yet (ADR-002 D6), so an event no entry names is skipped by the gate
  instead of being handed a default: an event that alerts because the harness invented 0.8
  for it would assert the harness, not the gate. For the same reason a stated score never
  appears in `expected.json` — `bucket` stays `null` throughout.

Three things a fixture author gets wrong first:

- **An hour no span covers is *unknown* sky, not clear sky.** A pass in such an hour is
  recorded as `cloud_blocked` and accumulates nothing at all, so leaving a day out of
  `cloudCover` silently switches off the evidence the scenario is about. It reads like a
  harmless omission and is not one. Declare the clear days too, as spans with a low
  `percent`.
- **Cloud is written as half-open spans, and both bounds must be exact UTC hour starts.**
  `2026-08-03T00:00:00Z`→`2026-08-06T00:00:00Z` expands to one hourly sample per hour in
  between, three days' worth, and the closing bound belongs to the next span. The
  accumulator indexes cloud by the hour a sample starts and *requires* the alignment
  rather than rounding to it, so a bound at 11:30 would produce samples nothing ever looks
  up. Spans may not overlap — the file is meant to read as a partition of the fixture's
  time, so "which reading applies at 14:00" has one answer that does not depend on the
  resolution rule buried in the accumulator — and the expansion is capped at 960 hours
  (40 days), which is what turns a mistyped year into an error instead of a hang.
- **A declaration names its event by a `detectionUid`, not by a public id.** Public ids are
  minted during the replay, so a fixture cannot know them in advance; the loader resolves
  the uid to the event that holds it, and refuses a uid no poll delivers. Without that
  check a mistyped id would name an event that never exists and the declaration would
  silently do nothing — S12 would report a re-detection after an extinguishment that was
  never declared, and pass.

## `expected.json`

Outcomes only — public ids, lifecycle states, score buckets, which detections ended up on
which event, which alerts fired and in what order. Never cluster internals or counters: a
fixture that asserts internals stops being a regression test and becomes a change-detector
that fails on every refactor.

`alerts` records *every* decision the gate reached, not only the sending ones — zone, event,
`outcome` (`send`, `defer`, `seed` or `suppress`), the `reason` in the gate's own vocabulary,
the alert type and subkey where one applies, and the instant it was decided. A report that
listed only sends could not tell "seeded, correctly silent" apart from "the gate never ran",
which is the one distinction S13 exists to make. The order is not sorted — alerts appear in
the order the engine emitted them, deliberately: `runner.ts:202` says so in as many words,
because "which alert fired first" is itself an outcome S13 and S14 assert, so emission order
is part of the answer. A fixture's `alerts` array must never be re-sorted to look tidier;
doing so would erase the fact under test.

One thing the alert engine still cannot be asked to assert, and the reason is a replay has no
outbox: `lastNotified` is therefore always empty, so escalation-ladder rungs 1 (score upgrade)
and 2 (area doubling), which read the message the user received, can never hold in a fixture;
only rung 3 — lifecycle worsening and reignition, which read the event — is reachable. The
digest floor is no longer among these gaps: `produceDigest`
(`server/src/core/alerts/digest.ts`, configured by `digest-params.ts`'s `digest_params_v1`)
folds a poll's deferrals into one row per account per window, run as a second pass in the
`alert` replay engine after every event has been decided — which is what S14 pins and what
S13's three digest rows now show for a single window.

## Score buckets

Every event a replay reports now carries an ADR-002 D6 bucket, computed by
`server/src/core/scoring/` from the review 11 §3.5 hand-set logistic. Fixtures pin
`score_params_v0` for the same reason they pin the clustering and lifecycle parameters:
a bucket recorded under one set of weights asserts nothing under another, and the identity
engine refuses a fixture that does not name the version it was authored against.

Every value below was computed **by hand** — from §3.2's `c_i` table and §3.4's feature
definitions, against the detections in each fixture's poll files — *before* the engine was
run, and the engine then reproduced all fourteen. That order is the point: a bucket
back-filled from the implementation would assert that the implementation is
self-consistent, which is not a claim worth a gate.

| fixture | event | `x_best` | `x_persist` | `x_multisrc` | `x_night` | `x_coherence` | `x_frp` | `x_glint` | z | score | bucket |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `S1` | `fw-2026-gawn4` | 0.95 | 0 | 0 | 1 | 0 | 0.7716 | 0 | +0.795802 | 0.689076 | **Likely** |
| `S2` | `fw-2026-k1skj` | 0.95 | 0.66667 | 1 | 1 | 0 | 0.90283 | 0 | +2.328081 | 0.911176 | **Confirmed** |
| `S5` | `fw-2026-rpzna` | 0.25 | 0 | 0 | 0 | 0 | 0.37329 | 1 | −2.163356 | 0.103090 | **Unverified** |
| `S6` | `fw-2026-snbr9` | 0.95 | 0 | 0 | 1 | 0 | 1 | 0 | +0.910000 | 0.713000 | **Likely** |
| `S6` | `fw-2026-xpdh4` | 0.65 | 0 | 0 | 0 | 0 | 0.90781 | 0 | −0.376095 | 0.407069 | **Unverified** |
| `S7` | `fw-2026-kttp6` | 0.8 | 0 | 0 | 1 | 0 | 0.56395 | 0 | +0.421974 | 0.603956 | **Likely** |
| `S8` | `fw-2026-d47tv` | 0.8 | 0 | 0 | 1 | 0 | 0.64027 | 0 | +0.460134 | 0.613046 | **Likely** |
| `S9` | `fw-2026-j1eyd` | 0.95 | 0.33333 | 0 | 1 | 0 | 0.86069 | 0 | +1.173677 | 0.763809 | **Confirmed** |
| `S11` | `fw-2026-8eqb7` | 0.7 | 0 | 0 | 1 | 0 | 0.68313 | 0 | +0.301566 | 0.574825 | **Likely** |
| `S12` | `fw-2026-0wdnz` | 0.8 | 0.33333 | 0 | 1 | 0 | 0.82959 | 0 | +0.888127 | 0.708503 | **Likely** |
| `S13` | `fw-2026-7x4ng` | 0.9 | 0 | 0 | 0 | 0 | 0.97477 | 0 | +0.107387 | 0.526821 | **Likely** |
| `S13` | `fw-2026-cvwdt` | 0.95 | 0 | 0 | 1 | 0 | 0.8991 | 0 | +0.859551 | 0.702567 | **Likely** |
| `S13` | `fw-2026-ewnpa` | 0.95 | 0 | 0 | 1 | 0 | 0.85698 | 0 | +0.838492 | 0.698147 | **Likely** |
| `S16` | `fw-2026-yhrxz` | 0.95 | 0.33333 | 0 | 1 | 0 | 0.8109 | 0 | +1.148785 | 0.759289 | **Confirmed** |

Four features are **structurally zero in every row**, and each absence has a direction:

- `x_fwi` — the fixture format states no fire-weather index, so no event is credited for
  burning under high FWI. Withholding credit is the safe direction.
- `x_agri` — no arable-majority statement either, so no event is *penalised* for sitting on
  farmland. This one errs the unsafe way: a real agri-burn would score higher here than it
  should, which is exactly why **S3 stays blocked**.
- `x_edge` — poll rows carry no `scan`/`track` footprint, so every pixel resolves to its
  source's nadir size and none is ever at swath edge.
- `x_glint` — reachable, and `S5` is the row that reaches it: all of its detections are
  daytime *and* low-confidence, which is the whole −0.8. Nothing in these fixtures triggers
  the static hot-source override, so `staticSourceMaskHit` is `false` rather than unknown —
  the reason **S4 stays blocked** even though the score itself exists.

The two boundary rows are worth knowing about before editing a poll file: `S9` at 0.763809
and `S16` at 0.759289 clear the 0.75 Confirmed floor by roughly one and a half hundredths.
Dropping either fixture's peak FRP by a factor of three would move it to Likely.

A merge tombstone reports `"bucket": null` and always will. Scoring an empty member list is
not "Unverified", it is undefined, and `scoreEvent` refuses it outright.

## Running them

```sh
pnpm --filter @fire-watch/server run build
node server/dist/adapters/fixtures/replay-cli.js                     # the whole register
node server/dist/adapters/fixtures/replay-cli.js server/fixtures/S2  # one fixture
node server/dist/adapters/fixtures/replay-cli.js --gate=pre-merge    # what CI runs
```

`pnpm --filter @fire-watch/server run replay [args]` is the same thing without the
`dist/` path. Note that it runs with `server/` as the working directory, so a fixture
argument is `fixtures/S2`, not `server/fixtures/S2` — and pnpm forwards a bare `--`
to the script rather than swallowing it, so write `run replay --gate=pre-merge`. The
node form above is what CI runs, and is the one to quote in a bug report.

The command prints one canonical JSON document on stdout and exits non-zero if any
fixture's outcomes differ from its expectations. CI runs it twice, in two processes under
different `TZ` and locale settings, and diffs the bytes — that is gate CI-2.

`--gate=<stage>` adds gate CI-1 on top: the register in `register.ts` is GATES §1.1 as
data, and the flag holds the run to it. Every scenario that stage demands must have a
directory, and a directory claiming an `S<n>` id the register does not define fails too —
a fixture cannot be quietly renamed out of the gate's sight. Everything the gate prints
goes to **stderr**, so it never enters the CI-2 byte diff.

Both streams go through the process log sink, and they are not symmetrical. Stderr is
canonical-JSON records — `replay_fixture_failed`, `replay_gate_problem`,
`replay_gate_blocked` — so a CI log is greppable by field rather than by prose. Stdout
keeps its exact bytes, because the report *is* the CI-2 diff; it only passes the
redactor, which cannot disturb it (the shape leg looks solely inside URL-like substrings,
which is exactly why it leaves `detection_uid`s alone).

## What is here, and what is not

| | |
|---|---|
| `S1` | Slavyanka border-crossing — four VIIRS pixels chain across the BG/GR ridge into one event, and the border pixel re-delivered by the second country download does not seed a second one. Adjacent hops are 1.139 km (inside `eps`), the ends 3.342 km apart: the event exists *only* because of single-link chaining. |
| `S2` | Sakar/Harmanli merge — two fronts 2.159 km apart become two events, then a bridging pixel 1.080 km from each proves they were one fire. The older event survives; the absorbed public id stays alive as a tombstone pointing at it (invariants I1, I3). |
| `S5` | Single-detection noise — one uncorroborated low-confidence MODIS pixel. Both halves are asserted now: one event and no alert, and a score of 0.103090 that leaves it **Unverified**. The pixel is daytime and low-confidence, so it also takes the −0.8 glint penalty; it is the only row in the set that does. |
| `S6` | Megafire cooling + reignition — a 180 MW fire cools for a day and a half under broken cloud. E reaches 3.5: past the ordinary closing bar, short of the large-event one, so the event weakens rather than closing. The detection that returns 60 h later is past `T_LINK`, so it seeds a second event carrying a `possible_reignition` relation back to the first. |
| `S7` | Cloudy gap — two days of unbroken 90 % cloud accrue no miss evidence at all, and a third day at 60 % accrues half weight. E reaches 2.25: enough to weaken, never enough to close. |
| `S8` | Transient source outage — the three VIIRS feeds are out for 44 h and their overpasses weigh nothing while they are. SLSTR alone only weakens the event; the first poll after recovery closes it, and the fixture ends inside the 48 h map window that close opened. |
| `S9` | UTC/DST ingest boundary — a Strandzha fire burning across the 25 October EEST→EET fold. The two overpasses that read **03:30 local** are an hour apart in UTC (00:30Z and 01:30Z) and stay in that order; the pixel re-delivered after the fold does not seed a second event. Eight pixels chained at ≤ 0.923 km hops over a 6.365 km span. |
| `S11` | Source retired mid-replay — the only feed that ever saw this fire is MODIS, retired the morning after. The surviving VIIRS and SLSTR overpasses still weigh misses, so the event closes on schedule and ages out of the map window instead of sitting active on a feed that no longer flies. |
| `S12` | Re-detection within `T_LINK` after `officially_extinguished` — the fire service declares the fire out and a satellite sees it again 35 h later. The same event returns to `active` carrying both detections, rather than a second event being minted as a new fire. |
| `S13` | Zone created over an active event — the first evaluation of a freshly drawn zone seeds every fire already burning under it, silently: two events at 05:20Z for the near zone, three at 07:20Z for the one drawn two hours later, zero messages between them. The next fire the near zone sees alerts normally, while the two it seeded stay quiet for want of a ladder step — until the poll's 09:00 digest, which folds all three of the near zone's events, the new fire included, into one row apiece under the shared window-start subkey `2026-08-20T06:00:00Z`, rendered from `zone-svilengrad` because it is the nearer of the account's two zones. Seeding is per zone, so a fire twenty minutes old is still pre-existing to a zone drawn after it. |
| `S14` | Alert decisions at 03:30 local, 25 Oct 2026 / 28 Mar 2027 — two zones on two accounts, `zone-strandzha-a`/`acct-01` and `zone-strandzha-b`/`acct-02` (only the second lets a new fire override quiet hours), watch nine probe instants across both `Europe/Sofia` transitions; each probe gets a fresh event whose two night pixels were acquired 15 minutes before the poll, so the 30-minute `stale_trigger` TTL never fires and the fixture is free to test quiet-hours arithmetic alone. Fourteen polls produce 154 alert rows, including the two trap instants no fixed UTC offset can classify together — `2026-10-25T04:00:00Z` and `2027-03-28T04:00:00Z` — and four digests, one per 09:00-local poll, keyed by window start `2026-10-24T06:00:00Z`, `2026-10-25T07:00:00Z`, `2027-03-27T07:00:00Z` and `2027-03-28T06:00:00Z`: 25 hours apart across the fall-back day, then 23 apart across the spring-forward one. |
| `S16` | Fire straddling the polling-bbox edge — six pixels at 41.90 N step east over the alertable edge (29.8849° E), three on each side, 0.830 km apart. One event holding all six: the polled box reaches 90 km past that edge, so the boundary can hand the fire neither a second identity nor a truncated geometry. |

The register defines S1–S16. The rest are not missing by neglect — each is blocked on work
that does not exist yet, and `--gate` prints exactly which, on every run:

- **S3, S4** need D10's land-cover and static-hot-source masks: no event carries a label,
  and the two score inputs these two scenarios turn on — the arable-majority feature and
  the static hot-source mask hit — have no field in the fixture format, so the engine
  supplies `null` and `false`. The score itself is no longer the blocker; its inputs are.
- **S10** needs D10's day-only repeat quarantine rule, which has no implementation.
- **S15** needs the WP3 read path.

The gate demands a scenario the moment its blocker clears, so those lines are a to-do
list that cannot go stale.

## `harness-smoke`

Not a scenario. It exercises the harness itself — virtual clock, fixed batch order,
canonical report — against a placeholder engine that groups detections by coordinate and
mints ids in the order it first sees them. It stays after WP2 lands, because it is the
fixture that fails when the *harness* breaks rather than when the clustering does.

## Fixture-refresh policy (shadow diffs)

A candidate rule set — clustering, scoring or gating — shadows live before it is
promoted (TASKS H8; 06 §5.7; GATES L-1). It writes to `events_shadow`/`alerts_shadow`,
never dispatches, and `server/src/app/shadow-diff-cli.ts` diffs one day of it against
live:

```
node server/dist/app/shadow-diff-cli.js --candidate=clustering_v2 --day=2026-08-20 \
  --explanations=/abs/path/clustering_v2.json
```

The report is one canonical-JSON line, byte-identical on a re-run over the same rows.
Every difference in it has a stable `key` (`<kind>:<JSON identity parts>`), and L-1
promotes only when `verdict` is `all_explained`. The CLI exits 0 on `all_explained`,
1 on `unexplained_diffs`, 2 on misconfiguration.

The policy is what makes "explained" mean something:

1. **Every diff is either a fixture or accepted, with a reason.** An explanation is an
   entry in the explanations document —
   `{"explanations":[{"key":"…","disposition":"fixture","fixtureId":"S17","reason":"…"}]}`
   or `"disposition":"accepted"` with `"fixtureId": null`. There is no third disposition:
   "looked fine" is not one.
2. **`fixture` means the behaviour is now pinned here.** The diff showed something the
   candidate does that live does not, and it is the behaviour we want. A scenario is
   added to this directory that reproduces it, its `expected.json` is written from the
   candidate, and the explanation names the scenario id. From then on CI-2 holds the
   candidate to it, and live, until promotion, fails it — which is the point.
3. **`accepted` means the difference is real, understood and not worth a fixture** —
   for instance a digest row that moved because of a one-event difference already
   pinned by another fixture. The reason says which; it is reviewed with the report, not
   after it. (Scores are compared by bucket, so a score that moves without crossing a
   bucket floor is not a diff and needs no explanation.)
4. **A refresh of an existing `expected.json` is a fixture disposition too.** When a
   candidate changes the outcome of a scenario that already exists, the refreshed
   expectation is committed in the same change that promotes the candidate, and the
   commit names the shadow report that justified it. An expectation is never
   regenerated from a candidate that has not shadowed.
5. **Stale explanations are cleaned up, not carried.** The report lists every
   explanation that names no diff (`staleExplanations`) — the diff went away, or the key
   was misspelt. Neither is harmless: the first should be deleted, the second hides a
   real diff behind a typo.
6. **The explanations document is per candidate** and lives beside the reports that
   were reviewed against it. Where it is stored — in this repository, or with the ops
   evidence — is not decided yet.
