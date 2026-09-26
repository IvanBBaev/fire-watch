# Review 20 — Round 4: which seats the implementation opened

*Reviewer role: review-corpus owner. Date: 2026-09-02. Status: complete.*
*Inputs reviewed: `reviews/15`–`19`; `docs/TASKS.md` (§0 execution contract and the task
state on 2026-09-02); `infra/README.md`, `infra/provision.sh`; `docs/OPERATIONS.md` §6 and §9;
`docs/EXTERNAL-ACCOUNTS.md`; `docs/licenses/`; `docs/spikes/`; `.github/workflows/ci.yml`,
`renovate.json`, `pnpm-workspace.yaml`; the `server/`, `web/` and `packages/` source trees as
they stand uncommitted on 2026-09-02; `server/fixtures/`; the WORKLOG sessions 2026-08-09 →
2026-09-02. The project is in implementation (WP0–WP2).*

---

## 1. Summary verdict

**Three seats are missing, all three opened by implementation rather than by design, none
fatal, and all three have the shape review 15 called dangerous: the artifacts exist and the
decisions behind them do not.**

1. Review 15's stopping rule — *a new review is commissioned only when a document written
   after the corpus closed creates a decision nobody owns* — was applied literally to every
   document and artifact class written after the corpus closed in July 2026 (§2.2). Fourteen
   were tested. Eleven have an owning section. Three do not, and each of the three is a
   *practice* seat, not a *domain* seat: nothing here fails because nobody understood fire,
   geodata or licensing. Things fail because the code is now larger than the plan that
   describes it, and the plan has no rule for that.
2. **Seat 1 — Platform & release engineering** (§4.1, [review 21](21-platform-release-engineering.md)).
   `infra/README.md` names a decision it refuses to take and calls it "a §9-level policy
   decision"; the deploy pipeline that `OPERATIONS.md` §9.3, `infra/README.md` and TASKS J4
   all assume does not exist; the one supply-chain override in the repository's history has no
   policy behind it. Cost of rediscovery: the shadow season's tier-1 definition of done is
   dated "early September 2026" and there is no VM, no account and no path to one.
3. **Seat 2 — Engineering practice & delivery for an agent-built codebase** (§4.2,
   [review 22](22-engineering-practice.md)). Six commits, all dated 2026-08-09; since then
   eighteen sessions, roughly 35,000 lines of untracked TypeScript source, 86 untracked test files
   against 44 tracked ones, and no commit and no CI run. The execution contract's rule 4 is
   the only integration rule in the project, and it is a permission rule for humans, not a
   rule about the repository. This cost compounds daily.
4. **Seat 3 — Data engineering & archive stewardship** (§4.3,
   [review 23](23-data-engineering-stewardship.md)). `OPERATIONS.md` §6.2 rule 11 says, in
   those words, that the detection-retention policy has "no owner"; the corpus the D7 fit will
   run on has a plan version but no dataset identity; the re-cluster half of a monthly
   promotion is a documented no-op; six weather fields are recorded and three have no named
   consumer. Cost of rediscovery: a fit nobody can cite, or a partition swap that quietly
   rewrites alert history — found in winter, when the season it affects cannot be re-recorded.
5. Fire meteorology was re-tested against `weather_context_v1` and stays rejected: the project
   consumes weather and FWI, it does not compute them, so review 15's trigger is not met (§5).
   The surviving delta is a data fact — fields without consumers — and goes to review 23.
6. Every other candidate — governance and the second person, privacy, measurement,
   documentation, independent evaluation, localisation, community, FinOps, crisis
   communications, cartography, frontend performance, DBRE — remains owned (§5). Three of the
   owning sections carry deadlines that are now rather than later (§7).
7. The shared documents change as listed in §6.

**GO is conditional on** reviews 21–23 being read as decisions to take this month rather than
as design. The seats they fill are the ones a single founder cannot leave empty for a season:
when nobody owns the deploy path, the integration cadence or the dataset, the code takes those
decisions by default, and it takes them silently.

---

## 2. Method — what counts as a gap

### 2.1 The two tests, unchanged from review 15

