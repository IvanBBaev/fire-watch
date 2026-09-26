# Review 22 — Engineering practice for an agent-built codebase

*Reviewer role: staff engineer (integration cadence, review of agent-written code, test-quality standard, progress signal, doc-to-code conformance, dispatch model). Date: 2026-09-02. Status: complete.*

*Inputs reviewed: git history and working tree (measured, Appendix B), `.github/workflows/ci.yml`, TASKS §0 rules and the §1 tally, WORKLOG entries 2026-08-09 → 2026-09-02, review 06 §5.2 and §5.7, review 05 §5.6.1, `server/src/core/replay/register.ts`, `server/fixtures/README.md`, `server/fixtures/harness-smoke/`, review 20 §4.2, review 21 §5.3. Project is in implementation (WP0–WP2).*

---

## 1. Summary verdict

**CONDITIONAL GO — the engineering discipline in the tree is better than most teams' and the delivery discipline around the tree does not exist.** The code has a golden-replay harness that caught two wrong hand-derived traces in one session, a fixture register that refuses to clear a flag "to make it pass", config-as-data with digests, and a CI that runs a determinism double-run. None of that has run on the code that exists. Six commits, all on one day three and a half weeks ago; since then eighteen sessions of work by dispatched agents sit as a single uncommitted copy on one machine, larger than the committed codebase, never executed by `ci.yml`, reviewed by exactly one person reading agent summaries. This is not a quality problem. It is an integration problem, and integration problems compound.

1. **The tree is unintegrated, CI-unrun and single-copy** (§5.1, R-1). Measured: 208 untracked TypeScript source files, 34,968 lines (plus 194 generated `.d.ts` files under `web/dist-types/`); 51 tracked files modified; 86 of the 130 test files untracked; last CI run 2026-08-09. `ci.yml` triggers on push to `main` and on pull requests, and nothing has been pushed. Every gate the project designed is a gate on code that has not reached it.
2. **TASKS §0 rule 4 is correct and is being read as a reason not to integrate** (§5.1, R-1). "Never `git commit`/`git push` unless the dispatching human asks" governs the agent. It does not say the human should not ask. Nothing in the rules says when work is *integrated*; the tree shows the answer has become "never, so far". This review proposes a rule 8 that the founder adopts or rejects; it does not touch rule 4 (review 20 §7 Q4).
3. **Review of agent-written code has no standard** (§5.2, R-2). The reviewer is the dispatcher, the input is the agent's summary plus a green harness, and the harness is the agent's too. The two places where a human read the code closely were both prompted by failure (CI on 2026-08-09; S14 on 2026-08-31), and both found real defects.
4. **Test expectations are hand-derived and the harness has now caught the hand twice** (§5.3, R-3). WORKLOG 2026-09-02: "Two hand-derived traces were wrong and the harness caught both." The harness was right; the process that produced the wrong traces is unchanged. `expected.json` asserts outcomes, not internals — by review 06 §5.2's explicit design — and the corpus is constructed geometry (WORKLOG 2026-08-31).
5. **The plan's progress signal under-reports by design** (§5.4, R-4). TASKS says done means checked; done-when clauses for C1, C4, C7 and others need a host; the code for them has landed. The tally reads 32 ticked, 66 not, and cannot distinguish "not started" from "built, waiting for a VM". The status paragraphs carry the truth, and nobody reads ninety-eight status paragraphs.
6. **Doc-to-code drift is found by accident** (§5.5, R-5). S14's timing in GATES read 02:30 while the passing test said 03:30 — "a doc drifting away from a passing test" — and was found because a session happened to re-read GATES. The project has digests for config-as-data and nothing for the numbers that live in prose. **Status 2026-09-07:** GATES was corrected on 2026-09-03 and review 14, which held two more copies of the same number, on 2026-09-07 — by re-reading again. The finding stands: three corrections, no mechanism.
7. **The dispatch model works and is nowhere written** (§5.6, R-6). Disjoint file ownership per agent, seams written first, a fixed harness the agents cannot negotiate with; one agent died mid-work on 2026-08-09 and the file-ownership rule is why that was recoverable. It should be five lines in TASKS §0, not folklore in WORKLOG.

