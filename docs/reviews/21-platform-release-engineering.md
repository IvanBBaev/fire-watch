# Review 21 — Platform & release engineering

*Reviewer role: senior platform / release engineer (delivery pipeline, host contract, secrets delivery, supply-chain policy, restore ordering). Date: 2026-09-02. Status: complete.*

*Inputs reviewed: `infra/README.md`, `infra/provision.sh`, `infra/cloud-init.yaml`, `.github/workflows/ci.yml`, `renovate.json`, `pnpm-workspace.yaml`, OPERATIONS §6, §8, §9, GATES §3 (L-11, L-12), IMPLEMENTATION-PLAN tiers, EXTERNAL-ACCOUNTS rows 5–8, TASKS B8/B9/C1/C4/C6, review 04 §5.6 and §6, review 05 §5.6.1, review 13 B2, review 20 §4.1. The GitHub repository state was read through the API (branch protection, environments, last workflow run). Project is in implementation (WP0–WP2).*

---

## 1. Summary verdict

**CONDITIONAL GO — the design of the delivery path is sound and unusually well written; the delivery path does not exist, and the calendar it was written for has already run out.** Every launch-critical operational rule in OPERATIONS §9 assumes a deploy pipeline that renders `compose.yaml`, ships secrets, tags images by git SHA and keeps `last_good`. No such pipeline is in the repository. The one artifact that exists — the provisioning contract — cannot run: its rendered user-data is half again over the provider's hard cap, and the script refuses (correctly) to submit it. Nothing in this review asks for design work. It asks for six decisions and roughly one week of engineering, in a fixed order.

1. **The provisioning contract is blocked by a documented, decided-nowhere choice** (§5.1, R-1). `infra/README.md` names two sanctioned ways past the 32 KiB user-data cap and defers the choice to "§9-level policy". Nobody has made it. Until it is made, no VM can be provisioned from code, which is the premise of OPERATIONS §5's RTO and §9.2's drift rule.
2. **Three documents assume a deploy pipeline; none contains one** (§5.2, R-3). OPERATIONS §9.3 rules 1–6, review 04 §5.6's CI/CD sketch and `infra/README.md` step 4 all describe `deploy.yml` / `deploy.sh <git-sha>`. `ci.yml` is the only workflow. The provisioning script prints a hand-off ("deliver `compose.yaml`, `deploy.sh`, `secrets.env`") to a pipeline that does not exist.
3. **The "protection before the poller" ordering from review 13 B2 is currently unrealisable** (§5.5, R-2). The restore side of the backup story is a stub that exits 64, runbook RB-2 is unwritten, the R2 backup token is write-only by design (§6.2 rule 2) so a restore credential has to exist somewhere else, and TASKS C6 is gated on a host. Backups without a restore path are a hope, not protection.
4. **The supply-chain override precedent has no expiry mechanism** (§5.4, R-5). The pinned `overrides` and the `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` carry a comment saying to delete them "once its patched release has aged past the window". A comment is not a mechanism. The first exception to a policy is the policy; this one will be copied.
5. **`main` is unprotected and the repository has no `production` environment** (§5.3, R-4, R-6). Review 05 §5.6.1 asked for both. The API returns 404 for branch protection and an empty environment list. Every secret in OPERATIONS §8.1 whose "lives in" column says "GitHub Environments" currently lives nowhere.
6. **The season deploy gate L-12 cannot be passed as written** (§5.6, R-7). Its checkbox 6 requires kill switches "verified in staging"; review 04 §6 Q7 records that no staging exists and that this is correct at the budget. Both documents are right; the gate text is wrong.
7. **The "Honest status" block in `infra/README.md` is the best thing in the tree** (§2). It says the script has never touched a real VM, names what was validated instead, and lists the exit codes. This review is possible because the author wrote it. Keep the habit.

GO is conditional on §4 E1–E3 and E6 being decided this week, and on the §5.7 minimum path being started before any further D-track work. The season the plan was written to protect ends on 15 October; the plan's own hard date for the poller passed at the start of September.

## 2. Strengths (sound as proposed)

