# Review 29 — QA & test engineering (as built)

*Reviewer role: senior QA and test-engineering lead (round 5, the system as built). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: `vitest.config.ts`, root `package.json` scripts, `.github/workflows/ci.yml`, the CI run history on `main` (`gh run list` / `gh run view --log-failed`, read-only, runs 36255108495 → 40939772318), `docs/GATES.md` §1–§4, `docs/TASKS.md` §0 and the pending-decisions block, `docs/reviews/21-platform-release-engineering.md`, `docs/reviews/22-engineering-practice.md`, `WORKLOG.md` (4,678 lines, flake and gate entries), `server/src/core/replay/register.ts`, `server/fixtures/*/manifest.json` and `expected.json`, `server/src/core/qa/*`, `web/e2e/*` and `web/e2e/harness/origin.ts`, `loadtest/src/*`, `web/budgets/*`, and a spot-check of 14 test files across the alert gateway, never-send, identity, erasure, webhooks and clustering (listed in Appendix B).*

---

## 1. Summary verdict

**CONDITIONAL GO for May 2027.** The test machinery is far larger and better designed than most products at this stage: 670 tracked test files, a golden replay register with a determinism double-run, property tests on the hardest state machines, CI-gated byte budgets, axe floors and a never-send lint that gates copy. What is missing is not tests. The meaning of "green" is broken, and so is the bridge from the test suite to the launch gates.

1. **"Green" has meant "local `pnpm verify` green" for 34 days while the remote gate was red.** The last green CI run on `main` was 2026-09-26 (run 36255108495, `1e0bba7`). Every one of the nine runs since has failed. `pnpm verify` runs unit tests only (`package.json` `test` = `vitest run --project unit`); integration, e2e, budgets and timing never run before a merge. CI runs only on push, pushes are rare, and `main` is unprotected.
2. **The current CI failure is trivial, and a second failure is masked behind it.** One integration test still pins `source_registry_v1` after the V3-P4 bump to v2. After it, the codegen drift gate (`types.generated.ts` ordering) has been red since 2026-10-27 and will fail the very next run. The tree needs two fixes to go green, not one.
3. **About a third of the Postgres adapter layer is tested only by SQL-string change detectors.** 29 test files hold 158 assertions of the form `SOME_SQL toContain(...)`, and 17 of 47 `pg-*` adapters have no integration test. That includes the magic-link consume race in `pg-auth`, which is proven only on a stub.
4. **The behavioural core is tested well.** The notification gateway, never-send, erasure purge planning, alert state, alias registry and stream replay have real behavioural or fast-check coverage. Clustering merge rules and alert-decision code are covered by example only.
5. **Most launch gates cannot be measured before live shadow, and live shadow does not exist.** The §2 fit gates, L-13 and L-14 can be measured offline today. L-1, L-7, L-8, L-11 and FER need weeks of live data. CP1 (31 Oct 2026) is tomorrow and nothing is deployed.
6. **The fixtures are partly synthetic, and nothing records which ones.** MeteoAlarm, CEMS, FireSat and lightning are synthetic; geometry is often constructed. The expected outputs are written by the same agents that write the code, so a shared misunderstanding passes both.
7. **The e2e suite runs against a hand-rolled fake origin, not the server.** The core product journey (zone, then alert, then delivery) has no e2e test at all, because the web has no zone UI before v1.

**Conditions for GO:** (a) CI is green on the pushed `main` SHA and stays green: branch protection is on, and "done" means CI green on that SHA (E-1, E-2); (b) every `pg-*` adapter that holds a security or correctness invariant has a real-Postgres test (E-4); (c) a gate-measurability matrix exists and the live shadow starts no later than 2027-02-01, which leaves the ≥ 2 weeks L-1 needs plus a correction cycle (E-8); (d) every fixture declares its provenance (E-7).

## 2. Strengths (sound as built)