- **T-A, decision ownership.** Is there a section in the corpus, an ADR, or a shared document
  that *makes* the calls this role would make — not mentions them, makes them?
- **T-B, artifact ownership.** Does a plan, gate or definition of done name a deliverable of
  this role with an owner?

A seat is missing only when both fail. Passing T-B while failing T-A is the dangerous shape:
the artifact exists, so nobody notices that its decisions were never taken.

### 2.2 The stopping-rule test, applied document by document

Review 15 §7.3 fixed the rule for commissioning any further review. Round 4 is that rule
executed, not a fourth pass over the design. Every document or artifact class written after
the corpus closed was asked one question: *does this create a decision, and does anyone own
it?*

| Post-corpus document or artifact | Decision it creates | Owner found | Result |
|---|---|---|---|
| `infra/provision.sh` + `infra/README.md` (2026-08-13, TASKS B9) | How the host receives its contract under Hetzner's 32 KiB `user_data` cap; the deploy pipeline; the restore credential and runbook | `OPERATIONS.md` §9 owns the *content* of the host contract; [04 §5.6](04-sre.md) sketches a workflow in eight lines. Nobody owns the pipeline or the cap decision — the README says so itself (`infra/README.md:99–101`) | **opens seat 1** |
| `.github/workflows/ci.yml`, `renovate.json`, `pnpm-workspace.yaml` overrides (2026-08-09) | Who may override an advisory or exclude a package from the cool-down, with what justification and expiry | [05 §5.6.1](05-security.md) owns review of *new* dependencies; the override precedent in commit `c63b2f8` has no rule | seat 1 |
| `docs/TASKS.md` §0 execution contract (2026-08-09) | Integration cadence; what an agent may decide; what "done" means before a task is dispatched again | Rule 4 ("never commit or push unless asked"); [06](06-qa.md) has no review, branch or merge policy; [01](01-architect.md) none | **opens seat 2** |
| The uncommitted tree and WORKLOG 2026-08-12 → 2026-09-02 | When work reaches a commit and CI; who reviews agent output; fixture authorship quality; doc-to-code conformance | Nobody. 06 §5.7 owns the *release* regime, not the *integration* regime; the S14 hour correction (WORKLOG 2026-08-31) had no owner and was fixed by whoever noticed | seat 2 |
| `server/fixtures/` S1–S16 and `core/replay/register.ts` | What a fixture may assert; how an expected trace is derived | 06 and `GATES.md` §1.1 own the register and its `blockedBy` honesty; the *authorship* standard is unowned — two hand-derived traces were wrong (WORKLOG 2026-09-02) | seat 2 |
| `OPERATIONS.md` §6.4 archive notes (2026-08-12) + `core/backfill/backfill-plan.ts` | The corpus as a dataset: version, identity, second copy, retention | [18 §5.5](18-support-continuity.md) owns survival; [03](03-geodata.md)/[04](04-sre.md) own the mechanics; §6.2 rule 11 records retention as having "no owner" | **opens seat 3** |
| `core/promotion/*`, `adapters/promotion/*` (2026-08-13, 08-31) | Lineage after an NRT→SP swap; who fits the sanity band; who signs the first swaps | ADR-002 A1.4 owns the *order* of a promotion; nobody owns the lineage or the signature; the re-cluster step is `noop-month-recluster.ts` | seat 3 |
| `core/config/weather-context.ts`, `adapters/weather/*`, `adapters/effis/*` (C4) | Which fields are recorded for which consumer; how long poisoned overlays are kept | [12 §5](12-fire-domain.md) and [07](07-product-ux.md) P9 own display; [11 §5.7](11-data-science.md) + `DATA-SOURCES.md` §E2 own the cloud proxy; `2t`, `2d`, `tp` have no consumer named anywhere | seat 3; meteorology re-tested in §5 and rejected |
| `docs/licenses/*` (2026-08-15) | Input licence snapshots | [09 §2.3.5](09-legal-licensing.md) | owned |
| `server/src/app/logging.ts` redaction (2026-08-15) | Secret shapes in logs | [05 §5.4](05-security.md); WP1 hardening list | owned |
| `docs/EXTERNAL-ACCOUNTS.md` | Account inventory; the DPA column | 05 §5.3 and WP7; the Hetzner row feeds seat 1's timing, not its ownership | owned |
| `docs/spikes/b6`, `b7` | Frontend bundle and rendering findings | [08 §5.5](08-frontend.md); CI-12 | owned |
| `core/config/alert-gating.ts`, `lifecycle-params.ts`, `registry/alert-state.ts` (D2, D4, D9) | Rule versions; placeholder weights | ADR-002/ADR-004; 11 §5.7; the fit is *owed* (D7), not ownerless | owned |
| `web/` client (2026-08-12 → 08-26) | Product calls made in passing — e.g. `COVERED_AREA` not widened | 07, 08, ADR-005; the decision is recorded in WORKLOG only | owned; decision-log delta → §7 Q3 |