GO is conditional on §4 E1 (integrate now, in dependency order, CI green each step) being asked for by the founder this week — it is a founder act by rule 4 — and on E2's rule 8 being adopted or explicitly refused. Everything else in this review is cheaper after E1 and harder before it.

## 2. Strengths (sound as proposed)

- **The harness is adversarial to its authors.** Determinism double-run in CI, a register whose `blockedBy` flags are data and "never cleared to make it pass", scenario fixtures with `engine`, `configVersions` and `mode` declared in the manifest. This is the right posture for code an agent wrote: the check does not trust the checker.
- **Config-as-data with digests.** `polling_bbox_v1`, `clustering_params_v1`, `alert_gating_v1`, `lifecycle_params_v1`, `weather_context_v1`, `freshness_budgets_v1`, `sp_swap_sanity_v1`, `pass_table_v0` — every tunable is a versioned object with a pinned digest and a test. Drift in a *parameter* is impossible to miss. The gap (§5.5) is the numbers that are not parameters.
- **Seams first.** WORKLOG 2026-09-01: "Wrote the seams first so three parallel agents could not negotiate them." That is the correct order and it should be the written rule (E7).
- **`ci.yml` is a complete verify stage** — see [review 21](21-platform-release-engineering.md) §2. The gate is good; it is unfed.
- **The WORKLOG is an honest engineering journal.** Wrong assertions are recorded as wrong; agents that died are recorded as dead; founder decisions are recorded as pending. Most of this review's evidence is the project's own record of itself.
- **TASKS §0 rules 1–7 are the right rules for the agent.** This review adds one; it removes none.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | The working tree is the only copy of ~35,000 lines of unintegrated, CI-unrun code on one machine; a disk failure, a bad `git checkout`, or an agent's stray `git stash` loses 24 days. The latent-bug class CI found on 2026-08-09 (wrong assertions, not wrong code) has had no CI since. | §5.1 |
| R-2 | **High** | No review standard for agent output: what the human reads, what the gates absorb, what a second agent checks. The two close reads that happened were failure-prompted and both found defects. | §5.2 |
| R-3 | **High** | Test-quality: expected traces derived by hand and wrong twice; `expected.json` asserts only the final report, so a wrong intermediate that produces the right report passes; the corpus is constructed geometry with real `detection_uid`s, so it tests the engine's arithmetic, not the season's shape. | §5.3 |
| R-4 | **Medium-High** | The TASKS tally cannot express "code landed, done-when blocked on a host". The plan under-reports progress to anyone who does not read every status paragraph — the founder in October, the successor in review 18 §5.5. | §5.4 |
| R-5 | **Medium-High** | Doc-to-code drift for numbers in prose (gate timings, thresholds quoted in GATES/OPERATIONS) has no mechanism; S14 was luck. | §5.5 |
| R-6 | **Medium** | The dispatch model — file ownership, seams first, harness as arbiter, what an agent may and may not touch — lives only in WORKLOG. A session run without it (or by a successor) rediscovers 2026-08-09. | §5.6 |
| R-7 | **Medium** | Founder decisions are pending in the journal (`COVERED_AREA`, the sanity band, the cloud proxy) with no block in TASKS §1 listing them; review 20 §7 Q3 asks for the block. | §5.4 |
| R-8 | **Low-Medium** | WORKLOG is local-only by policy and is the only narrative of 24 days of decisions. Continuity (review 18) assumes a successor can read it; a lost laptop means they cannot. Not a policy change — a backup-of-the-journal question for 18 §5.5. | §5.6 |

## 4. Detailed recommendations