- **The golden replay register is the strongest asset.** `server/src/core/replay/register.ts` names every fixture, and a scenario that cannot run is `blockedBy` with a reason rather than silently skipped. CI runs it twice under `TZ=Pacific/Kiritimati LC_ALL=tr_TR.UTF-8` (`ci.yml:79`), which catches time-zone and locale nondeterminism that most suites never see.
- **The integration project tests real PostGIS.** It uses testcontainers with `postgis/postgis:16-3.4`, `fileParallelism: false`, a `FIRE_WATCH_PG_IMAGE` override and `FIRE_WATCH_REQUIRE_DOCKER=1`. CI fails on any skipped test (`ci.yml:316`), so a missing Docker cannot read as green. Migrations run up, down and up again.
- **Vitest resolves `@fire-watch/contracts` to `src`, not `dist`** (`vitest.config.ts`, the "not against a stale `dist`" comment). That is why the stale `packages/contracts/dist/sources.js` (still v1) did not cause a second, confusing failure.
- **Property testing is used where it pays most.** fast-check appears in 38 files: alert state, alias registry, purge plan, stream replay, zone geometry, the S15 snapshot route, and the web cursor client, supervisor and reconciler.
- **The notification gateway tests are behavioural, not structural.** `notification-gateway.test.ts` (847 lines) drives fakes through erased recipient → `cancelled_erasure`, TTL expiry, and never-send closing the row (D7). These are the tests a regulator would ask about.
- **Never-send is a gate on shipped copy, not a style guide.** `packages/contracts/src/never-send.test.ts` (641 lines) checks the BG and EN rules both ways ("няма опасност" is rejected, "безопасна дистанция" is allowed), and CI-10 runs the lint over the web catalogs.
- **Byte budgets, timing and a11y are CI jobs, not checklists.** CI-12 bytes, CI-12 timing on Fast 4G and Fast 3G, CI-7 polling-only e2e and CI-18 axe plus layout over four viewports all exist as jobs (`ci.yml:100–272`).
- **Snapshots and mocks are rare.** Only 2 files use snapshots and 1 uses `vi.mock(`. The suite relies on fakes behind ports, as the ports-and-adapters design intends.
- **The QA metric machinery exists before the data.** `server/src/core/qa/` has DAR, FER, FLR, shadow PCR, shadow PLB, lifecycle metrics and the weekly report, so L-7 is a data problem, not a code problem.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | "Green" is defined locally. `verify` excludes integration, e2e, budgets and timing; CI runs only on push; `main` is unprotected (gh: "Branch not protected", HTTP 404). Result: CI red on every run from 2026-10-02 to now (9 runs, 34 days) while WORKLOG entries say "Gate: `pnpm verify` … green". Review 21 R-6 / E5 and review 22 E2 asked for the fix; neither landed. | `package.json` `verify`/`test`; `vitest.config.ts` unit `exclude: ['**/*.integration.test.ts']`; TASKS.md:194 (rule 8 still "pending"); runs 37060550718 … 40939772318 |
| R-2 | **High** | A fail-fast step order masks failures. Codegen drift has been red since 2026-10-27 (runs 40551528674, 40567935292, 40591069990, 40767718700) and sits behind the integration step, so the latest run shows only the test failure. Fixing that test will not turn CI green. | `ci.yml:316` then `ci.yml:337`; `server/src/db/types.generated.ts:30` (`Accounts`) vs `:42` (`AccountPreferences`), last touched by 5a9dd9e |
| R-3 | **High** | SQL-string change-detector tests stand in for behaviour. 29 files and 158 `_SQL…toContain/toMatch` assertions check the text of queries, not their effect. 17 of 47 `pg-*` adapters have no real-Postgres test, including `pg-auth` (sign-in, sessions, magic-link consume), `pg-alert-decision-log`, `pg-staff-store`, `pg-zone-creation`, `pg-shadow-diff-reader` and `pg-parity-reader`. | `pg-auth.test.ts:182` (the consume race on a stub); `pg-webhook-store.test.ts` (`not.toContain('secret_ciphertext')`); `pg-erasure-purge.test.ts` (`/LIMIT \$2::integer/`); `pg-alert-outbox-store.test.ts` (`'$21::timestamptz[]'`) |
| R-4 | **High** | Most launch gates can only be measured on live data. L-1, L-7, L-8, L-11, FER and the L-3 baseline need a live shadow. Nothing is deployed, and CP1 (shadow pipeline, 31 Oct 2026) falls tomorrow. Without a dated measurability plan, the gates will be judged in April 2027 on one or two weeks of data. | GATES.md §3 L-1/L-7/L-8/L-11, §4 CP1; `server/src/core/qa/*` (code exists, no input) |
| R-5 | **Medium-High** | Synthetic and constructed fixtures are undeclared. No manifest records whether its data is recorded, constructed or synthetic (0 manifests have such a field; review 22 E4 rule 3 asked for it). MeteoAlarm, CEMS, FireSat ("0-provisional" format) and lightning are synthetic. The same agent wrote the code and its expected output (0 `expected.json` files have the `trace` block from 22 E4 rule 2). S3 is `blockedBy: LAND_COVER`, so the CI-1 pre-merge set is incomplete. | `server/fixtures/*/manifest.json`; `register.ts:100–105`; GATES.md §1.1 |
| R-6 | **Medium** | The e2e tests run against a fake. `web/e2e/harness/origin.ts` is a node:http origin that "copies the server's" headers, and nothing checks that the copy still matches. There is no zone, alert or webhook UI (`web/src/ui/logic/routes.ts:45`, "no `/zones` until v1"), so the journey that defines the product (draw zone → fire → alert delivered) has no e2e. Sign-in has 9 e2e tests against the fake only. | `web/e2e/harness/origin.ts`; `web/e2e/*.e2e.ts` (about 57 tests) |
| R-7 | **Medium** | Flakes, runtime and resource limits erode trust in red. WORKLOG records 10 s unit timeouts under load (EFFIS overlay, s3-sigv4, boundary.test "pass at 60 s"), event-loop-lag and effis-refresh, the incident-log race (about 1 in 4, fixed 10-22), a pass-compute fast-check flake (WORKLOG:4407), the loadtest edge-hit-ratio smoke, t2-failover under load, verify OOM (137) and colima `fwtest` at 100 % disk. CI shows e2e "timed out after 20000 ms waiting for the map style" (run 40567935292) and timing failing with a `localStorage … Access is denied` `SecurityError` (40591069990). There is no flake register and no quarantine rule. | WORKLOG.md (flake entries, line 4407, line 4662); `vitest.config.ts` unit `testTimeout: 10_000` |
| R-8 | **Medium** | There are no property tests on clustering or alert decisions. `merge-rule.test.ts` (104 lines) checks total order and order-independence by example only. Merge order-independence and alert monotonicity are exactly the invariants fast-check finds counterexamples for. | `server/src/core/clustering/merge-rule.test.ts`; `server/src/core/alerts/*` (fast-check only in `explain.test`) |
| R-9 | **Medium** | Integration is run as a subset locally. WORKLOG:4662 (V3-P4) records "integration … 53/53 incl. migration 060". The full project has 396 tests, and the one that broke was not in the subset. | WORKLOG.md:4662; run 40939772318 |
| R-10 | **Low-Medium** | Review 22's practice recommendations largely did not land. E2 (rule 8), E3 (review standard), E4 rules 2–3, E5 `[~]` marker (0 in TASKS) and E6 doc-pins / CI-17 (GATES §1 has no CI-16 or CI-17) are all missing. Only E1 (integrate) and the pending-decisions block landed. | TASKS.md §0 and :194; GATES.md §1 |