- **The host is code, and the contract says so.** `cloud-init.yaml` carries users, SSH policy, firewall, Docker, unattended upgrades and the backup scripts; OPERATIONS §9.2's drift rule ("anything configured by hand over SSH … is presumed lost") is the right rule and is stated once.
- **The provisioning script fails closed.** Exit 2 on the size preflight, exit 64 on the restore stub, `--dry-run` with a lossless renderer, `bash -n` and shellcheck in the README. A script that refuses to submit an over-cap payload is worth more than one that silently truncates it.
- **§9.3's deploy rules are correct and small.** SHA-addressed images, one-command rollback to `last_good`, forward-only expand/contract migrations run by the worker behind an advisory lock, deploy freeze conditions, SSE drain, post-deploy heartbeat. There is nothing to add to the rules — only to build them.
- **`ci.yml` is already a real gate.** Typecheck, lint, format, boundaries, unit tests, golden replay with a determinism double-run, migrations up/down/up against PostGIS, generated-type drift, `pnpm audit --audit-level=high`, secret-shape checks. Actions are SHA-pinned. This is the verify half of the pipeline; only the deliver half is missing.
- **Renovate is configured the way review 05 asked.** Seven-day `minimumReleaseAge`, Monday batching, digest pinning for Actions, dashboard approval for TypeScript and Vite, vulnerability alerts allowed any time.
- **The secrets inventory (OPERATIONS §8.1) is complete enough to build from.** Every secret has a holder, a blast radius and a rotation line. Nothing in this review changes a row; it asks for the rows to become real.
- **No staging is the right call at this budget** (04 §6 Q7). The mistake is elsewhere — in a gate that forgot the decision (§5.6).

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | No path to a host: the user-data cap decision is unmade, there is no Hetzner account or token (EXTERNAL-ACCOUNTS row 5, "instant"), and the poller's hard date ("early September 2026", IMPLEMENTATION-PLAN Tier 1) has passed. Every day the shadow season is not recorded is unbackfillable (DATA-SOURCES §E2). | §5.1, §5.7 |
| R-2 | **Critical** | Backups cannot be proven restorable: `--restore-from` and `fw-restore-drill` exit 64, RB-2 is unwritten, no restore-side credential exists, and the L-11 pre-season drill has no rehearsal. Review 13 B2's ordering ("the paging/backup protecting it" in the same DoD as the poller) is asserted, not built. | §5.5 |
| R-3 | **High** | The deploy pipeline is a shared assumption of OPERATIONS §9.3, review 04 §5.6 and `infra/README.md` step 4, and exists in none. Two `TODO(OPERATIONS §9.1)` markers in `cloud-init.yaml` (canonical service names, immutable image refs) are owed by it. A second, manual deploy path is how `last_good` stops being true. | §5.2 |
| R-4 | **High** | Secrets delivery is undefined in practice: no `production` environment, no deploy user key, no rendered `secrets.env`; `backup.env` ships with `R2_BUCKET=REPLACE_ME`. The first deploy will be done by hand with pasted values, which §9.2 then declares presumed lost. | §5.3 |
| R-5 | **High** | Supply-chain override precedent (`overrides` for `brace-expansion` ×2 and `nanoid`; `minimumReleaseAgeExclude: [nanoid]`) with no expiry check, no decision record and no reviewer. The `minimumReleaseAge` window is the review 05 control; the exclusion punches through it. | §5.4 |
| R-6 | **High** | `main` is unprotected; `ci.yml` runs only on push to `main` and on PRs. Combined with the working-tree state review 22 measures, the verify gate has not run on most of the code that exists. | §5.3 (mechanism here; cadence in [review 22](22-engineering-practice.md) §5.1) |
| R-7 | **Medium** | L-12 checkbox 6 and L-15 require a staging environment that 04 §6 Q7 rules out. The season gate is unpassable as written; when a deploy has to happen, the box will be ticked by interpretation. | §5.6 |
| R-8 | **Medium** | The §9.2 drift rule has no mechanism until the §6.3 drill runs; the drill needs R-2 fixed. Drift between provisioning and reality accumulates silently for the whole first season. | §5.5 |
| R-9 | **Medium** | The first-deploy checklist is scattered across four documents (EXTERNAL-ACCOUNTS rows 5–8, OPERATIONS §8.1, `infra/README.md` steps 1–5, TASKS B9/C6). Nobody can execute it top to bottom without reading all four. | §5.7 |
| R-10 | **Low** | Provider-side variables that only matter on first contact — CX22/CAX11 availability, IPv4 surcharge, Debian 12 image name — are unverified because no account exists. Each is a fifteen-minute fix once discovered, but they are discovered serially. | §5.7 |

## 4. Detailed recommendations

