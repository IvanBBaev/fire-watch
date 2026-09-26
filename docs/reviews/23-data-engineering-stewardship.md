# Review 23 — Data engineering & stewardship

*Reviewer role: data engineer / data steward (dataset identity, lineage across promotion, retention, publication, static data, feed quality, unbackfillable fields). Date: 2026-09-02. Status: complete.*

*Inputs reviewed: OPERATIONS §6.2, §6.4; `server/src/core/backfill/backfill-plan.ts`, `server/src/core/promotion/promotion-run.ts`, `sanity-checks.ts`, `noop-month-recluster.ts`; `server/src/core/config/weather-context.ts`; `server/src/core/ingest/firms-availability.ts`; DATA-SOURCES §A1.1, §D2, §D3, §D6, §E2; `docs/licenses/`; ADR-002 A1.4; GATES §2, §3 (L-13, L-14), §4; TASKS A19, B8, C6, C7, C9, D7, D10; reviews 03 §5.7, 04 §6 Q6, 09 rec 5, 11 §4.7, §5.7, §9; 15 §7.1; 18 §5.5 and §6 Q2; 20 §4.3. Project is in implementation (WP0–WP2).*

---

## 1. Summary verdict

**CONDITIONAL GO — the archive is engineered with more care than most production datasets and is not yet a dataset: it has a plan digest, a manifest and a sanity band, and no identity, no lineage rule across the swap, no retention owner and no publication decision.** Review 15 §7.1 folded data stewardship into review 18 with a condition: separate it out "if the archive ever acquires obligations of its own". It has. Not a funder's — the project's: the parameter fit (D7) will cite a corpus, the NRT→SP swap (C7) will rewrite what an event's detections say, the calibration gate (L-13) will be evaluated on a season, and the 2027-constellation replay (L-14) can only see NOAA-21 through rows that exist nowhere but the live recording. Each of those is an obligation the archive owes to a consumer, and none has a steward. Review 18 §5.5 keeps survival — copies, `--check`, the sunset branch. This review takes identity, lineage, retention, publication and quality, and rules on 15 §7.1 in §5.8.

1. **The corpus has no name** (§5.1, R-1). `backfill-plan.ts` versions the plan and refuses to resume under a different one — exactly right — but a plan digest identifies *what was asked for*, not *what was got*. D7's fit report, L-13's calibration and the CP1 report will all cite "the backfill"; nothing says which manifest, which `--check` date, with which gaps. A refit trigger is undefined because the thing that would change is unnamed.
2. **Promotion changes what a permalink means and nobody has written what it shows** (§5.2, R-2). ADR-002 A1.4 sequences stage → sanity → swap → month-scoped re-cluster → Jaccard-gated promotion, and the implementation keeps the retired NRT partition. Good. After the swap an event's detection list resolves to SP rows the event was never formed on; invariant 5 says the permalink lives forever. Lineage — which tier a row came from, which run replaced it — is in the schema (`product_tier`) and not in the rule.
3. **Retention has no owner, in writing** (§5.3, R-3). OPERATIONS §6.2 rule 11: the detection-retention policy "is an open question with no owner (review 04 §6 Q6)". A single-copy archive with an unowned retention rule is an archive whose eventual size, cost and deletion policy is decided by the disk.
4. **The shadow season records fields it cannot get back and has no retention commitment for them** (§5.5, R-4). DATA-SOURCES §E2: WP1's obligation is to *record*, not to join. The record-now list — `available_at`, `data_availability` responses, raw CLM, the six ECMWF fields at overpass, EFFIS FWI images, poison evidence, NOAA-21 NRT rows — has no line saying "kept at least until CP1 has been evaluated on it".
5. **The documented cloud proxy and the recorded one differ** (§5.4, R-5). TASKS A19 (done) declares the Open-Meteo `cloud_cover` proxy sufficient for CP1; `weather_context_v1` records ECMWF `tcc` and fences Open-Meteo out entirely by the §D3 licence rule. Either the document or the code is the source of record for what CP1 measures cloud with, and today it is not the same one.
6. **Static data is a `null`** (§5.6, R-7). `fuelBand: FuelBand | null` in `reignition-plan.ts` and `identity-engine.ts` with an honest comment ("not a stand-in: no classifier"); D10 owes WorldCover/CORINE preparation with no source version, licence pin or refresh rule chosen. Every reignition window this season uses the default band.
7. **Publication and licence of the derived archive are undecided** (§5.7, R-8). Review 18 §6 Q2 asked; `docs/licenses/` pins seven input licences (09 rec 5, done well); nothing says what licence the *output* carries or what the inputs permit it to carry.