## 4. Detailed recommendations

**E-1 [MVP] Make CI green on `main` again (R-1, R-2).** Owner: engineering. Effort: 0.5 h.
Change `pg-detection-store.integration.test.ts:183` to assert against the imported `SOURCE_REGISTRY_VERSION`, not the literal, so the next bump cannot break it. Regenerate `types.generated.ts` in the CI image: run `db:migrate` and `db:codegen` against `postgis/postgis:16-3.4`, ideally in the colima profile with `LC_ALL=C`. Then re-run CI and triage the 10-27 e2e map-style and timing `localStorage` failures if they come back. Do not bundle in other work.

**E-2 [MVP] Redefine "green" and enforce it (R-1, R-9).** Owner: founder (the rule), engineering (the setup). Effort: 2 h.
Adopt TASKS §0 rule 8 in this form: *an item is done when its commit is on `origin/main` and CI is green on that SHA*. Then:
- Push per item, so CI runs on each change rather than on a batch every week.
- Turn on branch protection with the five CI jobs as required checks.
- Add `pnpm verify:full`, which runs verify, then integration (full, not a subset), then e2e. Run it locally before a push whenever server or db code changed.
- Every WORKLOG gate line names the CI run id, or says "CI not run".

**E-3 [MVP] Stop one CI failure from hiding another (R-2).** Owner: engineering. Effort: 0.5 h.
Make the codegen drift gate independent of the integration result (`if: always()` after migrations succeed), or move it to its own job. A red run must list every broken gate at once.

