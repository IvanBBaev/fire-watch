# Review 24 — Round 5: the project as built, and which seats must read it

*Reviewer role: review-corpus owner. Date: 2026-10-30. Status: complete.*
*Inputs reviewed: `reviews/00`–`23`; `docs/TASKS.md` (release-progress block, §1 pending
founder decisions, Tracks A–K and V2 as they stand on 2026-10-30); `docs/V2-FEATURES.md`,
`docs/V3-FEATURES.md`, `docs/V3-WORKPLAN.md`; `README.md`; `WORKLOG.md` 2026-09-02 →
2026-10-29; `git log` (180 commits); the `server/`, `web/`, `packages/` trees at `ccd541a`;
GitHub Actions run history for `main` (`gh run list`). Commissioned by an explicit founder
request on 2026-10-30, which satisfies the stopping rule of review 20 §7 Q1.*

---

## 1. Summary verdict

**Fire Watch is engineering-rich and delivery-poor: about 141,000 lines of reviewed,
committed, tested TypeScript, and no system running anywhere. The seats it needs now are not
missing seats. They are the existing senior seats reading the system as built, seven months
before launch.**

1. Rounds 1–4 asked "which decision does nobody own?". Round 5 asks a different question,
   because the founder asked it: *what does each senior discipline see in the code that
   exists, and what does that change between now and May 2027?* So T-A and T-B are not the
   selection tests this time. A seat is chosen when the built system contains decisions that
   its previous review could not have seen (§4).
2. **What exists** (§3.1–3.3): a monorepo with 37 migrations, 449 server test files, 155 web
   test files and 8,506 tests green locally. It contains the whole v1 design: ingestion,
   identity, lifecycle, read path, map, alert engine, accounts, staff, ops CLIs and drills. On
   top of that, 14 Track V2 items are built (none ticked) and 5 of 39 V3 items are done.
3. **What runs** (§3.4): nothing. There is no host, no FIRMS key on a host, no R2 bucket, no
   domain and no mail sender. The 2026 fire season was not recorded. WP1 tier 1 was a
   "hard, unrecoverable" deliverable dated early September 2026, and it was missed.
4. **What the progress signals say, and what is true** (§3.5). Remote CI on `main` has failed
   on every push since 2026-09-26, while WORKLOG said "gates green" for 34 days, because
   local `pnpm verify` excludes the integration suite. The release-progress block reports
   71.9 %, but it was last computed on 2026-10-13 at `fb97640`, 120 commits ago. Twelve V2
   features are built but not ticked. None of the three signals can be trusted as they stand.
5. **Where the capacity went** (§3.6). 120 of the 180 commits landed after 2026-10-10.
   Most of them went into v1 hardening, V2 and V3, all built ahead of a v1 that has never
   been deployed. The work is good, and it is also work that does not move the launch
   critical path. That path is gated by accounts, a host, founder decisions and live data,
   and no agent session can produce any of those.
6. **Where the system is blocked** (§3.7). There are 17 open entries in TASKS §1 "Pending
   founder decisions", 205 copy keys held in `PENDING_FOUNDER_REVIEW`, and 18
   clustering `FIT_DECISIONS`. The V2 and V3 founder questions come on top. The founder's
   queue grows faster than it is drained.
7. **Eight seats are commissioned** (§4): principal architecture (25), product & delivery
   (26), SRE & platform (27), security & privacy (28), QA & test engineering (29), fire
   domain & data science (30), frontend, UX & accessibility (31), and legal, licensing &
   business (32). Seven earlier seats are folded into these eight and one is rejected (§5).
8. **This round edits the roadmap** (§6). That reverses review 20 §6.5, because the founder
   asked for it: every actionable recommendation becomes a row in a new `TASKS.md` Track R5.

**GO for round 5 is conditional on** its output being treated as a re-planning input, not
as more design. The single most useful sentence the eight reviews can produce is the one
that says what to stop building.

---

## 2. Method

### 2.1 State analysis

Every number in §3 was measured on 2026-10-30 at `ccd541a` (Appendix B). Counts of source
lines exclude `*.test.ts(x)` files. "Built" means committed to `main`; "ticked" means `[x]`
in `TASKS.md`; "running" means serving or recording on a host that is not the founder's
laptop.

### 2.2 Seat selection — test T-C, "as-built exposure"

Round 5 is not a gap analysis, so review 15's two tests are kept only for candidate *new*
seats (§5.2). For the existing seats the test is:

- **T-C.** Does the built system, or the project's live situation, contain decisions,
  defects or risks in this discipline that its previous review could not have seen, because
  they did not exist when that review was written?