GO is conditional on §4 E1 (a dataset record for every corpus version) landing before D7 starts, on E3 (retention gets an owner and a date) being answered by the founder this month, and on E5 (the record-now list with a retention floor) being adopted before the poller runs unattended. Everything else can wait for the host review 21 is asking for.

## 2. Strengths (sound as proposed)

- **Plan-as-data with a refusal.** `backfill-plan.ts` versions the plan, writes the version and digest into the manifest, and refuses to resume into an archive downloaded under a different plan because "mixing windows silently would bias every" downstream fit. That refusal is the seed of dataset identity; E1 grows it.
- **`product_tier` is part of identity** (DATA-SOURCES §A1.1; `backfill-plan.ts`). The SP/NRT distinction is in the row, not in a filename convention. Lineage across the swap is representable; it needs a rule.
- **The swap is honest about what it does not know.** `sanity-checks.ts` returns `needs_operator` when the count band is unfitted; ADR-002 A1.4 fits the band on the first two observed real swaps; the retired NRT partition is kept; the month re-cluster is `skipped_no_engine` rather than a stub that pretends. Nothing promotes on a guess.
- **`--check` and layout v1** (OPERATIONS §6.4). Every file is re-hashed against the manifest; the layout is dated. Review 18 §5.5's survivability items build on this and this review does not repeat them.
- **Licence pinning is done** (`docs/licenses/`, seven notices with retrieval dates). Review 09 rec 5 asked; it happened. The output-licence question (§5.7) is a different question.
- **The weather config is small and deliberate.** Six fields, three steps, four runs, a publication delay, a GRIB2 floor; `tcc` "is here deliberately" with the reason in the header. The problem in §5.4 is not the code; it is the document it was written against.
- **"Record, not join"** (DATA-SOURCES §E2) is the correct season-1 posture and this review's E5 is only its retention half.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | No dataset identity beyond the plan digest: the fit (D7), calibration (L-13), constellation replay (L-14) and CP1 will cite a corpus that has no name, no gap list and no refit trigger. Two people running D7 six months apart cannot know whether they fitted the same data. | §5.1 |
| R-2 | **High** | Lineage across promotion is representable and unruled: what a permalink shows after its detections are swapped, how long the retired NRT partition lives, whether an event formed on NRT and re-clustered on SP is "the same event" for invariant 5. | §5.2 |
| R-3 | **High** | Retention policy ownerless in writing (OPERATIONS §6.2 rule 11); size and cost of the archive are decided by default. | §5.3 |
| R-4 | **High** | Unbackfillable season-1 fields with no retention floor; a 56-day window applied by habit to a row that CP1 needs in November loses the season's evidence. | §5.5 |
| R-5 | **Medium-High** | Documented cloud proxy (Open-Meteo `cloud_cover`, A19) ≠ recorded cloud proxy (ECMWF `tcc`, `weather_context_v1`). CP1's cloud-gating evaluation (11 §5.7) will be run on a field the source-of-record document does not name. | §5.4 |
| R-6 | **Medium** | Fields without consumers: `2t`, `2d`, `tp` are recorded "for scoring and context" (§D2) with no consumer in code and no retention or bump owner; `weather_context_v1` will be bumped by whoever needs the seventh field, and the digest will change under CP1. | §5.4 |
| R-7 | **Medium** | Static data: no land-cover source version, licence or refresh rule; `fuelBand` is `null` everywhere; D10's done-when (S3/S4 on real masks) has no data-prep owner. | §5.6 |
| R-8 | **Medium** | Output licence and deposit undecided (18 §6 Q2 open). The archive's second copy (C6) is a backup, not a publication; the two are being conflated. | §5.7 |
| R-9 | **Medium** | NOAA-21 has no SP product (`backfill-plan.ts`), so L-14's 2027 constellation can be replayed only from live NRT rows — which exist only if season 1 records them and keeps them. Ties R-4 to a launch gate. | §5.5 |
| R-10 | **Low** | The CP1 protocol is to be "written in September 2026" (GATES §4) with its report in `docs/reports/`, which does not exist. Not a data risk; a reminder that the first consumer of the dataset record is three weeks away. | §5.1 |