**E-4 [MVP] Put the invariants on real Postgres (R-3).** Owner: engineering. Effort: 10 h.
Write integration tests, in this order:
1. `pg-auth`: two concurrent consumes of one magic link, where exactly one wins and the other sees `used`; session revoke; sign-in flows.
2. `pg-webhook-store`: the secret is never returned by any read path, proven by a read rather than a regex.
3. `pg-erasure-purge`: the batch limit is honoured, and the plan does not delete.
4. `pg-alert-decision-log`, `pg-staff-store` and `pg-zone-creation`.

Once an adapter has an integration test, delete its SQL-string assertions. Keep text assertions only where the text is the contract, such as a column that must never be selected. After that, CI should fail if a new `pg-*.ts` lands without a sibling `.integration.test.ts`, unless it is listed in an allowlist.

**E-5 [v1] Contract-test the e2e fake origin (R-6).** Owner: engineering. Effort: 4 h.
Record the real API's responses for each route the web uses (status, headers and a body schema from `packages/contracts`) in the API integration test. Assert that `web/e2e/harness/origin.ts` serves the same shape. When `/zones` arrives in v1, add one full-stack e2e test: real server, real PostGIS, fixture replay, zone, alert, and an outbox row. Until then, the API integration test is the journey test and should say so.

**E-6 [v1] Property tests for clustering and alert decisions (R-8).** Owner: engineering. Effort: 4 h.
Use fast-check on three properties:
- the merge result is independent of input order;
- merging is idempotent;
- an alert decision never downgrades severity while no newer evidence arrives.

Seed the failures into the regression examples.

**E-7 [MVP] Fixture provenance and independent expectations (R-5).** Owner: engineering, and the founder for review. Effort: 3 h.
Add `provenance: recorded | constructed | synthetic` to every manifest, and a CI check that rejects a manifest without it. GATES §1.1 should report the count per class. For every launch-gating scenario, have a different agent or the founder write `expected.json` before the code runs, as the 22 E4 `trace` block intended. Unblock S3 or mark the CI-1 pre-merge set as incomplete in the gate text.

**E-8 [MVP] A gate-measurability matrix and a dated shadow plan (R-4).** Owner: founder and engineering. Effort: 3 h.
Add a section to GATES that classifies every L-n gate into one of three classes (see §5.5) and gives each its data source, the earliest date it can be measured and an owner. Re-date CP1 honestly. Set a hard date for the live shadow, no later than 2027-02-01. Run `pnpm fit`, L-13 ECE and L-14 now on DS-1/DS-3, so the 20 pending FIT_DECISIONS are decided on numbers.