- **E1 [MVP] Decide the cap: slim the contract (option 1), not the pre-signed `#include` (option 2).** Maps to R-1. Rationale in §5.1. `cloud-init.yaml` keeps everything the host needs before the first deploy — users, SSH, firewall, Docker, unattended upgrades, the deploy user — and drops the three embedded scripts (`fw-backup`, `fw-restore-drill`, `fw-provision`). Those become deploy-time artifacts under `infra/host/` shipped by E2 with a checksum manifest. The §9.2 drift rule is extended by one sentence: "or not present in the deploy-delivered set under `infra/host/`". Owner: the founder as OPERATIONS §9 owner. Effort: a day.
- **E2 [MVP] Build the deliver half of the pipeline as one change set:** `deploy.yml` (build → push `ghcr.io/…:{git-sha}` → `environment: production` → `ssh deploy@vm deploy.sh <sha>` → smoke → tag `last_good`), `deploy.sh` on the host (pull, `compose up -d`, wait for the worker's migration lock to release, health probe, write `last_good`), and the `compose.yaml` that closes the two `TODO(OPERATIONS §9.1)` markers. Maps to R-3. Reuse `ci.yml`'s verify jobs as a required predecessor; do not duplicate them. Effort: two days. **Rule:** there is one deploy path. Manual `compose up` on the host is allowed exactly once — the first deploy — and that session is recorded in WORKLOG as the thing E2 replaces.
- **E3 [MVP] Make the secrets rows real.** Create the `production` environment, load every OPERATIONS §8.1 row whose "lives in" says GitHub Environments, add the deploy SSH key, render `secrets.env` and `backup.env` from the environment in `deploy.yml`. `HCLOUD_TOKEN` is not in §8.1 and must not be: provisioning is a laptop act with a password-manager credential, never a CI secret. Add that row to §8.1 with "lives in: password manager; holder: `provision.sh` on the founder's machine". Maps to R-4.
- **E4 [MVP] Write the override policy into `pnpm-workspace.yaml`'s comment block and enforce its expiry.** Five rules: scoped (one package, one range), paired (an override always has a matching advisory id), dated (a `# until:` line with the patched release's date + window), tested (a script fails CI when an override or exclusion is older than `minimumReleaseAge` past its patched release, i.e. when the override has become a no-op), recorded (the WORKLOG entry that added it names the advisory). Maps to R-5. The expiry check is gate-shaped; proposed as CI-16 in §6 Q3 rather than added here.
- **E5 [MVP] Protect `main`:** require `verify`, `integration`, `supply-chain`; linear history; no force-push; include administrators. Maps to R-6. This is a five-minute act; it is listed because review 05 asked in June and it is still unset. The cadence rule for landing work on `main` is review 22's; the setting is this seat's.
- **E6 [MVP] Restore before poller, made concrete.** Write RB-2 (restore from the R2 nightly to a scratch VM provisioned by E1's contract) before C6 is ticked; issue a *separate read-only* R2 token held off-VM (password manager) for restores, because the backup token is write-only by design; implement `fw-restore-drill` against it; run the drill once on a scratch VM and record the RTO in OPERATIONS §5. Maps to R-2, R-8. The L-11 pre-season drill then has a rehearsal.
- **E7 [MVP] One first-deploy checklist, in one place.** A numbered list in `infra/README.md` §"First deploy" that links, in order, to EXTERNAL-ACCOUNTS rows 5–8 (sign-ups), OPERATIONS §8.1 (secrets to mint), E1 (provision), E2 (deploy), E6 (restore drill), TASKS B9/C6/C4 (tick when done). Maps to R-9, R-10. It exists so that the founder, or the successor from review 18 §5.5, can do the whole thing in one sitting.
- **E8 [MVP] Fix the L-12 and L-15 text.** Replace "verified in staging" with "verified on the rehearsal profile" — the laptop compose profile review 04 §6 Q7 already names — and add the profile to `compose.yaml` in E2. Maps to R-7. This changes a gate; escalated as a disagreement in §6 Q2, not applied.
- **E9 [v1] Drift detection as a job, not a drill.** A weekly `fw-drift` check on the host compares installed packages, open ports, users and the `infra/host/` checksum manifest against the contract and pings healthchecks.io on pass. Turns §9.2's rule into a signal between drills. Maps to R-8.
- **E10 [v2] Reject blue-green / second VM.** Rollback-by-`last_good` on one host is the right shape at €6–21/month. Revisit at OPERATIONS §10 U-10 with the first SLA.

## 5. Platform & release deep dive

### 5.1 The 32 KiB decision (R-1)

`infra/README.md` measures the problem precisely: raw contract 59,806 bytes, rendered 49,431 bytes (49,462 with a key), cap 32,768. It names two ways out and declines to choose. That is correct behaviour for a script author and wrong behaviour for a project — the choice has been sitting since the file was written, and every downstream task (B9, C1, C4, C6) waits on it.

**Recommendation: option 1, slim the contract.** Reasons:

- Option 2 (`#include` of a pre-signed URL) adds a trust surface at the one moment the host has no identity yet: a URL in user-data that anyone on the provider's metadata path can read, pointing at a bucket that has to be public-by-signature. Review 05's threat model never priced this because the design never proposed it.
- Option 1 costs nothing the pipeline does not already owe. E2 has to deliver `compose.yaml`, `deploy.sh` and `secrets.env` anyway; three more files with a checksum manifest is the same mechanism.
- The three embedded scripts are the ones most likely to change (backup layout, restore procedure). Moving them out of cloud-init means changing them does not mean re-provisioning.
- What must stay in cloud-init is exactly what E2 cannot deliver because it runs before E2 has a host to deliver to: users, SSH policy, firewall, Docker, unattended upgrades.

The one thing option 1 loses — a host that is fully described by one file — is recovered by E1's one-sentence extension of §9.2 and by E9's drift check reading both sets.

### 5.2 Three documents, one missing pipeline (R-3)

OPERATIONS §9.3 rule 1 says `deploy.sh <git-sha>`; rule 2 says rollback is one command; rule 3 says migrations run by the worker on boot behind a lock; rule 6 says a heartbeat ping closes a deploy. Review 04 §5.6 sketches `deploy.yml` with `ghcr.io` SHA tags and `last_good`. `infra/README.md` step 4 says, verbatim, that `deploy.yml` "does not" exist today and only `ci.yml` does. `cloud-init.yaml` carries two `TODO(OPERATIONS §9.1)` markers for the canonical service names and the immutable image references, both "owned by the deploy contract".

The gap is not that someone forgot. It is that each document correctly assumed the pipeline was someone else's artifact and none of the assumed owners was staffed — the shape review 15 §7.3 called dangerous, and review 20 §4.1 found. The fix is E2, and the important part of E2 is not the YAML; it is the rule that there is one path. The first manual deploy is unavoidable (the pipeline needs a host to deploy to, and the host needs the pipeline's files). It should be done once, written down, and replaced by E2 before the second deploy.