A seat passes T-C when the answer is yes and the consequence reaches the May 2027 launch.
Where two prior seats pass T-C on the same artifacts, they are merged into one round-5 seat
with several lenses. This keeps the round to eight documents, and it keeps related findings
inside one document, so they do not have to be reconciled across documents.

### 2.3 Brief and contract

Every round-5 seat received the same brief. It contained:

- the facts of §3;
- its prior reviews, which it had to read before writing;
- a focus list of five to seven items;
- the house format of [review 21](21-platform-release-engineering.md): §1–§6, then
  Appendix A (TASKS rows `R5-<CODE>-n`, RISKS and GATES rows, and a summary paragraph) and
  Appendix B (verification);
- one hard limit: write one file and touch nothing else.

The reviewers were told to say what changed since their previous review, to cite evidence
for every claim, and to rank by consequence for May 2027. Disagreements go to the founder
(review 15 §7.2). Round 5 does not resolve them.

---

## 3. The project as built — deep state analysis

### 3.1 Size and shape

| Measure | Value | Note |
|---|---|---|
| Commits | 180 | 6 in August, 26 on 2026-09-26, 148 after; `main` 2 ahead of `origin` |
| `server/src` non-test lines | 103,418 | 45 `core/` modules, 28 `adapters/` families, 131 files in `app/` |
| `web/src` non-test lines | 32,357 | `core/`, `ui/`, `map/`, `edge/`, `adapters/` |
| `packages/` non-test lines | 5,694 | `contracts` (schemas, never-send lint, catalogs) |
| Test files | 449 server / 155 web / 14 packages | `pnpm verify` 613 files, 8,506 tests green locally (WORKLOG 2026-10-29) |
| Migrations | 37 | `001`–`036` plus `060_source_registry_v2.sql` (V3 range 060–071 reserved) |
| Largest source files | `catalog-governance.ts` 1,444; `pg-clustering-store.ts` 1,282; `config.ts` 959; `messages.ts` 897 | review 25 rules on whether these are debt |
| Local-only assets | `tiles/` 1.0 GB, `tiles-dem/` 624 MB, `data/` 1.1 GB | none has a production home yet |
| Review corpus | 23 reviews, 5 ADRs, `GATES`, `RISKS`, `GLOSSARY`, `OPERATIONS`, 6 runbooks, drills | this round adds 9 |

The tests are not shallow by construction. The project carries real-Postgres integration
tests (testcontainers, colima profile `fwtest`), Playwright e2e with an axe sweep, byte and
timing budgets, a golden-replay register (S1–S16), a never-send lint over every catalog,
and a dependency-cruiser boundary gate. Review 29 rules on how much of that testing carries
weight.

### 3.2 Rhythm of delivery

Commits per day: 2026-08-09 (6) · 09-26 (26) · 10-01 (1) · 10-10 (16) · 10-11 (2) ·
10-13 (8) · 10-18 (3) · 10-22 (24) · 10-24 (34) · 10-27 (45) · 10-28 (9) · 10-29 (6).

Work arrives in agent waves, each with up to eight parallel worktree agents that are merged
per item. Review 22 asked for one item per commit, integrated quickly, and that practice has
landed. The cost of the waves shows up elsewhere. A wave produces more code than a solo
founder can read, more decisions than they can take, and more red builds than anyone can
notice when nobody watches remote CI (§3.5).

### 3.3 What is built, by work package

| WP / track | Ticked / open in TASKS | Built and committed | Running |
|---|---|---|---|
| A — corpus amendments | 23 / 0 | yes | n/a |
| B — WP0 scaffolding | 7 / 2 | yes (B8, B9 partial) | no host |
| C — WP1 ingestion (shadow) | 1 / 9 | most of C1–C8 | **no**; season 2026 not recorded |
| D — WP2 clustering & identity | 4 / 8 | yes; D7 fit machinery, 18 `FIT_DECISIONS` open | no |
| E — WP3 read path | 3 / 3 | yes, incl. T2 failover e2e | no |
| F — WP4 map | 7 / 11 | F1–F18 | fixtures and `pnpm dev:live` only |
| G — WP5 tiles & style | 2 / 4 | real Protomaps tiles built locally | not hosted |
| H — WP6 alerts | 4 / 5 | engine, live evaluation, digest core, SES hook | no mailer, no push keys |
| I — WP7 accounts & GDPR | 0 / 7 | accounts, zones, erasure, exports, staff I1 | routes partly unregistered |
| J — WP8 ops | 0 / 5 | meta-alerts, status, drills, runbooks | no host to watch |
| K — WP9 beta & launch | 0 / 4 | — | no cohort |
| V2 wave 1 | 0 / 14 | 12 features (playback, outlines, webhooks, sync, …) | — |
| V3 work plan | 5 / 39 (`V3-WORKPLAN.md`) | P1–P4, A1 | — |