### 2.3 What is different about round 4

Rounds 1–3 tested a *design*. Round 4 tests an *implementation*, and three things follow.
First, the seats it opens are practice seats: how the thing is built, shipped and kept, not
what it is. Second, T-B passes almost everywhere — code is an artifact, and every task in
`TASKS.md` names an owner — so T-A is the only discriminating test, and the analysis below
leans on it. Third, the cost of rediscovery is no longer measured in re-design. It is measured
in days of a season that cannot be re-recorded, and in the interest on unreviewed code.

---

## 3. What round 3 settled and what it left conditional

Round 3's four seats landed as written: L-15 and L-16 in `GATES.md` §3, three watchlist rows
in `RISKS.md` §2, the continuity file and the editorial standard as WP-level work. The founder
decisions it named — the second person, the identity question, the accessibility target —
remain the founder's, with deadlines that have not moved.

Review 15 also wrote two conditions that round 4 is obliged to test:

- **§5, meteorology:** "A met seat becomes real only if we ever *compute* FWI rather than
  consume it." Tested in §5 below. Not met.
- **§7.1, data stewardship:** folded into 18 §5.5 with the sentence "If the archive ever
  acquires obligations of its own — a funder's open-data condition, an institutional mirror —
  it deserves separating out." Tested in §4.3 below. The seat is separated out, on different
  grounds than 15 anticipated: the obligations that arrived are not a funder's, they are the
  project's own — a fit that must cite a dataset, a swap that must preserve lineage, a
  retention rule that a shared document says nobody owns. Review 23 is asked to rule on
  whether 15's original condition is also met.

Review 15 §7.2 settled who decides disagreements between reviews: the founder. Round 4 keeps
that, and every review below is instructed to state disagreements in its §6 rather than apply
them.

---

## 4. The three missing seats, ranked by what each changes

| Rank | Seat | Review | What it changes that no filled seat would catch | Cost of rediscovery |
|---|---|---|---|---|
| 1 | Platform & release engineering | [21](21-platform-release-engineering.md) | Whether the shadow season records at all. The provisioning script stops at a decision it will not take; the deploy pipeline is assumed by three documents and exists in none; secrets delivery to the VM is undefined; the supply-chain override precedent has no policy; the restore path is an exit-64 stub. Every other seat's work waits on this one for a host. | Days of an unrepeatable season. WP1 tier 1 is "hard, unrecoverable — early September 2026"; today is 2 September and there is no Hetzner account. |
| 2 | Engineering practice & delivery for an agent-built codebase | [22](22-engineering-practice.md) | When agent output becomes a commit and runs in CI; who reviews it and against what; what a fixture may assert and how its expected trace is derived; how the plan's progress signal stays honest when done-when depends on a VM; how doc-to-code drift is caught mechanically. | Compounding. 24 days of unreviewed, uncommitted, CI-unrun code on one machine, growing by a session a day; a latent bug of the kind CI found on 2026-08-09 now has 35,000 lines to hide in. |
| 3 | Data engineering & archive stewardship | [23](23-data-engineering-stewardship.md) | Which dataset a fit cites and what triggers a refit; what an alert row and a permalink show after an NRT→SP swap; the retention and format of every artifact class; whether the archive is published and under what terms; where land cover comes from and why every `fuelBand` is `null`. | Slow and expensive. A CP1 report on a corpus nobody can reproduce, or a promotion that rewrites alert history, discovered when the season it affects is over. |