**E-9 [v1] A flake register and a quarantine rule (R-7).** Owner: engineering. Effort: 2 h.
Keep a table in `docs/OPERATIONS.md` or the GATES appendix with columns test, symptom, first seen, frequency, owner, status. A flaky test is quarantined for at most 14 days with an owner, never retried silently. Make unit timeouts load-aware (one `LOAD_MARGIN` helper, as e2e already uses) instead of raising them one test at a time. Pin `NODE_OPTIONS=--max-old-space-size` for verify, and cap colima disk with a prune step.

## 5. QA & test deep dive

### 5.1 How a red remote gate went unnoticed for 34 days

There were four independent causes. Any one of them would have surfaced the problem.

| Date | Run | SHA | Failing job |
|---|---|---|---|
| 2026-09-26 | 36255108495 | 1e0bba7 | none (last green) |
| 2026-10-02 | 37060550718 | 7a15bf4 | supply chain (fastify audit) + e2e t2-failover |
| 2026-10-12 / 10-19 / 10-22 | 38319673396 / 39320546516 / 39829918069 | — | supply chain |
| 2026-10-27 | 40551528674 | 3b29b95 | codegen drift |
| 2026-10-27 | 40567935292 | ac3670e | codegen + e2e map style 20 s + timing |
| 2026-10-27 | 40591069990 | c1853fe | codegen + timing (`localStorage` SecurityError) |
| 2026-10-28 | 40767718700 | cf40cc8 | integration 396/396 passed, then codegen drift |
| 2026-10-29 | 40939772318 | 3497c93 | integration 1/396 (`pg-detection-store`) |

1. **Scope.** The local gate was a strict subset of the remote one, and the WORKLOG wording ("gate green") did not say which.
2. **Cadence.** There were 9 CI runs in 34 days, because `main` usually sat several commits ahead of origin. CI has not run on `ccd541a` at all.
3. **No enforcement.** Without branch protection, a red run blocks nothing.
4. **No feedback path.** Nobody read the run results. The 2026-10-24 analysis found the red only by checking on purpose.

Green must therefore mean one thing: **CI green on the SHA that is on `origin/main`**. Anything else is "locally verified" and must be called that.

### 5.2 Diagnosis of the failing integration test

Commit a4bfe50 (V3-P4, 2026-10-29 18:05) bumped `SOURCE_REGISTRY_VERSION` to `'source_registry_v2'` (`packages/contracts/src/sources.ts:77`) and re-pinned the replay manifests and `expected.json` files. It missed `server/src/adapters/db/pg-detection-store.integration.test.ts:183`, which asserts that the stored row has `source_registry_version: 'source_registry_v1'` while the code writes the constant. The change was gated locally on 53 of 396 integration tests (WORKLOG:4662).

About 17 other test files contain the v1 literal as input data (for example lines 334 and 366 of the same file). Those are legitimate and must stay; only the assertion is wrong. **The fix is one line, about 0.1 h. Together with the masked codegen drift (about 0.25 h), the tree is about 0.5 h from green, provided the 10-27 e2e and timing failures do not recur.** I did not apply the fix, by brief.

### 5.3 What the suite is worth

I spot-checked 14 files (Appendix B) and sorted them into three classes:

- **Behavioural with fakes, high value.** The notification gateway, never-send, `pinned-https-post.test.ts` (pinned address, no redirect following, timeout), and the property tests. These catch real regressions.
- **Change detectors, low value and a high maintenance cost.** The SQL-string tests in `pg-webhook-store`, `pg-erasure-purge`, `pg-alert-outbox-store` and `pg-auth`. They pass when the SQL is wrong but spelled the expected way, and fail on harmless refactors. `pg-auth.test.ts:182` ("turns a lost consume race into `used`") is the clearest case: a concurrency invariant that a stub cannot prove at all.
- **Real-database tests, highest value.** There are 40 integration files (33 adapters, plus api with 18 tests, auth-wiring with 3, pipeline with 10, drills, schema, backup-restore). They are good, but they leave the identity layer and the decision log uncovered.

Tautologies are rare and snapshot abuse is absent. The weak spot is how coverage is spread across risk: the highest-risk stores (identity, erasure, webhook secrets) carry the weakest kind of test.