- **E1 [MVP] Integrate now, in dependency order, CI green at every step.** Maps to R-1. Sequence: `packages/contracts` → `server/src/core/config` and `core/replay` (harness first, so every later commit is checked by it) → `core/ingest` + adapters (B-track) → `core/backfill`, `core/promotion` (C-track) → `core/identity`, `core/lifecycle`, `core/alerting` (D-track) → `web`. One commit series per track, each pushed, each run by `ci.yml`, `main` protected by [review 21](21-platform-release-engineering.md) E5 before the second series. Expect `ci.yml` to fail on the first series — it found wrong assertions last time, and it will find some this time; that is the point. **This is a founder act under rule 4**: the agent prepares the series and stops; the founder says "commit".
- **E2 [MVP] Propose TASKS §0 rule 8 — "Integrated means committed and green."** Maps to R-1. Text for the founder to adopt verbatim or refuse: *"8. **Integrated means committed and green.** No session ends with more than one task of unintegrated work. At session end the agent prepares the commit series and asks; the dispatching human answers. Work that is not on `main` with CI green is not done, whatever the checkbox says."* Coexists with rule 4: the agent still never commits unasked; the rule says the human is asked every session.
- **E3 [MVP] A review standard for agent-written code.** Maps to R-2. Three tiers, by what changed: (a) *config-as-data and its digest* — the human reads the diff of the object and the rationale line; the digest test absorbs the rest; (b) *engine code under the harness* — the human reads the fixture diffs and the register diff, not the engine; a second agent with no access to the first's summary reviews the engine diff adversarially and must produce one failing fixture or a written "could not"; (c) *anything the harness does not cover* (adapters, CLIs, infra) — the human reads it. The standard is written into TASKS §0 as rule 9 or into `docs/ai/` — founder's call (§6 Q2).
- **E4 [MVP] Test-expectation standard.** Maps to R-3. Three rules: (1) an expected trace is *derived by the engine and reviewed by a human*, never hand-computed — the human reviews the rationale for each transition, the machine produces the numbers; (2) identity and lifecycle fixtures may assert the *trace* (per-cycle events and transitions) in addition to the final report — `expected.json` gains an optional `trace` block for S-series where the final report is degenerate; this narrows review 06 §5.2's "outcomes, not internals" rule and is escalated in §6 Q7, not applied; (3) any fixture whose geometry is constructed says so in its manifest (`geometry: constructed | recorded`) so that the register can report how much of the suite is real once WP1 records a season. The earth-model split (two constants, ~0.2 % apart, WORKLOG 2026-08-31) is resolved by one shared constant with a test, not a note.
- **E5 [MVP] Split the progress signal.** Maps to R-4, R-7. Each TASKS item gets two states: `[x]` done-when met, and a `[~]` marker meaning "code landed on `main`, done-when blocked on ⟨named blocker⟩". The tally line reports three numbers. A **Pending founder decisions** block at the top of §1 lists every decision the WORKLOG has deferred to the founder, with the date deferred (review 20 §7 Q3). Effort: an hour; it is the cheapest fix in this review. **Block landed 2026-09-03** in TASKS §0 (fifteen decisions, dated and due); the `[~]` marker waits on §6 Q4.
- **E6 [MVP] Doc-pinned numbers.** Maps to R-5. Every number in GATES, OPERATIONS or DATA-SOURCES that is also a constant in code gets a `doc-pins.test.ts` that reads the markdown and asserts the value — the S14 timing, the 56-day retention, the freshness budgets, the `MAX_ARCHIVE_DAY_RANGE`, the sanity band. The mechanism is fifty lines; the list is the work. Gate-shaped; proposed as CI-17 in §6 Q3.
- **E7 [v1] Write the dispatch model down.** Maps to R-6. Five lines for TASKS §0 or `docs/ai/`: file ownership is disjoint per agent and declared before dispatch; seams (types, ports, fixture formats) are written by the dispatcher before the agents start; the harness is the arbiter and no agent edits the register's flags; an agent that dies leaves only its own files touched; a session's agents are listed in WORKLOG with their file sets.
- **E8 [MVP] Back up the journal.** Maps to R-8. Not a policy change: WORKLOG stays untracked. It is included in the offline bundle review 18 §5.5 already requires, on the same cadence as the secrets. Founder's act.
- **E9 [v2] Reject pull-request bureaucracy.** One person dispatches; PRs from the same person to themselves add ceremony, not review. E3 tier (b)'s second agent is the review; E1's pushed series is the record.