### 4.1 Seat 1 — Platform & release engineering

**Decision surfaces.** (a) The 32 KiB `user_data` cap: slim the host contract, fetch it
out-of-band from a pre-signed URL, or bootstrap minimally and pull a signed bundle — and the
trust boundary of whichever is chosen. (b) The deploy pipeline itself: image build and
registry, `deploy.yml`, `deploy.sh <sha>`, `last_good`, migration ordering between the schema
owner and the runtime role, the one-deploy-path rule, rollback, prod smoke without a staging
environment (04 §6 Q7). (c) Secrets delivery: nothing in `user_data`; where the FIRMS key, the
database passwords, the R2 keys, the backup key and the heartbeat slug live and how they
rotate. (d) Supply-chain override policy: who may add a `pnpm` override or a cool-down
exclusion, with what justification and expiry; how `renovate.json` and `pnpm-workspace.yaml`
stay in step. (e) The restore path: the `--restore-from` stub, RB-2, the restore credential,
C6's "restore onto a scratch VM", and its ordering relative to the poller (13 B2:
protection before recording). (f) Drift detection for the host contract as a mechanism, not a
discipline. (g) The minimum viable path to recording in the next week.

**T-A.** Fails. `OPERATIONS.md` §9 states what the host must be; 04 §5.6 states that a
workflow should exist; neither takes the decisions above, and `infra/README.md` says of the
first one that it is "a §9-level policy decision, not a provisioning-script default" and
leaves it. **T-B.** Passes for provisioning (B9) and backups (C6); fails for the pipeline — no
task in `TASKS.md` names it, J4 wires *gates* into a pipeline it assumes.

**Why rank 1.** It is the only seat on the critical path of the calendar. The season-window
dependency is already the first row of `RISKS.md` §2; this seat is the one that decides
whether that row's response ("recording by early Sep 2026") is met.

### 4.2 Seat 2 — Engineering practice & delivery for an agent-built codebase

**Decision surfaces.** (a) Integration cadence and the unit of review: when agent output
becomes a commit; whether `main` is protected and by which jobs; whether a PR per task or per
wave. (b) Review of agent-generated code by a single human: what is read line by line and
what the gates absorb; whether a second agent reviews adversarially; review of the *tests*,
since the tests are where the two wrong traces lived. (c) A test-quality standard: hand- versus
machine-derived expectations, final-report-only `expected.json`, constructed geometry against
replayed history, the two earth models that disagree by 0.2 %. (d) The progress signal: tasks
with landed code and unmet done-when — C4, C5, C7, C8, D2, D4, D5, D9 — sit unticked, so the
tally (32 ticked, 66 open) under-reports the state of the build. (e) Doc-to-code conformance
as a mechanism: the S14 hour drift was found by a test and fixed by hand. (f) The dispatch
model: disjoint file sets, the serialisation rule, what an agent may decide, where founder
decisions are logged. (g) The uncommitted tree as a single-copy artifact.

**T-A.** Fails. `TASKS.md` §0 rule 4 is a permission rule for humans; 06 owns test strategy
and the release regime and says nothing about review, branching or merging; 15 §7.2 names the
founder as the decider of disagreements but not as the reviewer of code. **T-B.** Passes
trivially — every session produced artifacts and a WORKLOG entry — which is exactly the
dangerous shape: the artifacts are so abundant that their lack of integration is invisible
from inside the plan.

**Why rank 2.** The cost is not a single event but a rate. CI last ran on 2026-08-09 and found
three independent latent bugs the moment code that had never executed was executed; the same
class of bug now has the whole D-track to hide in.

### 4.3 Seat 3 — Data engineering & archive stewardship