### 5.4 Flakiness and runtime

The unit project (613 files, 8,506 tests at the round-5 count) runs under a flat 10 s timeout on a machine that also runs parallel agent waves. Most recorded flakes are this one cause: tests pass at 60 s and fail at 10 s under load. Real races (incident-log, fixed with `edit_seq`) were found and fixed, which is good practice. The structural issues are that verify can OOM, the colima disk fills up, and nothing records a flake once its fix is committed. E-9 addresses all three. CI runtime is not a problem. Local runtime is, and it is the reason the local integration run was a subset.

### 5.5 Can the launch gates be measured before May 2027?

| Class | Gates | Status |
|---|---|---|
| Offline, measurable now | §2 fit gates (pairwise recall ≥ 0.95, precision ≥ 0.98) on DS-1/DS-3; L-13 ECE ≤ 0.07 on the 2025 touch-once season; L-14 constellation replay; all CI-n | Machinery exists (`pnpm fit`, `pnpm constellation-replay`); 20 FIT_DECISIONS await the founder |
| Need the live shadow | L-1 (≥ 2 weeks), L-7 PCR/CER/ZAP/DAR/PLB, FER, L-8 dispatch SLO, L-3 1× baseline, L-11 edge hit ratio on the real CDN | Metric code exists in `server/src/core/qa/`; no host, no data |
| Need a protocol or a person | CP1 protocol, L-16 manual AT pass, L-5 physical device, L-15 correction rehearsal, L-10 legal artifacts | Drafts exist for L-15 and L-16; no dated execution |

The middle row decides the launch. L-7's DAR has to fall from ≤ 5 % in shadow to ≤ 1 % in steady state, and that needs at least two measurement windows and a fix in between. Working backwards from May, the shadow must be live by about 1 February 2027.

### 5.6 Fixture authorship and synthetic-data risk

The register is honest about what is blocked, but not about what is real. A replay that passes on constructed geometry proves the code agrees with its author. The risk is greatest for the v3 sources (FireSat "0-provisional", CEMS, MeteoAlarm), whose formats were inferred rather than recorded. Two cheap controls close most of the gap: a `provenance` field (E-7), and expectations written by someone other than the code's author for launch-gating scenarios. Recorded FIRMS data in the DS-1 archive should replace constructed geometry in S1/S2-class fixtures where possible.

### 5.7 e2e, a11y and budget coverage of the journeys that matter

These are covered:
- the map cold load, polling-only mode, T2 failover, the layers (wind, lightning, passes, swaths, static sources, CEMS badge), preferences sync and sign-in;
- axe floors and CI-18 layout over four viewports;
- byte and timing budgets.

These are not:
- **Alerting.** Zone → detection → decision → delivery has no e2e, by design until v1, and that should be written down as an accepted gap.
- **The real server.** All web e2e runs against `origin.ts`.
- **The M-1 to M-3 manual legs of L-16.** They are undated.

The map-ready timing job has failed twice for environment reasons (the map style timeout, `localStorage` access). It needs a quarantine rule so that a timing flake does not normalise ignoring red.

## 6. Open questions for the founder

1. **Do you adopt rule 8, "done = on `origin/main` and CI green on that SHA"?** Recommended: yes, today, together with branch protection. It costs one push per item and removes R-1 entirely.
2. **May agents push to `origin/main` per item without asking each time?** Your global rule is "push only when asked". Recommended: a standing yes for `fire-watch` `main` once branch protection is on. Otherwise CI cannot be the gate.
3. **When does the live shadow start, and on what host?** Recommended: commit to 2027-02-01 at the latest, and re-date CP1 now rather than miss it silently.
4. **Who writes the expected outputs for launch-gating fixtures?** Recommended: a different agent from the code author, with you reviewing the S1, S2 and S16 traces.
5. **Is "no alert e2e until v1" an accepted risk for the beta?** Recommended: accept it in writing, but only with E-4 and the API integration journey test in place.
6. **Will you decide the 20 pending FIT_DECISIONS on the offline gates before the shadow starts?** Recommended: yes, so the shadow measures the parameters that will ship.

