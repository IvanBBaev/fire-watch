# Review 26 — Product & delivery (as built)

*Reviewer role: senior product & delivery lead (product owner and programme manager for a solo-founder, agent-built product). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: `docs/TASKS.md` (release-progress block lines 10–120, §1 "Pending founder decisions", Tracks B, D, H, I, K, V2), `docs/GATES.md` §3–4 (L-1…L-17, CP1–CP3), `docs/IMPLEMENTATION-PLAN.md` (capacity baseline, calendar, scope-cut and never-cut lists, WP10), `docs/V2-FEATURES.md` §5–7, `docs/V3-FEATURES.md` §5–7, `docs/V3-WORKPLAN.md` §2, `docs/EXTERNAL-ACCOUNTS.md`, `docs/data/DATASETS.md` DS-1, `docs/RISKS.md` §1–2, `README.md` Status, `WORKLOG.md` 2026-09-02 → 2026-10-29, reviews 00, 07, 10, 15, 20, 21, 22, 24, 25; `web/src/core/i18n/catalog-governance.ts` (`PENDING_FOUNDER_REVIEW`), `server/src/core/alerts/templates/alert-copy.ts`, `server/src/core/auth/sign-in-mail-copy.ts`, `server/src/core/fit/fit-report.ts`; `git log` (180 commits, HEAD `ccd541a`); GitHub Actions runs, branch protection and environments on `main` via read-only `gh api`.*

---

## 1. Summary verdict

**NO-GO for May 2027 as the programme is currently run. It becomes CONDITIONAL GO if the founder makes five changes before 15 November 2026.** The product is not short of software. It is short of the things software cannot produce: a host, a FIRMS key, an entity, a recorded season and decisions. Since my seat last reviewed (07, 10; then 15/20/22 for the delivery signal), the build has moved from pre-code to 613 test files. Over the same period the launch's critical path has not moved one day. Every remaining milestone between now and CP2 still has the same first step, "provision Day 0", and the plan said that step was due in September.

1. **CP1 falls tomorrow (31 Oct 2026) and will be missed.** There is no `docs/reports/`, no CP1 evaluation report and no DS-1 archive to run it on. Under GATES §4, an absent report "pauses the business: engineering may continue, no marketing, no spend beyond infrastructure". This review asks the founder to record that pause as a fact and re-date the read. It does not ask anyone to pretend CP1 happened.
2. **The 2026 season is gone. That was the plan's one unrecoverable deadline** (IMPLEMENTATION-PLAN never-cut #1: FIRMS capture from early Sep 2026). Its losses are concrete. L-14 can be at best `pass_unproven`, because NOAA-21 rows exist only in live recording (DATASETS DS-1 "Known gaps"). L-3 runs on a planning baseline, not a measured one. D7 and CP1 depend on a backfill that has not started, even though the only blocker is a free, instant MAP_KEY (B8 remainder: 0.7 h, `blocked-external`).
3. **Scope inverted.** After the first push on 2026-09-26, delivery went into map extensions from a competitor review (F9–F18), 13 V2 features and 5 V3 items. None of it is on the release path, and none of it was ticked by the founder. V2 §0 and V3 §7 both say "nothing here is committed scope until the founder ticks it". V3 §5 says wave 0 is "finish what v3 stands on: the v1 PWA, I2 polygons, sign-up UI and launch track". V3-A1 (FireSat, 24 h) is a wave-2 item that was built before wave 0, against a gate (EFA access + terms, V3-Q5) that is not met.
4. **The founder queue is the bottleneck, and the build widens it.** I enumerated at least 380 open founder items: 205 copy keys, 24 server copy drafts, 18 `FIT_DECISIONS`, 19 D1 decisions, 17 TASKS §1 entries, 12 V2/V3 questions and about 85 V2 parameter keys. At least six of them are dated and past due. Every unticked feature adds 8–21 more.
5. **The progress signal is wrong in three ways at once.**
   - The 71.9 % figure was last computed on 2026-10-13. It counts built-but-unproven code as earned and leaves V2 and V3 out.
   - WORKLOG reported "gates green" while GitHub CI on `main` was red on nine consecutive runs since 2026-09-26.
   - `main` has no branch protection.