**Decision surfaces.** (a) The corpus as a versioned dataset: what the D7 fit report cites
(plan id, manifest digest, `--check` result), what triggers a refit (NOAA-21 SP appearing,
a FIRMS collection reprocessing, a promoted season), a dated dataset record. (b) Lineage across
a promotion: what an alert row and a permalink show once NRT rows are swapped for SP under
I1, with the re-cluster hook a no-op and `event_detections` references blocking the swap.
(c) Retention: the policy 04 §6 Q6 asked for and §6.2 rule 11 says nobody owns; the concrete
format of C6's "season archive"; what "no longer single-copy" means per artifact class.
(d) Publication: the output licence (18 §6 Q2), a second copy outside our infrastructure, a
citation, and what the input licences in `docs/licenses/` permit to be redistributed at all.
(e) Static data: land cover, the hot-source mask, the cloud join (D10) — source, licence,
version, refresh. (f) Quality of the recorded feeds as data products with owners: parity,
lag histograms, fields without consumers, poison evidence. (g) What the season must record
now because it cannot be backfilled later.

**T-A.** Fails. 03 owns partitioning and the swap mechanics, 04 owns backups, 11 owns the
fitting protocol and the splits, 09 owns the input licences, 18 §5.5 owns survival. None of
them says which dataset a fit cites, what a permalink means after a swap, or how long a
detection is kept; one of them says in writing that the last of these has no owner.
**T-B.** Passes for the machinery (B8, C6, C7, C9, D10) and fails for the dataset: no task
names a dataset record, a retention decision or a publication decision.

**Why rank 3.** Nothing here breaks in September. All of it breaks in the winter fit and the
first real promotion, which is why it is the seat most likely to be left empty until then.

---

## 5. Roles considered and rejected — with the section that already owns the ground

| Candidate role | Rejected because | Surviving delta, and where it goes |
|---|---|---|
| **Fire meteorology** (re-test of 15 §5) | `weather_context_v1` records six ECMWF surface fields at three steps from four runs; FWI arrives from EFFIS as an image. Nothing computes an index, so 15's trigger — "only if we ever *compute* FWI" — is not met. Display of weather context is owned by [12 §5](12-fire-domain.md) (v1 wind hints) and 07 P9; the cloud proxy by 11 §5.7 and `DATA-SOURCES.md` §E2. | `2t`, `2d`, `tp` are recorded with no named consumer. That is a data-engineering fact, not a meteorological one → review 23 §5.6. A met seat is re-tested only if a fuel-dryness or spread feature is *computed* in-house. `DATA-SOURCES.md` §D6 already pencils in an own-FWI computation off the ECMWF fields; the day that line becomes code is the day 15's trigger fires (11 §5 would be the first to know). |
| **Governance / the second person** | A seat that is a person, not a review; [16 §6](16-editorial.md) and [18 §6](18-support-continuity.md) already converge on the recruit and the founder owns the decision. | Founder decisions made in passing — `COVERED_AREA` not widened (WORKLOG 2026-08-26), the identity question, WCAG version, the second person — have no home except the journal → §7 Q3. |
| **Privacy / DPO** (re-test with `EXTERNAL-ACCOUNTS.md`) | The DPA column feeds the WP7 processor register that [05 §5.3](05-security.md) already specifies; nothing post-corpus adds a data category. | None. |
| **Product analytics / measurement** | CP2's "alert-armed weekly users" and the checkpoint metrics are defined in [10 §6](10-business-gtm.md) and `GATES.md` §4; K1 owns instrumentation; 05 §5.3 constrains it. No post-corpus document touches measurement. | Revisit when K1 is dispatched, not before. |
| **Documentation / knowledge management** | The ADR precedence rule, `TASKS.md` §0, the dated-notes convention (`DATA-SOURCES.md` §A9) and CI-13/CI-15 already govern what is written where. | Doc-to-code drift as a mechanism → review 22 §5.5. |
| **Scientific validation / independent evaluation** | [06 §5.1](06-qa.md), [11 §9](11-data-science.md), 16 §5.1 (blinding) and the CP1 protocol in `GATES.md` §4 own it. | The protocol is due "September 2026" and `docs/reports/` does not exist → §7 Q2. |
| **Localisation** | [19](19-accessibility-inclusion.md) §5.7, 07, 16. | None. |
| **Community / partnerships** | 10 §4, 18 §5.6. | None. |
| **FinOps** | [04 §5.7](04-sre.md), 10 §2 and §9, R3. | The three-year tail rule of 17 §5.1 already covers hardware; VM sizing lands in 21 §5. |
| **Crisis communications** | 16 §5.2–5.3, 04 App. B, `OPERATIONS.md` §10. | None. |
| **Cartography / map design** | 08, 03, ADR-001, ADR-005 D4. | None. |
| **Frontend performance** (spikes b6, b7) | 08 §5.5, CI-12; the spikes are inputs to those, not new decisions. | None. |
| **DBRE** (re-affirmed) | 03 §5.4–5.7, 04 §5.5–5.6, `OPERATIONS.md` §6 own the database. Seat 3 is deliberately not this: it owns *what* exists and *which version* a result cites, not how Postgres keeps it. | Where 23 needs a mechanism (a parquet export, a partition detach), it asks 03/04 rather than specifying one. |
| **Fixture / test-data engineering** | Half is a practice question (how an expected trace is derived) and half a data question (replayed history instead of constructed geometry). | Split: authorship standard → 22 §5.3; real-history replay corpus → 23 §5.1. |

