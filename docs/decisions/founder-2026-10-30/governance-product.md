# Founder decisions 2026-10-30 — governance, product and process

These decisions settle questions that the design corpus could settle by analysis. Where the
docs disagreed, the conservative option was chosen: the one that is safer, more honest, and
easier to undo later. Anything that needs a real-world act (an account, a key, a lawyer, a
contract, money, a named person) is in "Still owner action" below. It has not been done.

Each row names the documents it was decided from. "Implemented in" lists the files this
commit series changed. Two items need an edit to `TASKS.md`, which this series does not touch.
They are marked **coordinator** and listed at the end.

| ID | Question | Decision | Rationale (cite §) | Implemented in | Revisit when |
|---|---|---|---|---|---|
| GP-1 | B9: on-box scripts in first-boot `user_data`, or delivered at deploy time? | **Deploy time.** `cloud-init.yaml` keeps only what the first deploy needs (users, SSH, firewall with `fw-cloudflare-ips`, Docker, unattended upgrades, deploy user). `fw-backup`, `fw-restore-drill`, `fw-diskguard`, `fw-notify-failure`, `fw-provision` and their units move to `infra/host/` with a sha256 manifest verified by `deploy.sh`. The drift rule names both places. | 21 E1 option 1 and §5.1. A script fix should ship with a deploy, not a rebuilt VM. The size problem is already solved (22,184 / 32,768 bytes, TASKS B9), so this is about change cost, not size. OPERATIONS §9.2 drift rule. | OPERATIONS §9.2. The file move is a follow-up code task (B9) | When the first VM is provisioned and the move is done |
| GP-2 | Integration series and branch protection on `main` | Uncommitted work lands as a series in dependency order, green at every step. Protect `main`: the five `ci.yml` checks required (strict), no force push, no deletion, linear history. **No required PR reviews.** Admin enforcement off, so the owner can still push directly. | 22 E1, §6 Q1. 21 E5. 22 E9 rejects PR ceremony for a solo founder. | `docs/ENGINEERING-PRACTICE.md` §2–§3, with the exact `gh api` command | When a second committer joins (then consider required reviews) |
| GP-3 | Rule 8, "integrated means committed and green" | **Adopted**, with 22 E2's text plus one sentence: "green" means the GitHub CI run on the pushed commit, not a local run. | 22 E2. The added sentence comes from the incident: GitHub CI on `main` was red from 2026-10-02 to 2026-10-24 (Supply chain, `pnpm audit`) while the log said "all gates green" from local runs. | `docs/ENGINEERING-PRACTICE.md` §1. **Coordinator:** add the text to TASKS §0 | Never, unless rule 4 changes |
| GP-4 | Where the code-review standard lives | In a committed file, `docs/ENGINEERING-PRACTICE.md` §4, not in `docs/ai/`. Three tiers: config as data (human reads diff and rationale), engine code under the harness (adversarial agent: failing fixture or "could not"), not covered (human reads it). | 22 E3, §6 Q2. `docs/ai/` is local-only and absent from a fresh checkout, so a rule there binds no one. | `docs/ENGINEERING-PRACTICE.md` §4 | When the harness covers a new class of change |
| GP-5 | CP1 protocol, its home, and the 31 Oct grade | Protocol written **late and labelled late** in `docs/reports/cp1-protocol.md`. Primary read: the 2024–25 backfill replay. shadow-PLB has no evidence artifact (no host, no live `available_at`), so **CP1 is missed** and the business pauses from 2026-10-31: engineering continues, no marketing, no spend beyond infrastructure. | GATES §4 CP1: "a criterion without its evidence artifact counts as missed", minimum-n rule, consequence clause. 20 Q2. TASKS D8: `available_at` is the poll time, so a replay cannot measure it. Writing the protocol after the fact and calling it on-time would be dishonest. | `docs/reports/README.md`, `docs/reports/cp1-protocol.md`, GATES §4 | A recorded live shadow run meets both criteria; recorded as a new report |
| GP-6 | Pause the D-track until the host records? | **Yes.** No new D-track item is dispatched until a provisioned host is recording live detections. Finishing work already in flight is allowed. Host provisioning and recording come first. | 21 Q6 and §5.7 (the minimum path to recording). 23 §5.5: every unrecorded day is data that cannot be fetched later (`available_at`, NRT rows). CP1 (GP-5) failed for exactly this reason. | This record. **Coordinator:** note in TASKS D-track header | The host has recorded for 14 days without a gap |
| GP-7 | Stopping rule for the review corpus | **Adopted:** after round 4 the corpus grows only on a founder request that names the decision no one owns. | 20 Q1, §7. Reviews have been produced faster than their decisions were made. | This record | A decision has no owner and no review covers it |
| GP-8 | Archive licence and deposit | Adopt 23 E9's split. The C6 second copy is a **backup**, not a publication. The raw FIRMS archive is **not republished**. The derived events dataset (event ids, lineage, dataset record) is published under **CC BY 4.0**, deposited yearly with a DOI, after the first recorded season. Publication waits on the input-licence memo. | 23 E9, §6 Q5. 18 §6 Q2: publication is not backup. CC BY 4.0 matches the attribution model we already enforce (CI-13). The raw input is not ours to relicense. | This record | The licence memo arrives, or the first season closes |
| GP-9 | Turkish alert locale | **Deferred to CP2**, as already planned. It ships only if reach data shows demand **and** a native reviewer for safety translations is in place. | 19 §6 Q2. The binding limit is the reviewer: a mistranslated safety line is worse than none. | This record | CP2 (30 April 2027) |
| GP-10 | Crowdsourced reports in the 2027 season | **None in 2027.** Curation ships first. Reports wait until a second person can moderate. The moderator role becomes "second reader and cover". | 16 §5.9. 18 §6 Q3, §5.6.4. A solo founder cannot moderate user reports in fire season. | This record | A second person is in place |
| GP-11 | WCAG 2.1 AA or 2.2 AA (L16) | **WCAG 2.2 AA**, scoped as in review 19 Appendix A. | 19 §6 Q1. GATES L-16 already says 2.2 AA, and so does the draft statement. 2.2 AA includes all of 2.1 AA, so it also meets EN 301 549 v3.2.1 (09 §4.3). | `docs/accessibility/README.md`, GATES L-16. Statement copy needs no change | A new WCAG version becomes the EN 301 549 basis |
| GP-12 | Eurostars-3 S11 | **Lapsed. Recorded as skip.** The 10 Sep 2026 deadline passed with no foreign SME partner and no application. | 10 §10 Q7. 13 §3.1(8). IMPLEMENTATION-PLAN default is skip unless a partner already exists. | IMPLEMENTATION-PLAN funding table | The next Eurostars call, if a partner exists by then |
| GP-13 | V2-Q3: the free/paid line | As proposed. **Free forever:** all life-safety alerts, the map, basic zones, credits, methodology. **Paid:** more zones and groups, longer history, bulk exports, API above a free quota, org features. Prices provisional. Nothing paid is built before CP3. | V2-FEATURES §6. GATES CP3 rider. A safety feature that later moves behind a paywall breaks trust and could cost lives. | V2-FEATURES §6 | CP3, with willingness-to-pay data |
| GP-14 | V2-Q5: first expansion country | **Not chosen now.** Decided after CP2 and after V2-Q4 terms are known. Greece is the working candidate. A country ships only with a native safety-translation reviewer and its own official-source list. | V2-FEATURES §3.H, §6. Same reviewer rule as GP-9. V2-Q4 redistribution terms gate any second country. | V2-FEATURES §6 | CP2 |
| GP-15 | V3-Q2: templated briefs or LLM rewrite | **Templated only.** | V3-FEATURES §6. GLOSSARY §3–§5 and the never-send lint can check catalog strings, but not generated text before it is sent. An LLM rewrite would need its own review path (L15). | V3-FEATURES §6 | Never in v3 |
| GP-16 | V3-Q4: CAP-XML output | **Not offered.** Webhook, Slack and Teams templates are allowed. | CAP is an issuing authority's format. A CAP feed from us would contradict "not an official warning" (GLOSSARY, product rules). | V3-FEATURES §6 | An authority asks to consume our data in CAP under its own name |
| GP-17 | V3-Q7: embed and API pricing | Model decided, prices provisional. Embed free for media, public bodies and non-profits, with attribution and the "not an official warning" line locked. Licensed for commercial sites. API: free quota, paid above it. Bulk screening paid. Nothing charged before CP3. | V3-FEATURES §6, V2-Q3 (GP-13). Reach through media embeds is a safety benefit. | V3-FEATURES §6 | CP3 |
| GP-18 | I3: Telegram bot identity | Proposal: user bot handle `@<Product>AlertsBot` (for example `FireWatchBGAlertsBot`, availability not checked), display name "Fire Watch — сигнали". The operator bot is a **separate** bot with a non-public name. | OPERATIONS §3 rule 3 and §8.1: the user bot and the operator bot are separate. The final name depends on name clearance (EXTERNAL-ACCOUNTS row 21). | This record | The product name is cleared |
| GP-19 | I1: mail sender and domain | On the project domain: `sign-in@auth.<domain>` for sign-in and channel confirmation (`FIRE_WATCH_AUTH_MAIL_FROM`, `FIRE_WATCH_AUTH_MAIL_DOMAIN`), `alerts@alerts.<domain>` for alerts, each subdomain with its own DKIM and send-only key. `support@<domain>` inbound (also the accessibility reporting address). `dmarc-reports@<domain>` as rua. DMARC `p=reject` on every domain. | Review 05 (dedicated alerts subdomain, own DKIM, send-only key, DMARC p=reject). `server/src/app/config.ts` requires the sender to sit on the auth subdomain. 19 §5.10.1 and 18 §5.3 need a support inbox. | `docs/accessibility/README.md` item 3. This record | The domain is bought |
| GP-20 | J1: operator channel | Primary: the operator bot to the private `fw-alerts` chat. Second: email to the operator mailbox from the alerts subdomain. Canary and meta-alert rows use a dedicated operator outbox, never `alert_outbox`. | OPERATIONS §3 rules 1 and 3, §3.1. `alert_outbox` holds user channels only, with NOT NULL zone and event keys (TASKS J1). | OPERATIONS §3 rule 3 | The seasonal voice escalation is set up |
| GP-21 | L15: may a T2 source stand alone? | **No.** The stricter 16 §5.3 reading: two sources. The code already refuses it (`second_source_required`). | 16 §5.2 vs §5.3. A de-escalation makes people stop watching, so it gets the second source. The safer reading is what the code already does. | EDITORIAL-STANDARD §2, §9 | After a season of curation, with refusal counts |
| GP-22 | L15: `life_safety_relay` | Never carries a curated state. Never pushed. The form keeps refusing it until the lawyer answers 12 Q2. After that it may open only as a shown, quoted, linked item. | 16 §6 Q2. 12 Q2 (legal position on relaying official instructions). Product rule "not an official warning". | EDITORIAL-STANDARD §3, §9 | The 12 Q2 legal answer |
| GP-23 | L15: does a curated state change ever push? | **Never in v1.** Curated statements are shown on the map and event page only. | 16 §5.5.3, §6 Q2. | EDITORIAL-STANDARD §7, §9 | v2, with a season of curation history |
| GP-24 | L15: capture storage and retention | Object key in a **private** R2 prefix that is never served. A third-party archive URL is not a capture. Kept as long as the published statement (forever). Captures for drafts that never published are deleted after 90 days. | EDITORIAL-STANDARD §5–§6 (published versions are frozen, so their evidence must last as long). A capture we do not host can vanish. 90 days keeps unpublished evidence only as long as a review could need it, and then limits what we hold. | EDITORIAL-STANDARD §5, §9 | The lawyer session (copyright of stored captures) |
| GP-25 | L15: quotation length | **At most two sentences, always linked.** No full bulletins, no images of the source. Holds until the lawyer answers. | 16 §6 Q5. 09 §10. The short-quotation default is the safe one. | EDITORIAL-STANDARD §5, §9 | The lawyer session |
| GP-26 | `COVERED_AREA` | **Confirmed:** Bulgaria + 100 km. Not widened. | TASKS pending list (WORKLOG 2026-08-26; reviews 07, 08; ADR-005). It is a published promise. `web/src/core/geo/coverage.ts`. | This record (no code change) | A product reason to widen it, with sources checked for the new area |