### 5.3 Secrets delivery and repository settings (R-4, R-6)

OPERATIONS §8.1 is a complete inventory. Eleven of its fourteen rows say "GitHub Environments" and the API returns an empty environment list. Branch protection on `main` returns 404. Review 05 §5.6.1 asked for both in June with the words "branch protection on main, Actions pinned by SHA, deploy secrets in GitHub Environments" — the middle one happened, the outer two did not, and nothing in the corpus distinguishes a done row from an undone one.

Two rules for E3:

1. **Provisioning credentials never enter CI.** `HCLOUD_TOKEN` is used by `provision.sh` on the founder's laptop and belongs in the password manager. Add it to §8.1 so the inventory stays the single list.
2. **Rendered env files are deploy outputs, never repository files.** `secrets.env` and `backup.env` are written by `deploy.sh` from the environment; `REPLACE_ME` placeholders are a preflight failure, not a default.

On `main`: E5 is a setting, not a process. The process — how often work lands on `main`, and what "integrated" means — is [review 22](22-engineering-practice.md) §5.1's. The two reviews were written to meet at this line.

### 5.4 The supply-chain override precedent (R-5)

`pnpm-workspace.yaml` overrides `brace-expansion` to patched 2.x and 5.x releases and `nanoid` to a patched release, and excludes `nanoid` from the seven-day `minimumReleaseAge` window. The WORKLOG records why: `pnpm audit --audit-level=high` in `ci.yml` failed on transitive advisories, the patched releases were younger than the window, and the choice was to override or to loosen the gate. Override was right. The comment in the file says to delete each entry once the patched release ages past the window. Nobody will, because nothing fails when they don't.