## 5. Engineering-practice deep dive

### 5.1 The integration gap (R-1)

The numbers in Appendix B were measured today. What they mean:

- **The committed codebase is smaller than the uncommitted one.** Six commits on 2026-08-09 built the harness skeleton, CI and the first fixtures. Everything since — the B-track poller chain, the C-track backfill and promotion, the D-track identity, lifecycle and alerting engines, most of the web core — exists only as untracked files.
- **`ci.yml` has not run on any of it.** The workflow triggers on push to `main` and on pull requests. The last run is on the last commit. The determinism double-run, the migrations up/down/up, the boundaries check, the audit — all designed for exactly this code, none executed on it.
- **The tree is single-copy.** Review 18 §5.5 worried about the archive being single-copy on the VM. The codebase is single-copy on a laptop, and unlike the archive it has no `--check` manifest.

Rule 4 is not the cause; it is the mechanism by which the cause expresses itself. The cause is that no rule says when integration happens, and in its absence the dispatcher's default — one more session, then commit — has run for eighteen sessions. E2's rule 8 gives the default a stopping point. E1 pays the accumulated debt in the order that makes each step checkable by the previous one.

Expect E1 to hurt. On 2026-08-09, CI found that hand-written assertions were wrong, not the code. There are now 86 untracked test files that have run only under `vitest` on one machine with one Node and one Postgres. Some of them will fail in CI for reasons that are the test's fault. That is the argument for doing it now rather than after the D-track lands another ten thousand lines on top.

### 5.2 Reviewing what an agent wrote (R-2)

The project has one reviewer and the reviewer is also the dispatcher, the fixture author's client and the person who wants the work done. The input to review is the agent's summary — accurate, in this project's record, but written by the party being reviewed — plus a green harness the same agent extended. This is not a criticism of the founder; it is the shape of a one-person team with agents, and the shape needs a rule.

E3's three tiers put the human's attention where the harness cannot reach and put a second agent where the harness can. The adversarial reviewer in tier (b) is the cheap version of a second engineer: it gets the diff and the fixture format, not the summary, and it must produce a failing fixture or say it could not. WORKLOG 2026-09-02 is the model — the harness caught two wrong traces because it was asked a question the trace author had not asked. Tier (b) asks that question on purpose.

What tier (a) buys is proportion. Most of what changes in this codebase is a versioned object with a digest; reading the object and the rationale line is a two-minute review with a machine-checked residue, and it should not be done at the same depth as an adapter that talks to a live API.

### 5.3 What a fixture may assert (R-3)

Three findings, all from the project's own record:

- **Hand-derived traces are wrong at a measurable rate.** Two of the traces written on 2026-09-02 were wrong; CI on 2026-08-09 found wrong assertions; the S14 timing was wrong in the document and right in the test. In each case the machine was right. E4 rule 1 inverts the derivation: the engine produces, the human reviews the *why* of each transition. Review 06 §5.2 already makes `expected.json` the assertion record; E4 changes who computes it, not what it is.
- **Outcome-only expectations are weak for identity and lifecycle.** Review 06 §5.2 rules that `expected.json` asserts "outcomes, not internals", and `server/fixtures/README.md` follows it. For a smoke fixture that is right, and the rule was written for exactly the reason it gives — internals change, outcomes are the contract. For an identity fixture, a wrong merge at cycle 3 that is undone by a split at cycle 7 produces the right final report and a wrong engine. For identity fixtures the transitions *are* the outcome. E4 rule 2 adds an optional `trace` block where that is so; because it narrows a review 06 rule it is a disagreement (§6 Q7), not a change.
- **The corpus is constructed geometry.** WORKLOG 2026-08-31 says so plainly. This is unavoidable before WP1 records a season and must be visible in the manifest (E4 rule 3), so that when the first recorded-geometry fixture lands the register can say what fraction of the suite it represents. [Review 23](23-data-engineering-stewardship.md) §5.5 lists what the season must record for those fixtures to exist.