Wording and labels (Bulgarian copy, catalog strings) for any of these rows belong to the copy
domain and are not decided here.

## Coordinator edits to `TASKS.md`

This series does not edit `TASKS.md` or `V3-WORKPLAN.md`. The coordinator should:

1. Add rule 8 to §0, verbatim from `docs/ENGINEERING-PRACTICE.md` §1 (GP-3).
2. Mark the D-track paused until the host records (GP-6).
3. Move the items in the "Pending founder decisions" list that this record settles to
   decided, pointing here: CP1 protocol, stopping rule, `COVERED_AREA`, WCAG, crowdsourced
   reports, archive licence, Turkish locale, Eurostars.
4. Under B9, add the follow-up: move the operational scripts to `infra/host/` with a sha256
   manifest (GP-1).

## Still owner action

1. **Branch protection:** run the `gh api` command in `docs/ENGINEERING-PRACTICE.md` §3, after
   `main` is green on GitHub CI.
2. **Name the news-log curator and the second reviewer** (GATES §4 CP1, L-15).
3. **CP1 report:** run the backfill replay and commit `docs/reports/cp1-2026-10-31.md` on
   2026-10-31, recording "missed" (GP-5).
4. **Provision the host** and start recording (GP-6, B9): hosting account, VM, keys.
5. **Domain:** clear the name and buy the domain (EXTERNAL-ACCOUNTS row 21). Then set up DNS,
   SES, DKIM and DMARC for the I1 address scheme (GP-19).
6. **Telegram:** check that the handle is free and create both bots with @BotFather. Store
   the tokens in the secret store only (GP-18, GP-20).
7. **Input-licence memo** from a lawyer on FIRMS and EFFIS terms, then a Zenodo (or similar)
   account for the yearly DOI deposit (GP-8).
8. **Lawyer session:** the 12 Q2 relay question (GP-22), quotation licence (GP-25), capture
   storage copyright (GP-24), and sign-off on the accessibility statement's legal position.
9. **Native safety-translation reviewers** for any new locale or country (GP-9, GP-14).
10. **Prices** for the paid tiers and the embed licence, before CP3 (GP-13, GP-17).