This matters more than three dev-only packages suggest. The `minimumReleaseAge` window is review 05's *only* control against a malicious release reaching the tree before the ecosystem notices. An exclusion is a hole in it; the first hole sets the shape of every later one. E4's five rules make each exception scoped, paired, dated, tested and recorded; the test is the part that turns a comment into a policy. The expiry script is small: read the overrides and exclusions, resolve each package's patched-release date from the lockfile metadata, fail when `today − release_date > minimumReleaseAge` because the override no longer does anything and its continued presence is untracked drift.

### 5.5 Restore before poller (R-2, R-8)

Review 13 B2 put the paging and backup into the same DoD as the poller because the shadow season's data is the plan's #1 asset and is unbackfillable. The implementation has the backup half in `cloud-init.yaml` (`fw-backup`, nightly, age-encrypted, post-upload ping). It has no restore half: `fw-restore-drill` is a stub that exits 64, `provision.sh --restore-from` exits 64, RB-2 is referenced from two files with two section numbers and exists in neither, and the R2 backup token is write-only by design — correct for tamper resistance, and it means a restore needs a second credential nobody has minted.

A backup that has never been restored is a file. The ordering that B2 asked for is: restore drill passes on a scratch VM → C6 ticked → poller on. E6 is that ordering made executable. It also gives L-11 (pre-season fire drill) its first rehearsal and turns §9.2's drift rule from "presumed" into "observed", because the scratch VM is the drift oracle.

### 5.6 A gate that forgot a decision (R-7)

L-12's checkbox 6 says "kill switches verified in staging". L-15 says a correction has been "rehearsed end to end on staging". Review 04 §6 Q7 says no staging is proposed and that this is correct at the budget; OPERATIONS §10 U-10 makes staging a step-up that arrives with the first SLA. Review 06 §6 Q7 asked whether a staging instance would exist and got, in effect, the answer "no" from 04 — and 06 §5.7's checklist, written before that answer, went into GATES unchanged.

Both gates are unpassable as written. When a season deploy has to happen the box will be ticked by interpretation, which is exactly what L-12's pass condition ("enforced in CI/CD, not by memory") exists to prevent. E8 rewrites both boxes against the laptop rehearsal profile 04 already names and E2 adds to `compose.yaml`. Because this changes two launch gates it is escalated (§6 Q2), not applied.

### 5.7 Minimum viable path to recording (R-1, R-9, R-10)

The sequence, with the seat that owns each step. It assumes the founder's calendar is the constraint and the D-track pauses.

| Day | Step | Owner | Done when |
|---|---|---|---|
| 0 | Sign up: Hetzner (+DPA), Cloudflare R2 bucket + lifecycle, healthchecks.io, UptimeRobot (EXTERNAL-ACCOUNTS rows 5–8). Mint the §8.1 secrets that exist today: FIRMS `MAP_KEY`, R2 backup token (write-only), R2 restore token (read-only, off-VM), deploy SSH key. | founder | rows ticked in EXTERNAL-ACCOUNTS; `production` environment populated (E3) |
| 1 | E1: slim the contract; rendered size under cap; `--dry-run` clean. | this seat | `provision.sh --dry-run` exit 0 |
| 1 | E5: protect `main`. | this seat | API returns a protection object |
| 2 | Provision the VM from code. Record every hand step in WORKLOG as a drift debt. | founder + this seat | host reachable by deploy user only; `fw-backup` runs and pings |
| 2–3 | E2: `deploy.yml`, `deploy.sh`, `compose.yaml` with the rehearsal profile; first deploy by hand, second by pipeline. | this seat | second deploy lands via `deploy.yml`; `last_good` written |
| 3 | E6: restore token, `fw-restore-drill`, RB-2; drill to a scratch VM; RTO recorded. | this seat + SRE (04) | C6 tickable; L-11 has a rehearsal |
| 4 | Poller on with the granule chain (C4) behind its flag; B8 ticked when live rows land. | founder | C1's "live rows landing continuously" |
| 5+ | Parity week (C9) starts; `availability.json` begins to fill. | data (23) | first week of `data_availability` responses recorded |

Seven days is an estimate with an unverified provider on the critical path (R-10). The order is not an estimate; it is B2's ordering with the restore leg made real.

## 6. Open questions for the team