The earth-model split is the smallest example of the largest pattern: two correct constants in two files, a 0.2 % disagreement noted and dismissed as harmless at current margins. It is harmless until someone tightens `MIN_BBOX_BUFFER_KM`, and the note will not be read then. One constant, one test.

### 5.4 An honest progress signal (R-4, R-7)

TASKS §0 says done means checked, and the done-when clauses are written well — C1 is done when live rows land continuously, not when the poller compiles. The consequence is that a task whose code is complete and whose done-when needs a host shows as unticked, indistinguishable from a task nobody has started. The tally line reads 32 to 66. The truth, from the status paragraphs, is that a substantial share of the 66 are "built, blocked on B9". Anyone who reads the tally — the founder deciding what to do in October, the successor in review 18 — reads the wrong number.

E5 adds one marker and one block. The marker (`[~]`, "landed, blocked on ⟨x⟩") keeps rule 5 intact: done still means checked. The block lists the founder's pending decisions in one place, because today they are scattered across WORKLOG entries by date (`COVERED_AREA` on 2026-08-26, the sanity band, the cloud proxy) and a decision that is not listed is a decision that is not made.

### 5.5 Drift between a document and a passing test (R-5)

The project's config-as-data discipline makes parameter drift impossible: a changed value changes a digest, a test pins the digest, CI fails. The S14 incident is the class that discipline does not cover — a number quoted in prose. GATES said 02:30; the test said 03:30; the test was right; the document was found by re-reading. A third copy sat in review 14 §2 and its scenario table for four more days and was found the same way, on 2026-09-07, once S14 was authored and someone went looking for every place the number was written down. Both documents now say 03:30. There is no reason to expect the next one to be found.

E6 is mechanical: a test reads the markdown, finds the quoted value by a stable anchor, and compares. It is not elegant and it does not need to be; it needs to fail when OPERATIONS says 56 days and the code says something else. The list of pinned numbers is the real work, and the first pass should be the numbers this corpus has already had to correct.

### 5.6 The dispatch model (R-6, R-8)