## 4. Detailed recommendations

- **E1 [MVP] A dataset record per corpus version.** Maps to R-1, R-10. One file, `docs/data/DATASETS.md`, one dated entry per corpus: plan id and digest; manifest SHA and `--check` date; sources and tiers included; known gaps (NOAA-21 absent, any chunk that failed and was skipped); reprocessings applied (which promotion runs, with their sanity outcome); the consumers that have cited it (D7 fit report, L-13, CP1). Refit trigger: a new entry. D7 does not start until its input has an entry. Effort: an hour to write, ten minutes per entry. **Landed 2026-09-03** as `docs/data/DATASETS.md` — DS-1 (SP archive), DS-2 (season-1 live record), DS-3 (EFFIS labels), DS-4 (GEO 2025); every entry unfetched, every `--check` field blank.
- **E2 [MVP] A lineage rule for promotion, asked of ADR-002.** Maps to R-2. This review does not specify the mechanism (03 and ADR-002 own identity); it asks for three sentences: (1) what a permalink shows after its detections are swapped — the proposal is *the current detections with a "reprocessed on ⟨date⟩ from NRT to SP" line*; (2) how long the retired NRT partition is kept — proposal: until the next promotion run's sanity check passes, then archived to R2 parquet under the retention policy, never deleted before CP2; (3) whether an event's `event_id` survives a re-cluster that changes its member set below Jaccard 0.5 — ADR-002 A1.4 already answers (it does not promote); the rule should say what the *old* id shows. Escalated in §6 Q2.
- **E3 [MVP] Retention gets an owner and a date.** Maps to R-3. Proposal, for the founder to adopt: raw FIRMS CSV archive — forever, cheap, it is the product; detections/events partitions — two seasons hot, then parquet to R2 (04 §6 Q6's proposal), never deleted; retired NRT partitions per E2; personal-data-free artifacts are not covered by the 56-day window at all and OPERATIONS §6.2 rule 11 says so today. Owner: this seat; decision: founder, this month. OPERATIONS §6.2 rule 11 is rewritten from "no owner" to a pointer.
- **E4 [MVP] Resolve the cloud proxy.** Maps to R-5. Either A19's text and DATA-SOURCES §D6 change to "ECMWF `tcc` is the CP1 cloud proxy; Open-Meteo is not recorded", or a dev-only Open-Meteo recorder is wired in behind the §D3 fence for the CP1 comparison. This review's position: the first — the code's reason (licence fence) is better than the document's (free, no registration), and 11 §5.7 called its proxy honest, not precise. The 11 author decides whether `tcc` at 0.25° is an honest enough proxy; the founder decides the document.
- **E5 [MVP] The record-now list with a retention floor.** Maps to R-4, R-9. A table in DATA-SOURCES §E2 (or OPERATIONS §6.2): field → why it cannot be backfilled → kept at least until. Entries: `available_at` per detection (lag histograms; C9) → CP1 + one season; `data_availability` responses (`availability.json`) → forever, tiny; raw CLM per overpass → CP1 + one season; six ECMWF fields at overpass → CP1 + one season; EFFIS FWI daily images → forever, small; poison evidence (T2) → forever; **NOAA-21 NRT rows → forever**, because L-14 cannot get them anywhere else. The floor is a rule, not a schedule; the schedule is E3. *Recorded 2026-09-03 as the proposed floor in DS-2's entry; the schedule still has no owner.*
- **E6 [MVP] Fields name their consumer or their expiry.** Maps to R-6. `weather_context_v1`'s header gains one line per field: consumer (a code path or a review section) or "recorded for CP1 comparison; drop at v2 if unused". `2t`, `2d`, `tp` are recorded on the strength of §D2's "scoring and context"; that is a plan, not a consumer. Bumping the config under CP1 is forbidden by the same rule that freezes the harness between checkpoints (review 22 §6 Q6).
- **E7 [v1] Static data as versioned config-as-data with provenance.** Maps to R-7. Land cover (WorldCover 2021 or CORINE 2018 — 03 §5.7 and D10 choose), hot-source mask, terrain: each a versioned artifact with source, version, licence pin in `docs/licenses/`, retrieval date, refresh rule ("re-derive when the source publishes a new epoch; never mid-season"). `fuelBand` stops being `null` when the first artifact lands; until then the `null` is honest and stays.
- **E8 [v1] Feed quality as products with owners.** Maps to R-4. C9's parity and lag histograms are data products, not monitors: each gets an entry in E1's record, a retention line in E5, and a consumer (11 §9.3's dashboard; the pass-table refit). Thresholds stay with the SRE seat (04); the *dataset* is this seat's.
- **E9 [v1] Publication decided, separately from backup.** Maps to R-8. Answer 18 §6 Q2 in two parts: (a) what the inputs permit — FIRMS and Copernicus are open, ECMWF is CC BY 4.0 with a modification notice, EFFIS and LSA SAF need reading — a one-page memo from the 09 seat; (b) what we publish — proposal: the raw FIRMS CSV archive is not ours to republish (it is FIRMS's, mirrored); the *derived* events table with `event_id`s, lineage and the dataset record is ours, CC BY 4.0, deposited yearly with a DOI once the sunset branch (18 §5.5.4) is decided. The C6 second copy is a backup and is not this.
- **E10 [v2] Institutional mirror.** The 15 §7.1 trigger by its own wording; not before a season of data exists and E9 has an answer.

## 5. Data-engineering deep dive

### 5.1 A corpus with no name (R-1, R-10)

`backfill-plan.ts` does the hard part. The plan is versioned, its digest is in the manifest, and a restart under a different plan is refused. What it identifies is the *request*: which products, which years, which day ranges. What the fit needs to identify is the *result*: which chunks landed, which were retried, which are missing, on which date `--check` last passed, and which promotion runs have rewritten which months since. Those are facts about a particular archive on a particular disk, and today they are recoverable only by reading the manifest and the WORKLOG together.

The consumers are close. D7's fit report, L-13's calibration on the 2024 season, L-14's constellation replay and the CP1 report (GATES §4, to be written this month, into a `docs/reports/` that does not exist yet) will each say "the backfill". E1 gives them a noun. The entry is short; its value is that a refit has a trigger — a new entry — and that two fits a season apart can be compared by their inputs and not by their authors' memory.

### 5.2 What a permalink shows after the swap (R-2)

ADR-002 A1.4 rewrote promotion as stage → sanity → swap → month-scoped re-cluster → Jaccard ≥ 0.5 promotion, and the C7 implementation follows it: DETACH, rename, rename, ATTACH, retired NRT partition kept, re-cluster a deliberate no-op until the engine lands. `product_tier` is on the row. Everything needed for lineage exists.

What does not exist is the sentence. An event was formed on NRT rows; the season's permalinks (invariant 5, forever) point at it; the swap replaces its rows with SP rows that differ in position, confidence and sometimes existence; the re-cluster may change its member set. Three questions have no written answer: what the permalink shows (the old rows, the new rows, both, or the new rows with a notice); how long the retired partition — the only copy of "what the user was shown" — is kept; and what an old `event_id` resolves to when the re-cluster does not promote. This review's proposals are in E2. It asks ADR-002 to write the sentences rather than writing them here, because the ADR wins over a review and identity is its subject.

### 5.3 Retention has to belong to someone (R-3)

OPERATIONS §6.2 rule 11 is candid: the policy is "an open question with no owner". Review 04 §6 Q6 proposed the shape (hot for a bounded period, then parquet to R2) in June. Nothing decided it, because deciding it was nobody's seat — the SRE seat owns the backup window, the backend seat owns the partitions, the data-science seat owns what the fit needs, and retention is the intersection.

E3 proposes the answer and, more importantly, an owner and a date. The content is not controversial: the raw CSV archive is the product and is kept forever; derived partitions go cold after two seasons and never die; personal-data-free artifacts are outside the 56-day window as rule 11 already says. What is controversial is only that someone has to say it, and rule 11 has to stop saying "no owner".

### 5.4 The proxy the document names is not the one the code records (R-5, R-6)

TASKS A19 is ticked: Open-Meteo reclassified as dev-only, ECMWF the source of record, and — in the same sentence — "declare the Open-Meteo `cloud_cover` proxy sufficient for CP1". The C4 implementation then fenced Open-Meteo out entirely by the §D3 licence rule and recorded ECMWF `tcc` instead, with a header that says why. Both decisions are defensible. They are not the same decision, and CP1's cloud-gating evaluation (11 §5.7's "honest proxy") will be run on whichever field exists, which is `tcc`.

E4 asks for the document to follow the code, because the code's reason is stronger. It also asks the 11 author whether model total-cloud at 0.25° is honest enough where hourly station-blended cloud was the original proposal — a question this seat can raise and not answer.

The same config records `2t`, `2d` and `tp` on the strength of §D2's "scoring and context". No code path reads them. Recording them is cheap and right (§E2: record, not join). What is missing is the line that says who will read them and by when, so that the seventh field — whoever needs it — does not bump `weather_context_v1` in the middle of the season it is being evaluated on. E6 is that line.

### 5.5 What season 1 cannot get back (R-4, R-9)

DATA-SOURCES §E2 says WP1's obligation is to record. The list of what is unbackfillable is scattered: `available_at` and the `data_availability` responses in C9; raw CLM in §E2; the ECMWF fields in `weather_context_v1`; EFFIS FWI images in §D6; poison evidence in the T2 threat model; and — from `backfill-plan.ts`'s own note — NOAA-21, which FIRMS serves as NRT only. The last one is the sharpest: L-14 requires a replay on the 2027 constellation, NOAA-20/21 VIIRS and SLSTR; the SP corpus cannot contain NOAA-21; the only NOAA-21 rows the project will ever have are the ones the live poller records this season and keeps. A 56-day window applied by habit deletes a launch gate's input.

E5 is a table with a retention floor per field. It is not a schedule — E3 is — it is the rule that a schedule may not go below. Review 21 §6 Q6 lists this table as the reason the D-track pauses for the host: every unrecorded day is a row in it that will never exist.

### 5.6 Static data (R-7)

`fuelBand` is `null` in `reignition-plan.ts` and `identity-engine.ts`, and the comment in the engine says it is not a stand-in — there is no classifier. That honesty is the right thing and it is the whole static-data story today. D10 owes land-cover and mask preparation with no source chosen (WorldCover or CORINE), no version, no licence pin and no refresh rule. When it lands it will be a versioned artifact like every other tunable, or it will be a file on the VM that §9.2 presumes lost. E7 says which.

### 5.7 Publication is not backup (R-8)

Review 18 §6 Q2 asked what licence the archive carries and where its second copy is deposited, and folded the two together. They are different acts. C6's second copy is a backup: encrypted, write-only token, restore drill, ours. A deposit is a publication: a licence, a DOI, a mirror that is not ours, and an obligation to whoever cites it. The project can do the first this month and should; it cannot do the second until it knows what the input licences permit (`docs/licenses/` pins them; nobody has read them for *this* question) and what the sunset branch (18 §5.5.4) intends. E9 splits the question and answers the half that is answerable.

### 5.8 Ruling on review 15 §7.1

Review 15 folded stewardship into 18 §5.5 with the condition "if the archive ever acquires obligations of its own — a funder's open-data condition, an institutional mirror — it deserves separating out". Neither named trigger has fired. The condition's *substance* has: the archive now owes a named corpus to the fit (D7, L-13), a lineage rule to the permalinks (invariant 5), a retention rule to itself (§6.2 rule 11) and NOAA-21 rows to a launch gate (L-14). Those are obligations of the archive's own, owed to the project rather than a funder, and they are the reason this seat exists. Review 18 §5.5 keeps what it has — survival — and this review adds nothing to it. The seat closes the moment E1, E3 and E5 are absorbed by the documents they belong to; it does not need to persist.

## 6. Open questions for the team

1. **Retention (E3) — founder, this month.** The proposal is 04 §6 Q6's shape with owners and floors. If refused, OPERATIONS §6.2 rule 11 still needs a name in it.
2. **Disagreement escalated: E2 asks ADR-002 to add a lineage rule for permalinks after the swap.** This review holds that "current detections with a reprocessed-on line" is right and that the retired NRT partition is kept until the *next* promotion's sanity passes. The ADR-002 owner (03 seat + founder) decides; nothing here amends the ADR.
3. **Cloud proxy (E4) — the 11 author on honesty, the founder on the document.** Is ECMWF `tcc` at 0.25° an honest proxy for CP1's cloud gating, given that A19 declared Open-Meteo's? If not, a dev-only recorder is a day's work and must land before the poller runs unattended.
4. **Does the dataset record (E1) live in `docs/data/` or inside OPERATIONS §6.4?** Either; it must exist before D7 starts. Founder decides. *Placed in `docs/data/` on 2026-09-03 with OPERATIONS §6.4 pointing at it; moving it is a rename.*
5. **Who reads the input licences for the output question (E9a)?** The 09 seat, by its own rec 5. One page. Not urgent; it gates E9b, which is not this season.
6. **Do `2t`, `2d`, `tp` get a consumer or an expiry (E6)?** The 12 seat (fire domain) is the likeliest consumer; if none is named by CP1, they stay recorded and are dropped from v2 of the config. Founder decides.
7. **Does this seat persist?** §5.8 says no — it closes when E1, E3 and E5 are absorbed. If the founder prefers a standing owner for retention, it is the SRE seat (04), which owns the disk.

## Appendix A — Proposed rows for the shared documents

**RISKS §2**

`| **Archive without dataset identity or retention owner** | The fit (D7), calibration (L-13), constellation replay (L-14) and CP1 cite a corpus that has no record of what it contains; retention has no owner (OPERATIONS §6.2 rule 11); season-1 rows that cannot be backfilled — NOAA-21 NRT above all — are subject to a 56-day habit | Trigger: D7 starts without a dataset record; any retention action on a season-1 partition. Monitor: `docs/data/DATASETS.md` has an entry for every corpus the fit cites | 23 E1 before D7; 23 E3 decided this month; 23 E5 retention floors adopted before the poller runs unattended |`

**GATES — no new gate.** E1 and E5 are preconditions of existing gates (L-13, L-14, CP1), not gates of their own; the right place for them is one clause in each existing row, proposed to the founder rather than added here.

**00-summary synthesis (3–4 sentences)**

Review 23 finds the archive engineered with care — a versioned plan that refuses to resume under a different one, tier in the row, a swap that returns `needs_operator` rather than guessing — and not yet a dataset: no record of what a corpus contains for the fit and the checkpoints to cite, no written rule for what a permalink shows after its detections are swapped, a retention policy that OPERATIONS itself says has no owner, and a record-now list for the shadow season with no retention floor, sharpest for NOAA-21, which has no archive product and can only ever come from live rows the poller keeps. It also finds that the cloud proxy TASKS A19 declared for CP1 is not the one the code records. It rules that review 15 §7.1's condition has been met in substance and proposes a dataset record, a lineage rule asked of ADR-002, retention with an owner, field-level retention floors, and publication decided separately from backup.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| Plan versioned, digest in manifest, restart refuses a different plan; `MAX_ARCHIVE_DAY_RANGE = 10`; NOAA-21 absent (NRT only) | `backfill-plan.ts` header and constants |
| `product_tier` part of identity | `backfill-plan.ts` header; DATA-SOURCES §A1.1 |
| Sanity returns `needs_operator` when unfitted; retired partition kept; re-cluster `skipped_no_engine` | `sanity-checks.ts`, `noop-month-recluster.ts`, TASKS C7 status |
| A1.4 sequence; band fitted on first two real swaps | ADR-002 amendment A1.4 |
| Retention "open question with no owner" | OPERATIONS §6.2 rule 11 |
| Single copy until C6; layout v1; `--check` | OPERATIONS §6.4 items 5–7 and changelog |
| `weather_context_v1`: six fields, three steps; `tcc` deliberate; Open-Meteo fenced | `weather-context.ts` lines 10–11, 40 |
| A19 declares Open-Meteo proxy sufficient for CP1 | TASKS A19 (ticked) |
| §D2 "scoring and context"; own FWI computation pencilled in; `tcc` stopgap | DATA-SOURCES §D2 |
| "Record, not join" | DATA-SOURCES §E2 |
| `fuelBand` `null`, "no classifier" | `reignition-plan.ts`, `identity-engine.ts` |
| Seven licence notices pinned | `ls docs/licenses` |
| L-14 constellation: NOAA-20/21 + SLSTR, MODIS/S-NPP dropped | GATES §3 L-14 |
| CP1 protocol written in September; report in `docs/reports/`; directory absent | GATES §4; `ls docs/reports` |
| 04 §6 Q6 proposal | review 04 §6 |
| 18 §6 Q2 licence + deposit | review 18 §6 |

No data was inspected — there is no host and no archive yet. Every claim about the corpus is a claim about the code that will produce it.