The pattern is consistent across tracks. Tasks are rarely ticked, because their done-when
clauses require a host, an account or a founder decision. Code is almost always complete up
to that boundary. The project has run out of work that an agent can finish, and it has kept
building anyway by moving outward to V2 and V3.

### 3.4 What runs

Nothing is running. Per `docs/EXTERNAL-ACCOUNTS.md` and the release-progress "Blocked by"
row, none of these exist yet:

- a Hetzner VM or a staging host;
- a FIRMS `MAP_KEY` in production use;
- R2 / Cloudflare;
- EUMETSAT / LSA SAF access;
- CORINE / CDS access;
- VAPID keys;
- a domain;
- a mail sender;
- the ЕООД;
- a lawyer and DPAs.

`pnpm dev:live` shows real keyless FIRMS data on the founder's laptop. That is the only live
path the project has ever had.

The cost is concrete. CP1 (`GATES.md` §4) was to grade the 2026 shadow season. D7's fit was
to run on that corpus. L-13 calibration and the live-shadow half of the alert gates assume it
too. Reviews 26 and 30 rule on what archive data can recover and what is lost for good.

### 3.5 Honesty of the progress signals

- **Remote CI.** The last green run on `main` was on 2026-09-26. Every later push failed,
  including runs `40591069990` (`c1853fe`), `40767718700` (`cf40cc8`) and `40939772318`
  (`3497c93`). The failing job is "Migrations against PostGIS". In it, one integration test
  out of 396 fails:
  `pg-detection-store.integration.test.ts` › "stores a polled row with the provenance needed
  to explain it later" (`toMatchObject`). The suite does not run under local `pnpm verify`,
  and the workflow notes ("all gates green") were written about the local gate. There is no
  branch protection to stop a red `main`; review 27 verifies this. One more remote signal is
  pending: the runner-image migration (`ubuntu-latest` to Ubuntu 26) is announced on the same
  runs.
- **Release progress.** The block shows 71.9 % (442.4 h of 615 h). It was last computed on
  2026-10-13 at `fb97640`. Since then 2 audit fixes, 14 V2 items, I1 staff accounts and
  five V3 items have landed. None of them is in the table, and V2 and V3 are not part of the
  release target at all. So the number is stale, and its denominator is the wrong question
  for a project that is building beyond its target.
- **TASKS ticks.** 51 ticked, 72 open. The count understates built code, because done-when
  needs a host. It also overstates readiness, because a built feature that has never run in
  production carries all of its integration risk.

### 3.6 Scope beyond v1

- `V2-FEATURES.md` analysed 12 features. All 12 were built in waves 1–2 (2026-10-24/27),
  together with migrations 032–036.
- `V3-FEATURES.md` and `V3-WORKPLAN.md` (2026-10-28) plan 39 items in parallel lanes and
  reserve migrations 060–071. The first of them, `060_source_registry_v2.sql`, is already in.
  That leaves a gap from 037 to 059, which every future v1 migration has to fit into.
- Several V2/V3 features add new obligations before v1 has any users:
  - third-party processors and licences: GIBS client-direct, MeteoAlarm, CEMS, WorldCover,
    CelesTrak, FireSat;
  - personal-data surfaces: webhooks, cross-device sync;
  - B2B surfaces: municipal dashboards, OGC API, SDK, MCP, embed.

  Reviews 28 and 32 rule on these obligations.

### 3.7 What the system is waiting for

| Waiting on | Count / state | Source |
|---|---|---|
| Founder decisions listed in TASKS §1 | 17 entries, several past their due date | `TASKS.md:169` |
| Copy awaiting founder review | 205 keys in `PENDING_FOUNDER_REVIEW` (review 31 counts 416 of ~503 catalog paths, ~334 public, by leaf path) | `web/src/core/i18n/catalog-governance.ts:925–1354` |
| Clustering fit decisions | 18 `FIT_DECISIONS` | WORKLOG 2026-10-11 |
| V2 / V3 founder questions | V2-Q*, V3-Q1…Q* | `V2-FEATURES.md` §7, `V3-FEATURES.md` §7 |
| External accounts | 10 rows unopened | `EXTERNAL-ACCOUNTS.md` |
| Legal | ЕООД, lawyer, DPAs, L-10 | `docs/legal/launch-checklist.md` |
| Funding | Eurostars skip/go due 2026-09-01, outcome unrecorded | TASKS §1 |
| Live data | the 2027 season starts after the launch it should grade | `GATES.md` §4 |