1. **Cap decision (E1) — founder, as OPERATIONS §9 owner.** Option 1 is recommended in §5.1. Decide this week; nothing below moves until it is.
2. **Disagreement escalated: L-12 checkbox 6 and L-15's "on staging" (E8).** This review holds that both boxes must be reworded against the rehearsal profile because 04 §6 Q7 rules staging out. The review 06 author owns the checklist; the founder owns GATES. Not applied here.
3. **Should the override-expiry check become CI-16 (E4)?** It is gate-shaped and small. If accepted, GATES §1 gains one row; if not, it lives as a `pnpm run` script the Monday Renovate batch runs by hand. Founder decides; review 05's author is the natural reviewer.
4. **Who holds the restore-side R2 credential (E6)?** The backup token is write-only on the VM; the restore token must live off-VM. Password manager plus the offline copy review 18 §5.5 already requires is the proposal. Founder decides; ties into 18 §5.5's successor bundle.
5. **Is the first manual deploy allowed (E2 rule)?** This review says yes, once, recorded. If the founder prefers "pipeline from the first deploy", add a day to §5.7 for a bootstrap job that runs `deploy.sh` from the laptop with the same script the pipeline will use.
6. **Does the D-track pause for §5.7?** The seven-day path competes for the same person as D7/D9/D10. This review's position: yes, because the D-track's inputs (`availability.json`, WP1 arrival times, the season's own detections) do not exist until the poller runs on a host. Founder decides; [review 23](23-data-engineering-stewardship.md) §5.5 lists what is lost per unrecorded day.

## Appendix A — Proposed rows for the shared documents

**RISKS §2**

`| **No delivery path to a host** | The provisioning contract cannot run (user-data over the 32 KiB cap, decision unmade), no deploy pipeline exists, no account or token exists; the shadow season goes unrecorded day by day | Trigger: any week in September without a provisioned host. Monitor: 21 §5.7 table | Decide 21 E1 this week; execute 21 §5.7 in order; D-track pauses (21 §6 Q6) |`

**GATES §3 — added as L-17 (review 20 §6 pre-authorised a row when a checkable gate emerged; the wording is this review's, the gate is the founder's to strike)**

`| L-17 | **One deploy path, restore-proven**: `deploy.yml` is the only route to the host; `last_good` is written by it; a restore drill from the R2 nightly to a scratch VM has passed at least once with the RTO recorded in OPERATIONS §5; the L-12/L-15 "staging" wording is replaced by the rehearsal profile. **Pass:** the second deploy and the first restore drill are both recorded in WORKLOG with dates. | before the poller is left unattended | 21 §5.2, §5.5, §5.6 |`

**00-summary synthesis (3–4 sentences)**

Review 21 finds the delivery path designed in OPERATIONS §9 and review 04 §5.6 and built in none of the places that assume it: the provisioning contract is blocked by an unmade choice about the provider's user-data cap, `ci.yml` is the only workflow, `main` is unprotected, no `production` environment exists, and the restore half of the backup story is two stubs that exit 64. It recommends slimming the contract rather than pre-signed includes, one deploy path with a single recorded manual exception, an expiry-tested override policy, and a seven-day ordered path to recording that puts the restore drill before the poller as review 13 B2 intended. Two launch gates (L-12, L-15) require a staging environment that review 04 ruled out; the rewording is escalated, not applied.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| Rendered user-data 49,431 B vs 32,768 B cap; exit 2 preflight | `infra/README.md` "Known blocker" table; `provision.sh` exit-code table |
| No `deploy.yml`; `ci.yml` jobs verify / integration / supply-chain | `ls .github/workflows`; read of `ci.yml` |
| Actions SHA-pinned | `ci.yml` `uses:` lines |
| `main` unprotected; no environments | GitHub API: branch protection 404; environments `total_count: 0` |
| Last CI run 2026-08-09, success | GitHub API workflow runs |
| Overrides and exclusion | `pnpm-workspace.yaml` |
| Renovate settings | `renovate.json` |
| Restore stubs exit 64; RB-2 referenced with two section numbers | `provision.sh`, `cloud-init.yaml`, `infra/README.md` |
| §8.1 has no `HCLOUD_TOKEN` row | OPERATIONS §8.1 table |
| L-12 (6) and L-15 say "staging"; 04 §6 Q7 says none | GATES §3; review 04 §6 |
| Hard date "early September 2026" | IMPLEMENTATION-PLAN Tier 1 |

Nothing in this review was run against a provider. Every step in §5.7 that touches Hetzner or Cloudflare is an expectation until day 0 happens.