It works. WORKLOG shows the pattern converging: four agents with strict file ownership on 2026-08-09 (one died; the survivors' work was intact because of the ownership rule); seams written first on 2026-09-01 so that three agents "could not negotiate them"; the harness as the arbiter throughout. What is missing is that the pattern is in the journal, not the rules. A session run without it — by the founder on a tired evening, or by a successor — is a session that rediscovers why the rule exists.

E7 is five lines. E8 is the observation that the journal those five lines are extracted from is the only narrative of the last 24 days and is, by policy, untracked; review 18 §5.5's offline bundle is the natural home and needs no policy change.

## 6. Open questions for the team

1. **Does the founder ask for E1 this week?** Rule 4 makes this a founder act; this review cannot do it. If the answer is "after the D-track", the review's position is that the D-track's next ten thousand lines make E1 strictly harder and the CI failures it will surface strictly older.
2. **Rule 8 (E2) and the review standard (E3): TASKS §0 or `docs/ai/`?** TASKS §0 is committed and read by every session; `docs/ai/` is local-only. Rules that change agent behaviour belong where the agent reads them. Founder decides; review 20 §7 Q4 holds that nothing here may override rule 4, and nothing does.
3. **Should doc-pinned numbers (E6) become CI-17?** Gate-shaped, fifty lines, and it would have caught S14. Founder decides; the QA seat (06) is the natural reviewer.
4. **`[~]` marker (E5): acceptable?** It changes the meaning of the tally line that review 18 §5.5 and the checkpoints read. The alternative is a third column. Either is fine; the status quo is not.
5. **Disagreement escalated: review 06 §5.7's shadow-rollout regime assumes a deployed baseline to shadow against.** Until E1 and review 21 §5.7 land there is no baseline, and the regime's "≥ 7 consecutive season-days in shadow" cannot start this season. This review holds that the first season's D-track changes are *pre-baseline* and outside the regime, and that GATES should say so. The 06 author and the founder decide; not applied.
6. **Who reviews the reviewer?** E3 tier (b) gives the engine a second agent. Nothing gives the fixture format, the register or the harness itself a second reader. Proposal: the harness is frozen between checkpoints and changes to it are the one place a human reads every line. Founder decides.
7. **Disagreement escalated: review 06 §5.2's "outcomes, not internals" versus E4 rule 2.** This review holds that for identity and lifecycle fixtures the per-cycle transitions are the outcome, and that an *optional* `trace` block does not reopen internals. The 06 author decides; until then `expected.json` stays as 06 §5.2 wrote it.

## Appendix A — Proposed rows for the shared documents

**RISKS §2**

`| **Unintegrated single-copy codebase** | ~35,000 lines of agent-written code on one laptop, uncommitted since 2026-08-09, never run by CI; a disk or checkout accident loses 24 days, and the latent-bug class CI found in August has had no CI since | Trigger: any session ending with more than one task of unintegrated work. Monitor: `git status --porcelain \| wc -l` at session end (22 Appendix B) | 22 E1 this week (founder asks); adopt rule 8 (22 E2); protect `main` (21 E5) |`

**GATES §1 — proposed only (§6 Q3)**

`| CI-17 | **Doc-pinned numbers**: every number quoted in GATES/OPERATIONS/DATA-SOURCES that is also a code constant is asserted by `doc-pins.test.ts`; the test reads the markdown. | 22 §5.5 |`

**00-summary synthesis (3–4 sentences)**

Review 22 measures what the corpus assumed: the committed codebase is six commits from 2026-08-09, and everything since — 208 untracked source files, ~35,000 lines, 86 of 130 test files — is a single uncommitted copy that `ci.yml` has never run. It finds the engineering discipline inside the tree strong (a harness that caught two wrong hand-derived traces, digests on every tunable, seams-first dispatch) and the delivery discipline around it absent: no integration cadence, no review standard for agent output, a progress tally that cannot say "built, blocked on a host", and doc-to-code drift found by luck. It proposes a rule 8 ("integrated means committed and green") that leaves rule 4 untouched, an integration series in dependency order this week as a founder act, a three-tier review standard with an adversarial second agent for engine code, engine-derived traces reviewed by humans, a `[~]` progress marker with a pending-decisions block, and doc-pinned number tests.

## Appendix B — Measurements (2026-09-02)

| Measure | Value | Method |
|---|---|---|
| Commits | 6, all dated 2026-08-09 | `git log --format=%ad` |
| Tracked files modified, uncommitted | 51 (+4,004 / −173) | `git diff --stat` |
| Untracked TypeScript source files / lines | 208 / 34,968 (305 files incl. 194 generated `.d.ts` under `web/dist-types/`) | `git ls-files --others --exclude-standard`, filtered on `*.ts`, `dist-types` excluded, `wc -l` |
| Test files untracked / tracked | 86 / 44 | `git ls-files --others --exclude-standard` vs `git ls-files`, filtered on `*.test.ts` |
| Test files / tests (last local run) | 125 / 1,897 | WORKLOG 2026-09-02 |
| Last CI run | 2026-08-09, success, on `d79fff2` | GitHub API |
| Branch protection on `main` | none (404) | GitHub API |
| Sessions since last commit | 18 (2026-08-12 → 2026-09-02) | WORKLOG headings |
| TASKS tally | 32 `[x]` / 66 `[ ]` | `grep -c` on TASKS |

Four `web/dist-types/` files are tracked and 194 are not; whether generated types belong in the repository at all is a question for E1's `web` series. Nothing here was run in CI; every number is from the laptop.