6. **CP2 (30 Apr 2027) is still reachable, but only from a dated, account-first plan** (§5.6). Its legs are beta live, L-1 sign-off, ≥ 500 alert-armed users, a partnership and a funding application. They need the ЕООД (2–4 weeks), I2 watch zones, the sign-up UI, a PWA, a mail sender, and a live shadow in Mar–Apr. Each of those takes calendar time that agents cannot compress.
7. **The engineering is not the problem.** Reviews 25 and 29 cover its quality. This review's point is narrower: no more engineering moves the launch date until the account, host and decision work is done.

**GO is conditional on, by 15 Nov 2026:**
- (a) a written feature freeze on V2 and V3, with no new items until v1 has run on a host for one week (E-1, shared with review 25 E-2);
- (b) Day 0 done, meaning the MAP_KEY, Hetzner VM, Cloudflare/R2, healthchecks.io and the mail sender exist (E-2);
- (c) CI green on `main` and required by branch protection (shared with R5-ARCH-1);
- (d) CP1 recorded as missed, with a re-dated backfill read (CP1′, 18 Dec 2026) and its protocol committed (E-3);
- (e) a weekly decision-batch ritual started, with the first batch closing the six past-due §1 items (E-4).

---

## 2. Strengths (sound as built)

- **The v1 design is essentially complete in code.** Ingest, identity, lifecycle, read path, map, alert engine, accounts, staff plane, ops CLIs and drills all exist: 613 test files and 8,506 tests on the last local verify (WORKLOG 2026-10-29). No engineering work stands between the founder and the first deploy except fixing one red integration test and the deploy-job stub (L-12).
- **Founder decisions are fenced in code, not hidden.** `PENDING_FOUNDER_REVIEW` is an exact, test-asserted register (`catalog-governance.ts:925`). `FIT_DECISIONS` is repeated verbatim in every fit report. D1 ships 19 open choices unarmed or `null` (TASKS:849). V2 items list a "Founder:" set per row. The backlog is large, but it is enumerable, which is the precondition for triage.
- **Fallbacks for the missed season were designed before they were needed.** GATES §4 already defines the CP1 minimum-n fallback (a 2024–25 backfill replay). L-3 has a planning baseline. L-14 defines `pass_unproven`. The backfill runner, manifest and `--check` are built (B8). Recovery is mostly a matter of running things.
- **One item per commit, merged quickly**, as review 22 E1 asked. Worktrees are cleaned up and nothing is left on side branches.
- **The re-planning machinery exists.** The release-progress skill, the V3 claim table and TASKS §1 are all in place. They have been pointed at the wrong things; they are not missing.