## Appendix A — Proposed rows for the shared documents

### (a) TASKS rows

- [ ] **R5-QA-1 — Restore green CI on main.** Spec: review 29 E-1. Writes: `server/src/adapters/db/pg-detection-store.integration.test.ts`, `server/src/db/types.generated.ts`. Done when: a CI run on the pushed `main` SHA is green in all five jobs, and the test asserts against `SOURCE_REGISTRY_VERSION`. Est: 0.5 h. Status: open.
- [ ] **R5-QA-2 — Rule 8, branch protection and verify:full.** Spec: review 29 E-2. Writes: `docs/TASKS.md` §0, `package.json`, the GitHub branch protection settings. Done when: rule 8 is in TASKS §0; `gh api repos/:o/:r/branches/main/protection` returns the five required checks; `pnpm verify:full` exists and runs the full integration project. Est: 2 h. Status: blocked-owner.
- [ ] **R5-QA-3 — Independent CI gate steps.** Spec: review 29 E-3. Writes: `.github/workflows/ci.yml`. Done when: a deliberate test failure plus a codegen drift on a scratch branch shows both failures in one run. Est: 0.5 h. Status: open.
- [ ] **R5-QA-4 — Real-Postgres tests for the uncovered adapters.** Spec: review 29 E-4. Writes: `server/src/adapters/db/pg-auth.integration.test.ts`, plus siblings for webhook-store reads, erasure-purge, alert-decision-log, staff-store and zone-creation; a sibling-presence check with an allowlist. Done when: the concurrent magic-link consume test passes on PostGIS with exactly one winner; the allowlist of `pg-*` without an integration test is ≤ 8 and shrinking; superseded SQL-string assertions are removed. Est: 10 h. Status: open.
- [ ] **R5-QA-5 — Fake-origin contract test.** Spec: review 29 E-5. Writes: `server/src/app/api.integration.test.ts`, `web/e2e/harness/origin.contract.test.ts`. Done when: changing a header or body shape in the real API fails the contract test. Est: 4 h. Status: open.
- [ ] **R5-QA-6 — Property tests for clustering and alert decisions.** Spec: review 29 E-6. Writes: `server/src/core/clustering/merge-rule.property.test.ts`, `server/src/core/alerts/decision.property.test.ts`. Done when: order-independence, idempotence and no-downgrade properties run at ≥ 200 cases each in the unit project. Est: 4 h. Status: open.
- [ ] **R5-QA-7 — Fixture provenance field.** Spec: review 29 E-7. Writes: `server/fixtures/*/manifest.json`, the manifest schema, `docs/GATES.md` §1.1. Done when: every manifest declares `provenance`, CI rejects one without it, and §1.1 reports counts per class. Est: 3 h. Status: open.
- [ ] **R5-QA-8 — Gate-measurability matrix and shadow date.** Spec: review 29 E-8. Writes: `docs/GATES.md` (new §3.1), §4 CP1. Done when: every L-n has a class, data source, earliest date and owner; CP1 is re-dated; the shadow start date is recorded. Est: 3 h. Status: blocked-owner.
- [ ] **R5-QA-9 — Flake register and quarantine rule.** Spec: review 29 E-9. Writes: `docs/OPERATIONS.md`, `vitest.config.ts`. Done when: the register lists every flake in WORKLOG since 2026-09-01 with a status, unit timeouts use one load-margin helper, and the quarantine rule is written. Est: 2 h. Status: open.

### (b) RISKS §2 and GATES rows

RISKS §2:

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RK-QA-1 | Remote gate red unnoticed; "green" means local only | High (it happened: 34 days) | High | R5-QA-1, R5-QA-2, R5-QA-3 |
| RK-QA-2 | Identity, erasure and webhook-secret invariants unproven on a real DB | Medium | High | R5-QA-4 |
| RK-QA-3 | Launch gates judged on too little live data | High | High | R5-QA-8; shadow live by 2027-02-01 |
| RK-QA-4 | Replay passes on synthetic or self-authored truth | Medium | Medium-High | R5-QA-7 |