None of these can be produced by an agent session. Every remaining Opus-hour of v1 work sits
behind at least one row of this table.

---

## 4. The eight round-5 seats

| # | Seat | Prior reviews folded in | What the built system exposes that the prior review could not see | Code |
|---|---|---|---|---|
| [25](25-principal-architecture.md) | Principal architecture (as built) | 01, 02, 13 | Conformance to ADRs and ports & adapters at 141k lines; oversized modules; dark code (unregistered routes, an unwired digest, the FireSat adapter not wired into the worker); a 037–059 migration gap; single-VM capacity with V2/V3 loops resident; the cost of building ahead of v1 | ARCH |
| [26](26-product-delivery.md) | Product & delivery | 07 (product), 10 (product), 15, 20, 22 (progress signal) | Scope discipline after V2 and V3; a stale progress signal; the size and age of the founder queue; a critical path to May 2027 that runs through non-agent work; the missed season against CP1/CP2 and K1 | PROD |
| [27](27-sre-platform.md) | SRE & platform | 04, 21, 23 (archive ops) | Which of review 21's E1–E10 landed; CI red for 34 days; branch protection; deploy pipeline; Ubuntu 26 runners; local-only tile and DEM assets; the operating load of a solo founder in a season | SRE |
| [28](28-security-privacy.md) | Security & privacy | 05, 09 (privacy), 14 (security) | Staff auth (WebAuthn, TOTP, sessions, offboarding); webhook SSRF and DNS pinning; envelope keyrings; erasure completeness against 37 migrations; client-direct third-party calls; a public repo | SEC |
| [29](29-qa-test-engineering.md) | QA & test engineering | 06, 14, 22 (gates) | What "green" means when the local gate excludes integration; diagnosing the failing test; how much the 8.5k tests are worth; flakes and OOMs; whether launch gates can be measured without live data | QA |
| [30](30-fire-data-science.md) | Fire domain & data science | 03, 11, 12, 23 | Unfitted parameters (score v0, clustering, `firesat_confidence_v0`); what the lost season costs; honesty of outlines, growth direction and agreement; Balkan false-positive suppression; a winter plan on archive data | DATA |
| [31](31-frontend-ux-accessibility.md) | Frontend, UX & accessibility | 07 (UX), 08, 16 (copy), 19 | Over 30 map features before launch; critical-path bytes over budget; never-say-out across V2 surfaces; the i18n review backlog; an open WCAG target; no PWA | UX |
| [32](32-legal-business.md) | Legal, licensing & business | 09, 10, 16 (liability), 18 | A public repo with no ЕООД, lawyer or DPAs; licences for every V2/V3 input; a past-due Eurostars decision; CP1–CP3 after a missed season; whether B2B features pull the product off its civic thesis; solo-founder sustainability | BIZ |

Why eight and not twelve:

- Architecture and backend (01, 02) now read the same code, so they are one seat.
- Geodata, data science, fire domain and data stewardship (03, 11, 12, 23) all rule on the
  same few parameters and on one archive, so they are one seat.
- Product and UX split along the line the code draws. 26 owns *what to build and when*;
  31 owns *what the built screen does*.

---

## 5. Seats folded, rejected and considered

### 5.1 Earlier seats not commissioned separately

| Earlier seat | Disposition | Where its ground is covered in round 5 |
|---|---|---|
| 13 Second-round audit | folded | each seat's Appendix B; 25 for doc-to-code conformance |
| 14 Corner cases | folded | 28 (abuse cases), 29 (test register) |
| 15, 20 Gap analyses | superseded by this review | §2, §5 |
| 16 Editorial & curation | split | 31 (copy, never-say-out), 32 (liability) |
| **17 Hardware, RF & field engineering** | **rejected** | T-C fails. No hardware, RF or field component was built after review 17, so nothing new exists for this seat to read. Re-test when a field sensor or a broadcast channel appears in a work plan. |
| 18 Support & continuity | split | 27 (operating load), 32 (sustainability, bus factor) |
| 22 Engineering practice | split | 26 (progress signal, scope), 29 (definition of green) |
| 23 Data stewardship | split | 30 (datasets, fit citation), 27 (archive operations, assets) |

### 5.2 New candidate seats, tested with T-A / T-B