---

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | Nothing is deployed and no Day 0 account exists, 8 weeks after the plan's hard capture date. Every CP2/K1 leg starts with "host exists". | EXTERNAL-ACCOUNTS rows 4, 5, 22; DATASETS DS-1 "Fetched: Not yet"; `gh api …/environments` → `total_count 0`; README Status still "WP0–WP1" |
| R-2 | **Critical** | CP1 (31 Oct 2026) has no report and no data. Per GATES §4 the business is paused from 1 Nov, and no document records that. | GATES §4 CP1; `docs/reports/` absent; TASKS D11 `blocked-external` (TASKS:1344) |
| R-3 | **High** | Scope runs ahead of v1. 13 V2 items are built and unticked, and 5/39 V3 items are done against their own "only after the founder ticks" and "wave 0 first" rules. Scope-cut #1 (Esri imagery) was built anyway. | V2-FEATURES §0/§7; V3-FEATURES §5 wave 0, §7; V3-WORKPLAN §2 rows P1–P4, A1; IMPLEMENTATION-PLAN scope-cut list; WORKLOG 2026-09-28 (F9–F18 from the ISKRA review) |
| R-4 | **High** | The founder queue (≥ 380 items, ≥ 6 past due) grows faster than it is drained, and no batch format or cadence exists. | TASKS §1 (17 bullets; "this week" items from 2026-09-02; Eurostars due 1 Sep "outcome not recorded"); `catalog-governance.ts:925` (205); `alert-copy.ts` (21 DRAFTED), `sign-in-mail-copy.ts` (3); `fit-report.ts:30` (18); TASKS:849 (19) |
| R-5 | **High** | The progress signal over-reports. 71.9 % is 17 days and about 100 commits stale, counts `*-built` rows as done, and leaves out V2/V3. "Gates green" meant local only. | TASKS release block lines 10–120 ("Updated 2026-10-13 at fb97640", one history entry); CI runs 37060550718 … 40939772318, 9 red in a row; branch protection 404 |
| R-6 | **High** | K1 (≥ 500 alert-armed users by 30 Apr 2027) depends on I2 zones, which need the ЕООД (L-10), plus sign-up UI, PWA, mail sender and H9. None exists, and recruitment cannot start until zones can be stored. | TASKS K1 (2630), I2 (2476), H9 (2452); GATES L-10; EXTERNAL-ACCOUNTS row 22 (2–4 weeks) |
| R-7 | **Medium** | The CP1 backfill read on 2024–25 collides with DS-1's touch-once test season (2025). Running CP1 on 2025 spends the D7 test set. | DATASETS DS-1 "Season split"; `fit-report.ts` `FIT_DECISIONS` (test-season ledger); GATES §4 CP1 fallback |
| R-8 | **Medium** | WP10 GTM (Eurostars, Galileo, partner outreach, duty-officer interviews, all Q4 2026) shows no recorded progress. CP2's partnership and funding legs need it. | IMPLEMENTATION-PLAN WP10; TASKS §1 Eurostars entry; EXTERNAL-ACCOUNTS row 15 ("apply now, use much later") |
| R-9 | **Medium** | Public-facing status is stale. The README promises shadow recording "once the VM and FIRMS credentials are provisioned", and the repo is public. | `README.md` Status section |
| R-10 | **Low** | Numbers drift across documents. `FIT_DECISIONS` is 18 in code and 20 in review 24 §1 and in memory. V2 is "12" in review 24 and 13 rows in TASKS Track V2. | `fit-report.ts:30–49`; review 24 §1(2, 6); TASKS 2653–2671 |

---

## 4. Detailed recommendations

| # | Tag | Maps to | Recommendation | Owner | Effort |
|---|---|---|---|---|---|
| E-1 | [MVP] | R-3 | **Write the freeze.** Add a dated "Feature freeze until v1 runs on a host for 7 days" block at the top of V2-FEATURES §7, V3-FEATURES §7 and V3-WORKPLAN §2. Mark every unstarted V3 row `frozen`. `%-start-on-roadmap` must skip `frozen` rows. Built V2/V3 code stays and is not reverted, but it stays unregistered or flag-off and unticked until the founder accepts it per item. | founder (decision, 0.5 fh) + agent | 1.5 h |
| E-2 | [MVP] | R-1 | **Day 0 in one sitting.** Run EXTERNAL-ACCOUNTS rows 4 (MAP_KEY), 5 (Hetzner), 6 (Cloudflare/R2), 7 (healthchecks), 10 (Grafana) and the mail sender, then start the DS-1 backfill (B8 remainder) the same day. Start the ЕООД (row 22) that week. Apply to Galileo (row 15). This is the single highest-leverage act left in the programme. | founder (human act) | 4–6 fh + ЕООД errands |
| E-3 | [MVP] | R-2, R-7 | **Record CP1 honestly and re-date it.** Write `docs/reports/2026-10-31-cp1.md` with the outcome "missed: no report, no data; business paused per GATES §4". Commit a one-page CP1′ protocol (A2 shadow definitions) that runs on the 2024 calibration season plus any live rows from Nov–Dec. 2025 is excluded unless the founder spends the test season deliberately (Q3). Due 18 Dec 2026. | agent (protocol, report shell) + founder (sign) | 3 h + 0.5 fh |
| E-4 | [MVP] | R-4 | **Decision batches.** Each week, an agent compiles `docs/decisions/batches/YYYY-MM-DD.md` with at most 25 rows. Each row is a single question with a recommended default, a consequence-if-default and a reversibility tag. The founder answers in one 60-minute sitting. Unanswered rows roll forward. A row past its due date gets its default applied and logged, unless it is irreversible. Format in §5.3. | agent (compile) + founder (60 min/week) | 2 h setup + 1 h/week |
| E-5 | [MVP] | R-5 | **Three numbers, not one.** Replace the single % with built / proven-on-host / founder-accepted. Exclude V2/V3 from release scope and report them as "off-release hours". Add the remote CI state of `main` (last run id and conclusion) to the block. Adopt review 22 E5's `[~]` marker for built-unticked rows. Recompute now and on every merge wave. | agent | 3 h |
| E-6 | [MVP] | R-6 | **Pull K1's long poles forward.** I2 polygons, the sign-up UI, the PWA shell and the mail-sender wiring become the only workable build items after CI and deploy. They are scheduled for Jan 2027 so beta recruitment can open on 1 Mar. Draft the beta recruitment plan now (channels from review 10, consent text, the 500 target per week). | agent (build) + founder (channels) | ~60 h agent; 4 fh |
| E-7 | [v1] | R-8 | **Restart WP10 as a dated track.** Record the Eurostars outcome (missed or skipped). Pick the 2027 funding target (review 10: CASSINI 2027 / НИФ / EEA-Norway). Book 3 duty-officer interviews and 2 partner conversations before 31 Jan, because CP2 needs one partnership and one application. | founder | 8–12 fh over Nov–Jan |
| E-8 | [MVP] | R-9 | **README Status tells the truth.** Say: "built, not yet deployed; 2026 season not recorded; launch target May 2027 under re-plan". Link GATES §4. | agent | 0.3 h |
| E-9 | [v1] | R-10 | **One source for counts.** Have the release-progress script emit the backlog counts (register sizes, §1 entries, V2/V3 rows) from code, so reviews and memory cite a generated number. | agent | 2 h |
| E-10 | [v2+] | R-3 | **A standing rule for proposals.** A future feature analysis (V4…) may be written, but no item is built until it has a founder tick in TASKS and v1 has a recorded season. Encode the rule in the start-on-roadmap skill's claim filter. | founder (rule) + agent | 1 h |