---

## 6. What this analysis changes in the shared documents

1. **`RISKS.md` §2** gains one watchlist row per new review, carrying each review's R-1:
   the deploy path and the season clock (21), the unintegrated tree (22), the archive without
   a dataset identity (23). Landed with this round.
2. **`GATES.md` §3** gains a launch gate only where a review yields something checkable that
   L-12 (season deploy regime), L-13/L-14 (calibration, constellation replay) or CI-1…CI-15
   do not already cover. Reviews 21–23 each say in their return whether they propose one; the
   outcome is recorded in `00-summary.md`'s round-4 synthesis.
3. **`README.md`** status paragraph and documentation-map row are updated for four rounds and
   twenty-three documents.
4. **`00-summary.md`** gains a round-4 synthesis and a recount in "Where the corpus stands".
5. **`TASKS.md` is not edited by this round.** It is the founder's execution plan; the three
   reviews propose tasks in their §4, and §7 below lists the ones with deadlines. Dispatching
   them is the founder's act (TASKS §0 rule 7), not the corpus's.

---

## 7. Open questions this analysis itself raises

1. **Does the stopping rule survive a fourth round?** Proposed amendment, for the founder:
   after round 4 the corpus grows only on a founder request that names the ownerless decision.
   The practice seats are the last structural gap a review can fill; what remains is
   decisions, gates and code, and a review commissioned by reflex would be a way of not
   taking them.
2. **Three deadlines are now.** The CP1 protocol must be written "in September 2026 — before
   the season it grades" (`GATES.md` §4) and its home, `docs/reports/`, does not exist;
   WP1 tier 1 is dated "early September 2026" and C1 is open on 2 September; C6's protection
   must precede the poller (13 B2). Decider: the founder, with 21 §5.7 as the sequence.
3. **Where do founder decisions live?** Round 3 named three; the WORKLOG has since recorded
   product calls made in passing with the note "left to the founder". Proposed: `TASKS.md` §1's
   founder-only list gains a *pending decisions* block, each entry with a date and the
   document that asked. Decider: the founder. *Landed 2026-09-03 in `TASKS.md` §0, next to
   the task-status rules rather than in §1: fifteen lines, each with the asking document,
   the date deferred and a due date.*
4. **Does review 22 override `TASKS.md` §0 rule 4?** No, and it must not try. Rule 4 is a
   rule about who may commit; 22 is asked for a rule about when work *should* be integrated
   and what verifies it. The two coexist: the human still says "commit", but the plan says
   how often and against what. If 22 proposes anything that would make rule 4 false, that is
   escalated in its §6, not applied.
5. **Is 15 §7.1's condition met independently of this round's grounds?** Review 23 is asked
   for a one-sentence ruling. If yes, 18 §5.5 receives an amendment pointing to 23 rather than
   a rewrite.
6. **Does round 4 change the identity of the corpus?** Rounds 1–3 were reviews of a design by
   twelve roles. Round 4 is a review of a build by three practice roles, and the summary
   should say so rather than count them together as "role reviews". Recorded in
   `00-summary.md`; decider: nobody, it is a description.

*End of analysis. Reviews 21–23 follow the house format of 16–19 and are commissioned by §4.*