| Candidate | Result |
|---|---|
| Programme / portfolio management for agent waves | Owned by 26. The wave mechanics are a delivery question, not a separate seat. |
| B2B / public-sector sales (V3-G1 municipal, V3-D API) | Owned by 32 (positioning). It becomes a seat only after CP3 decides on paid tiers. |
| FinOps | Owned by 27 (cost model) and 32 (funding). The infrastructure is still €0. |
| DBRE | Owned by 25 (schema, migration ranges) and 27 (restore). |
| ML engineering / MLOps | Rejected. Nothing is learned at runtime. Fits are offline and owned by 30. |
| Crisis communications | Owned by 16 and `OPERATIONS.md` §10. Nothing new was built. Re-test at K1. |

---

## 6. What this round changes in the shared documents

1. **`docs/reviews/24`–`32`** are added.
2. **`00-summary.md`** gets a round-5 synthesis: the cross-seat themes, the ranked top
   risks, the consolidated founder questions, and a recount in "Where the corpus stands".
3. **`TASKS.md`** gets a new **Track R5**, with one task per actionable recommendation from
   reviews 25–32. Rows use each review's Appendix A and keep the `Spec / Writes / Done when
   / Est / Status` contract. This reverses review 20 §6.5 ("TASKS.md is not edited by this
   round"), because the founder explicitly asked for the reports to be placed in the
   roadmap. The founder still dispatches the rows (TASKS §0 rule 7). They are placed in the
   roadmap, not executed by this round.
4. **`RISKS.md` and `GATES.md` are not edited by this round.** The proposed rows are
   collected in the round-5 synthesis, and Track R5 carries a task that lands the accepted
   ones. Gates change only by founder decision.
5. **`README.md`** gets its documentation-map row and status line updated for five rounds
   and 32 reviews.

---

## 7. Open questions this analysis raises

1. **Stop or slow V3?** The V3 work plan is being executed while the v1 critical path waits
   on non-agent work. Recommended: freeze V3 lanes that add new external obligations
   (sources, B2B, personal data) until v1 runs on a host. Allow only V3 work that reduces v1
   risk. Review 26 gives the full answer.
2. **What is "green"?** Recommended: green means the remote CI run on the pushed commit,
   including integration, and `main` is protected so that only green commits land.
   Review 29 specifies the rule; review 27 sets the protection.
3. **Rebase the release-progress table.** Recommended: re-run the skill after Track R5 lands,
   with V2 and V3 explicitly outside the denominator, and add a row for the founder queue,
   so that "blocked" has a size.
4. **Does the stopping rule hold?** Yes. Round 5 was a founder request, not a reflex. The
   next round should be triggered by the first production deploy, not by a calendar.

---

## Appendix A — Proposed rows for the shared documents

- **TASKS.md:** Track R5 header and rows. The rows come from reviews 25–32 Appendix A.
- **00-summary.md paragraph:** *Round 5 (2026-10-30) read the system as built through eight
  senior seats, seven months before launch. The project has about 141k lines of tested code,
  v1 complete up to the boundary of a host, and V2 and V3 underway. Nothing has ever run in
  production, the 2026 season was not recorded, remote CI has been red since 2026-09-26
  without anyone noticing, and the progress signal is stale. The round's work is to turn
  "built" into "running" and to shrink the founder queue, not to add scope.*

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| 180 commits; `main` 2 ahead of origin | `git rev-list --count HEAD`; `git rev-list --count origin/main..HEAD` |
| Commits per day | `git log --format=%ad --date=short \| sort \| uniq -c` |
| Source and test sizes | `find … -name '*.ts*' ! -name '*.test.*' \| xargs wc -l`; file counts by `find` |
| 37 migrations, `060` present | `find server -path '*/migrations/*.sql'` |
| CI red since 2026-09-26; the failing job and test | `gh run list --branch main`; `gh run view 40939772318 --log-failed` |
| Release progress 71.9 % at `fb97640` on 2026-10-13 | `docs/TASKS.md:9–23` |
| 51 ticked / 72 open, per-track counts | `awk` over `^- \[x\]` / `^- \[ \]` grouped by `## Track` |
| 17 pending founder decisions | `sed -n 169,219p docs/TASKS.md \| grep -c '^- '` |
| 205 keys pending founder review | quoted entries between `catalog-governance.ts:925` and the closing `]` at `:1354` |
| Local asset sizes | `du -sh tiles tiles-dem data` |
| No host, accounts or legal entity | `docs/EXTERNAL-ACCOUNTS.md`; release-progress "Blocked by"; WORKLOG |