---

## 5. Product & delivery deep dive

### 5.1 The critical path, re-measured (R-1, R-6)

The path to a May 2027 launch is a chain of human acts and calendar time:

Day 0 accounts → host + deploy (L-12) → poller recording + restore drill (L-17) → ЕООД (L-10) → I2 zones + sign-up + PWA + mailer on host → beta recruitment → H9 live shadow ≥ 2 weeks (L-1) → CP2 (30 Apr) → L-3/L-11/K3 → K4.

Of the engineering on this chain, only I2, the sign-up UI, the PWA and the deploy job remain. The release block lists 31.5 h of workable time and 141.1 h blocked; 141.1 h is roughly 82 % of the remainder. Everything else is a founder or third-party act with a lead time:
- the ЕООД takes 2–4 weeks;
- Galileo takes months;
- beta recruitment cannot start before zones are storable;
- the live shadow occupies Mar–Apr by definition.

The chain has about 26 weeks to run and no slack before 1 Dec. Agent hours are not scarce. In the week from 24 to 29 Oct, agents produced more off-release work (V2 wave 1 ~90 h, wave 2 and G2, V3 44 h) than the whole workable release remainder.

### 5.2 Scope discipline: what to stop building (R-3)

The one sentence review 24 asked for: **stop building V2 and V3 now; the next agent hour goes to CI, deploy, I2, sign-up, PWA, in that order.**

The record shows how the inversion happened:
- 2026-09-28: a competitor review produced F9–F18 (wind, passes, swaths, cloud, lightning) inside the v1 track.
- 2026-10-24: V2 was analysed and wave 1 (11 items) built the same day.
- 2026-10-27: wave 2 and G2 webhooks were built.
- 2026-10-28: V3 was analysed and a parallel work plan written.
- 2026-10-29: V3-P1–P4 and A1 were done.

The proposal documents carried the right rule ("not committed scope until the founder ticks it"). The claim tooling did not enforce it, and a free row reads as an invitation to an agent. E-1 and E-10 move the rule into the tool.

What to do with built-unticked work: keep it, flag it off or leave it unregistered, and present it to the founder as **accept / defer / remove** rows in the decision batches (§5.3). Do not tick it in bulk. Each V2 item carries its own decision set, and ticking without answering it turns drafts into commitments.