GATES §1:

| ID | Gate | Pass |
|---|---|---|
| CI-19 | Remote-green rule | `main` protected; required checks = all five CI jobs; no item is marked done in TASKS without a green CI run id |
| CI-20 | Adapter integration presence | every `server/src/adapters/db/pg-*.ts` has a sibling `.integration.test.ts` or a dated allowlist entry |
| CI-21 | Fixture provenance | every replay manifest declares `provenance`; GATES §1.1 counts match |

### (c) Synthesis paragraph for 00-summary

The test suite is large and mostly well aimed: a deterministic golden replay, real-PostGIS integration tests, property tests on the hardest state machines, and CI-enforced budgets, a11y and never-send. The process around it failed. "Green" meant a local unit-only verify, so the remote gate stayed red for 34 days, and the current one-line failure hides a second, older codegen drift. About a third of the Postgres adapters, identity included, are tested only by SQL-string change detectors, and most launch gates cannot be measured until a live shadow runs that does not yet exist. With remote-green enforced, real-DB tests on the security-critical stores, fixture provenance and a shadow live by February 2027, QA is a CONDITIONAL GO for May 2027.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| CI red since 2026-09-26; nine failing runs | `/opt/homebrew/bin/gh run list --branch main` and `gh run view <id> --log-failed` (read-only) |
| Latest failure = `pg-detection-store` v1 ≠ v2 | Run 40939772318 log; `pg-detection-store.integration.test.ts:183`; `packages/contracts/src/sources.ts:77`; `git show a4bfe50 --stat` |
| Codegen drift masked | Runs 40551528674 → 40767718700 logs; `ci.yml:316` vs `:337`; `types.generated.ts:30,42`; `git log` on the file |
| verify excludes integration and e2e | `package.json` scripts; `vitest.config.ts` unit `exclude` |
| main unprotected | `gh api repos/.../branches/main/protection` → HTTP 404 "Branch not protected" |
| Local integration was a subset | WORKLOG.md:4662 (53/53) vs CI 396 tests |
| 29 files / 158 SQL-string assertions | `git grep -E "_SQL.*\)\.(not\.)?to(Contain\|Match)\("` counted per file |
| 17 of 47 `pg-*` adapters lack an integration test | listing `server/src/adapters/db/pg-*.ts` vs `*.integration.test.ts`; `git grep createPgAuthLinkStore` etc. in integration files |
| fast-check in 38 files, none in clustering or alert decisions | `git grep -l fast-check` |
| 2 snapshot files, 1 `vi.mock` | `git grep -l toMatchSnapshot`, `git grep -l "vi.mock("` |
| e2e uses a fake origin; no zone UI | read `web/e2e/harness/origin.ts`; `web/src/ui/logic/routes.ts:45` |
| S3 blocked | `register.ts:100–105` |
| Review 22 E2–E6 not landed | TASKS.md:194; `grep -c "\[~\]"` = 0; 0 manifests with `geometry`; 0 `expected.json` with `"trace"`; GATES §1 has no CI-16/17 |
| Files spot-checked (14) | `notification-gateway.test.ts`, `never-send.test.ts`, `pg-auth.test.ts`, `pg-webhook-store.test.ts`, `pg-erasure-purge.test.ts`, `pg-alert-outbox-store.test.ts`, `pinned-https-post.test.ts`, `merge-rule.test.ts`, `pg-detection-store.integration.test.ts`, `auth-wiring.integration.test.ts`, `alert-state.property.test.ts`, `purge-plan.property.test.ts`, `web/e2e/sign-in.e2e.ts`, `web/e2e/harness/origin.ts` — read |
| Flake history | WORKLOG.md grep for "flake", "timeout", "OOM", "ENOSPC" |
| Not run | No suite, build or verify was run (brief constraint); no fix was applied |