Two items deserve an early accept/remove call, because they cost launch budget:
- V2 lazy layers that pushed `criticalPath` to 360,767 B against the 358,400 B budget (`KNOWN_OVER_BUDGET`);
- the Esri imagery toggle, which is scope-cut #1.

### 5.3 The founder backlog: count and triage format (R-4)

| Source | Count | Oldest / due |
|---|---|---|
| TASKS §1 "Pending founder decisions" | 17 | three "this week" items from 2026-09-02; Eurostars 1 Sep; retention, rule 8, CP1 protocol and stopping rule from Sep 2026 |
| Web copy `PENDING_FOUNDER_REVIEW` (19 namespaces; staffCuration 41, eventDetail 31, layers 24) | 205 | since F-track |
| Server copy drafts (alert templates, sign-in mail) | 24 | H6 |
| `FIT_DECISIONS` | 18 | D7, 2026-10-11 |
| D1 open choices shipped unarmed | 19 | D1 |
| V2-Q1–Q5, V3-Q1–Q7 | 12 | Oct 2026 |
| V2 per-item parameter/copy keys (A1 21, D3 17, E2 16, B3 13, F1 10, A4 8; G2 `webhook_params_v1`) | ≈ 85 | Oct 2026 |
| **Total** | **≥ 380** | ≥ 6 past due |

At 25 rows a week, this is about 15 weekly sittings, and it is only feasible if almost all rows are default-accept. They should be. Most copy keys and parameters already have a drafted value, and the founder's real job is to veto, not to author.

**Batch row format** (E-4):

`| id | question (one line) | recommended default | if default: consequence | reversible? (yes / at-migration / no) | due | answer |`

**Rules:**
- Irreversible rows go first and are never auto-defaulted: legal, licence, retention, the CP protocol, touching the test season, and anything public.
- Reversible rows past due get the default applied and logged in the batch file.
- Copy keys are batched by namespace, so one sitting clears staffCuration (41) or eventDetail (31) whole.
- The V2 accept/defer/remove rows ride in the same file.

**Order of batches:**
1. Batch 1 (week of 2 Nov): the six past-due §1 items plus Q1–Q4 of this review.
2. Batch 2: the CP1′ protocol and FIT_DECISIONS.
3. Batches 3–6: launch-surface copy (eventDetail, signIn, privacy, disclaimer, alert templates).
4. Later: everything V2/V3, which is not on the launch path.

### 5.4 Honesty of the progress signal (R-5)

Review 22 §5.4 found the signal under-reported, because it counted only ticked rows. Since then it has flipped to over-reporting.
- **Staleness.** The block reads "Updated 2026-10-13 at fb97640" and has a single history entry.
- **Counted as done without being proven.** `*-built` rows count as `done`; for example, C-built is 40.1 h and F-built is 52.6 h. Nothing in them has run on a host, and 51 boxes are ticked against 72 open.
- **Unsupported claim.** "All gates green" in WORKLOG and V2 §7 meant local `pnpm verify`, which excludes integration. GitHub CI on `main`:
  - last green on 2026-09-26 (run 36255108495);
  - red since: Supply chain from 10-02 to 10-22, then "Migrations against PostGIS" from 10-27 to 10-29;
  - latest failure: `pg-detection-store.integration.test.ts`, "stores a polled row with the provenance needed to explain it later", 1 of 396 tests (run 40939772318).
- **Nothing prevents a red merge.** `main` is unprotected (`gh api` → 404).

E-5's three numbers make each of those gaps visible:
- **built** is what agents produce;
- **proven-on-host** is what the 26-week chain needs;
- **founder-accepted** is what the queue releases.

Today these read roughly 72 % (hours) / 0 % / 41 % (51 of 123 rows ticked, used as the proxy until acceptance is recorded per row). That is the honest headline.

### 5.5 What the missed season costs CP1, CP2 and K1 (R-2, R-6, R-7)

- **CP1.** No live perimeters exist, so the read must be the minimum-n fallback. DS-1 is not fetched, and EFFIS DS-3 is a candidate only. CP1′ is achievable by 18 Dec if the backfill starts by 15 Nov. The download is unattended: 666 chunks within the Area API's 5,000 transactions per 10 minutes. The read should use 2024 (the calibration season), keeping 2025 as D7's touch-once test season (R-7). Until then the "pause" in GATES §4 applies to marketing and spend only. Engineering on the critical path continues.
- **CP2.** The "beta live + L-1" leg moves from comfortable to tight. H9 needs ≥ 2 weeks of live shadow inside Mar–Apr on a host that has recorded since Nov–Dec, so the off-season poller run is also the stability burn-in. The partnership and funding legs depend on WP10 (E-7) and are independent of code.
- **K1.** 500 alert-armed users in about 8 weeks (1 Mar → 30 Apr) needs zones storable by 28 Feb, which needs the ЕООД by early Feb. An off-season launch of a fire map has no organic pull, so recruitment must come from partners (review 10's НАДРБ, forestry, PV operators). This is the leg most likely to miss. The founder should pre-decide the CP2 partial-miss rule for it (Q5).
- **L-14 / L-3.** Accept `pass_unproven` and the planning baseline now, in writing, so that neither surfaces as a surprise in April.

### 5.6 Re-sequenced plan, Nov 2026 → May 2027

| Window | Milestone (exit test) | Owner |
|---|---|---|
| 2–8 Nov | Freeze written (E-1). Batch 1 answered (E-4). Day 0 accounts exist (E-2). DS-1 backfill running. ЕООД filed. CI green and `main` protected (R5-ARCH-1). CP1 missed-report committed (E-3). | founder + agent |
| 9–29 Nov | First deploy via `deploy.yml` (L-12 stub filled). Poller recording on host. healthchecks paging. Restore drill (L-17). Galileo applied. README truthful. | agent + founder |
| 1–18 Dec | **CP1′ report** on 2024 + live rows, signed. Batches 2–3. Eurostars/2027 funding target recorded. 3 interviews booked. | agent + founder |
| 19 Dec – 6 Jan | Founder recovery block (RB-1 moved from Nov). The host keeps recording unattended (the burn-in test). | — |
| Jan 2027 | I2 zones, sign-up UI, PWA shell, mail sender live on host. ЕООД registered, so L-10 can be signed. Batches 4–6 (launch copy). Beta recruitment plan approved. | agent + founder |
| Feb 2027 | Alert path end to end on host (I-track); L-3 at planning baseline; partner channel opened; **zones storable by 28 Feb**. | agent + founder |
| 1 Mar – 15 Apr | **H9 live shadow** (≥ 2 weeks clean = L-1); beta opens 1 Mar; weekly K1 count. | founder |
| 30 Apr | **CP2.** Go/no-go per GATES §4, with the pre-agreed partial-miss rule (Q5). | founder |
| May 2027 | L-11 pre-season drill, K3 checklist, **K4 launch window**, never during a mega-fire. | founder + agent |

If Day 0 slips past 30 Nov, CP2's beta leg is forfeit by arithmetic. The founder should then apply GATES §4's "re-target the next pre-season window" rule on 1 Dec, not on 30 Apr.

---

## 6. Open questions for the founder

1. **Do you accept a written V2/V3 freeze until v1 has run on a host for 7 days?** *Recommended: yes.* Built code stays flag-off, and each V2 item becomes an accept/defer/remove row.
2. **When will Day 0 (MAP_KEY, Hetzner, Cloudflare/R2, healthchecks, mail sender) happen?** *Recommended: a fixed half-day in the week of 2 Nov, with the ЕООД filed the same week.*
3. **CP1′: may the read use 2025, the D7 touch-once test season?** *Recommended: no. Read 2024 plus live Nov–Dec rows, and keep 2025 for D7.*
4. **Do you adopt weekly decision batches with default-on-expiry for reversible rows?** *Recommended: yes, 60 min/week, irreversible rows never auto-defaulted.*
5. **What is the CP2 partial-miss rule for K1 if beta is live but below 500 alert-armed users?** *Recommended: ≥ 200 alert-armed plus L-1 signed means launch in May with K1 re-measured at CP3. Below 200 means re-target the next pre-season window.*
6. **Eurostars: what happened on 1 Sep, and what is the 2027 funding target?** *Recommended: record "missed", target CASSINI 2027 or НИФ per review 10, and apply by Q1.*
7. **Should the release % exclude V2/V3 and show built / proven / accepted?** *Recommended: yes.*

---

## Appendix A — Proposed rows for the shared documents

### (a) TASKS rows (Track R5)

- [ ] **R5-PROD-1 — Written V2/V3 feature freeze, enforced by the claim tool.** Spec: review 26 E-1, E-10. Writes: `docs/V2-FEATURES.md` §7, `docs/V3-FEATURES.md` §7, `docs/V3-WORKPLAN.md` §2 (freeze block, unstarted rows → `frozen`), the start-on-roadmap claim filter. Done when: `scan` on V3-WORKPLAN reports 0 free rows and the freeze block names its lift condition. Est: 1.5 h. Status: blocked-owner.
- [ ] **R5-PROD-2 — Day 0: accounts, host and backfill started.** Spec: review 26 E-2. Writes: `docs/EXTERNAL-ACCOUNTS.md` (DPA/date columns), `docs/data/DATASETS.md` DS-1 "Fetched". Done when: MAP_KEY, VM, R2, healthchecks and mail sender exist; the DS-1 manifest shows ≥ 1 verified chunk; the ЕООД filing date is recorded. Est: 1 h (agent follow-through). Status: blocked-owner.
- [ ] **R5-PROD-3 — CP1 missed-report and CP1′ protocol.** Spec: review 26 E-3. Writes: `docs/reports/2026-10-31-cp1.md`, `docs/reports/cp1-prime-protocol.md`, `docs/GATES.md` §4 (link + CP1′ date). Done when: both files are committed, GATES §4 links them, and the protocol names its seasons and excludes the 2025 test season unless Q3 says otherwise. Est: 3 h. Status: open.
- [ ] **R5-PROD-4 — Weekly founder decision batches.** Spec: review 26 E-4, §5.3. Writes: `docs/decisions/batches/README.md`, `docs/decisions/batches/2026-11-02.md`, `docs/TASKS.md` §1 (pointer). Done when: batch 1 holds the six past-due §1 items and this review's Q1–Q7 in the §5.3 row format, and each answered row is reflected back in TASKS §1. Est: 2 h. Status: open.
- [ ] **R5-PROD-5 — Three-number release signal with remote CI state.** Spec: review 26 E-5, E-9. Writes: the release-progress script and block in `docs/TASKS.md` lines 10–120. Done when: the block shows built / proven-on-host / founder-accepted, off-release hours for V2/V3, the last `main` CI run id and conclusion, and generated backlog counts; `[~]` marks built-unticked rows. Est: 4 h. Status: open.
- [ ] **R5-PROD-6 — K1 long poles: I2 zones, sign-up UI, PWA shell, mail sender on host.** Spec: review 26 E-6. Writes: per TASKS I2, I-track sign-up, F-track PWA rows. Done when: a test user on the host can store a zone and receive a test alert by mail, by 28 Feb 2027. Est: 60 h. Status: blocked-external.
- [ ] **R5-PROD-7 — Beta recruitment plan.** Spec: review 26 E-6, §5.5. Writes: `docs/BETA-PLAN.md`. Done when: channels, consent text, a weekly target curve to 500 and the Q5 partial-miss rule are written and founder-signed. Est: 2 h + 4 fh. Status: blocked-owner.
- [ ] **R5-PROD-8 — WP10 restart: funding target and outreach log.** Spec: review 26 E-7. Writes: `docs/TASKS.md` §1 (Eurostars outcome), WP10 log. Done when: the Eurostars outcome is recorded, a 2027 application is named with a date, and ≥ 3 interviews plus 2 partner calls are logged by 31 Jan 2027. Est: 1 h + 10 fh. Status: blocked-owner.
- [ ] **R5-PROD-9 — README Status reflects reality.** Spec: review 26 E-8. Writes: `README.md`. Done when: Status says built / not deployed / season not recorded / May 2027 under re-plan and links GATES §4. Est: 0.3 h. Status: open.

### (b) RISKS §2 / GATES rows

RISKS §2 (watchlist):

| Item | What can happen | Trigger / monitor | Response |
|---|---|---|---|
| **Scope ahead of v1** | Agent capacity flows to unticked V2/V3 work while the launch path waits on human acts | off-release hours > 0 in the release block while proven-on-host < 100 % | freeze (R5-PROD-1); claim filter skips `frozen` |
| **Founder-queue growth** | Decisions arrive faster than they are taken; drafts ship as defaults by accident | backlog count rising across two consecutive batches; any irreversible row past due | weekly batch (R5-PROD-4); no new feature until the count falls |
| **Day 0 slip** | CP2 beta leg forfeits by arithmetic | no host by 30 Nov 2026 | re-target per GATES §4 on 1 Dec, not 30 Apr |

GATES §4: add **CP1′ — 18 Dec 2026**, with the same criteria as CP1 on 2024 plus live Nov–Dec rows, and the report at `docs/reports/`. Under CP2, add the K1 partial-miss rule once Q5 is answered.

### (c) Synthesis paragraph for 00-summary

> Review 26 (product & delivery) rates May 2027 **NO-GO as run, CONDITIONAL GO** on five acts before 15 Nov: a written V2/V3 freeze, Day 0 accounts with the backfill started, CI green on a protected `main`, CP1 recorded as missed with a CP1′ read on 18 Dec, and weekly founder decision batches. The software is not the constraint. The critical path is about 26 weeks of human acts and calendar time (ЕООД, host, zones, beta recruitment, the Mar–Apr live shadow), while agents spent the last week on more off-release work than the whole workable release remainder. The founder queue is at least 380 items with at least six past due. The 71.9 % signal is stale and counts unproven work as done, so the review replaces it with built / proven-on-host / founder-accepted, which today reads roughly 72 / 0 / 41 (ticked rows as the acceptance proxy).

---

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| 180 commits, HEAD `ccd541a`, per-day distribution | `git log --oneline \| wc -l`; `git log --format=%ad --date=short \| sort \| uniq -c` |
| CI red on 9 consecutive `main` runs since 2026-09-26; failing test and counts | `gh run list --branch main`; `gh run view 40939772318 --log-failed` |
| `main` unprotected; no environments | `gh api repos/:owner/:repo/branches/main/protection` → 404; `…/environments` → `total_count 0` |
| 71.9 %, 31.5 h workable / 141.1 h blocked, dated 2026-10-13 | read `docs/TASKS.md` lines 10–120 |
| 51 ticked / 72 open / 0 `[~]` | `grep -c '^- \[x\]'`, `grep -c '^- \[ \]'`, `grep -c '^- \[~\]'` on `docs/TASKS.md` |
| 205 pending copy keys in 19 namespaces | awk over `catalog-governance.ts` from line 925 to the register's end; per-namespace `uniq -c` |
| 24 server copy drafts | `grep -c DRAFTED` and "pending founder review" in `alert-copy.ts` and `sign-in-mail-copy.ts` |
| 18 `FIT_DECISIONS` | read `server/src/core/fit/fit-report.ts` lines 30–49 |
| 17 TASKS §1 entries, ≥ 6 past due | read TASKS §1; dated items compared with 2026-10-30 |
| V2 13 rows unticked; V3 5/39 done; A1 gate unmet | read TASKS 2653–2671; `docs/V3-WORKPLAN.md` §2 rows 56–60 |
| No CP1 report; DS-1 not fetched; B8 remainder 0.7 h | `ls docs/reports` (absent); `docs/data/DATASETS.md` DS-1 "Fetched"; TASKS release table row B8 |
| MAP_KEY instant and free; ЕООД 2–4 weeks; Galileo months | `docs/EXTERNAL-ACCOUNTS.md` rows 4, 15, 22 |
| CP1 pause rule, CP2 forfeiture rule, L-1/L-3/L-14 fallbacks | read `docs/GATES.md` §3–4 |
| Scope-cut #1 (Esri) built; never-cut #1 (FIRMS capture Sep 2026) missed | `docs/IMPLEMENTATION-PLAN.md` cut lists; TASKS G6; DATASETS DS-1 |
| Scope-sequence dates (F9–F18, V2, V3) | `WORKLOG.md` headings 2026-09-28 → 2026-10-29 |
| Not verified | Eurostars outcome (not recorded anywhere); whether any Day 0 account exists outside the repo; the cause of the failing integration test (left to review 29) |
