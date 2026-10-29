# Review 32 — Legal, licensing & business (as built)

*Reviewer role: senior counsel (licensing & data protection) combined with a business /
go-to-market strategist, round 5. Date: 2026-10-30. Status: complete.*
*Inputs reviewed: `README.md`; `docs/legal/` (README, launch-checklist, dpa-inventory, lia,
ropa, DPIA, privacy draft); `docs/licenses/` (README + 16 per-source files);
`packages/contracts/src/credits.ts`; `docs/EXTERNAL-ACCOUNTS.md`; `docs/RISKS.md`;
`docs/GATES.md` (L-10, CP1–CP3); `docs/V2-FEATURES.md`; `docs/V3-FEATURES.md`;
`docs/V3-WORKPLAN.md`; `docs/EDITORIAL-STANDARD.md`; `server/src/core/erasure/erasure-plan.ts`;
migrations 001–060 by name; `server/src/adapters/**` directory listing; reviews 09, 10, 16, 18
and 21; `WORKLOG.md` (ISKRA review 2026-09-28, Eurostars notes); `git log`; `gh repo view`
(read-only). Nothing was built or run. This is not legal advice: every item marked
**[BG lawyer]** needs a Bulgarian advocate's opinion before it is relied on.*

---

## 1. Summary verdict

**CONDITIONAL GO for a May 2027 public launch — but the legal track is one missed month
from NO-GO.** The engineering for privacy and attribution is better than most funded
start-ups ship. The legal and business *actions* that only the founder can take have not
started: there is no entity, no lawyer, no name clearance, no recorded CP1 result, and no
recorded funding decision. Each of these has a lead time measured in weeks or months, and
the calendar from today to May 2027 is about 26 weeks.

1. **CP1 falls due tomorrow (31 Oct 2026) with no protocol and no report.** `docs/reports/`
   does not exist. By the rule in GATES §CP1, a missing report "pauses the business:
   engineering may continue, no marketing, no spend beyond infrastructure." Since review 10
   the plan has kept building V2/V3 features as if CP1 had passed.
2. **The legal critical path has not started.** L-10 needs, in order: ЕООД (2–4 weeks),
   DPAs signed in the entity's name, a lawyer engaged (availability takes weeks), ToS and
   privacy text marked up, and the DPIA signed. None of these has a date. Starting in
   January would leave no slack before a March beta.
3. **The legal artifacts describe a system that no longer exists.** The RoPA, DPIA and LIA
   cite migrations 001–012. As built, the schema runs to 036, plus the V3 block from 060.
   The artifacts omit webhooks (035), which push alert content containing personal data to
   third-party endpoints. They omit the whole staff plane (026–031: identities, TOTP,
   WebAuthn, audit log, incident log) and the digest log (018). One citation is wrong:
   `036_account_preferences.sql` should be `034`.
4. **The repository is public with no licence** (`gh`: `licenseInfo: null`; no LICENSE
   file; every `package.json` is `"private": true` with no `license` field). Legally, this
   is "all rights reserved" with the full security design published. That is the worst of
   both options: no community can lawfully contribute or fork, and attackers can still read
   everything.
5. **Licence coverage has drifted behind the integrations.** Shipped or wired inputs with
   no licence file: MeteoAlarm, Protomaps, Noto glyphs, Copernicus DEM / Terrarium, FireSat
   (adapter and source id exist), and EDO (planned). CelesTrak's commercial status is "not
   addressed". Most terms were verified on 2026-07-22, which predates the PLD date and
   every V2/V3 redistribution idea.
6. **The business has drifted toward B2B ahead of the civic product.** Webhooks, the
   public-API groundwork, staff/municipal planes and V3 embed/OGC/MCP plans were built or
   planned before PWA sign-up, polygons and the season-1 launch surface. This reverses the
   staging in review 10 (C3: no paid tier without an LOI plus a funding application) and
   the R9 grant-time discipline, in hours if not in money.
7. **The competitive premise has changed.** ISKRA (iskra.watch, reviewed 2026-09-28) is a
   live Bulgarian wildfire map, and the founder judged its map "much better". R6
   (cheap-entrant preemption) has happened. Fire Watch can still differentiate on honesty,
   permalinks, alert discipline, GDPR posture and operations. It cannot differentiate on
   map richness or "first in Bulgaria".

**Conditions for GO (all dated):**
- **(a) CP1 settled by 14 Nov 2026.** Either a backfill-replay CP1 report under the
  minimum-n path, or a written founder re-baseline of CP1/CP2 recorded in GATES (E-1).
- **(b) Filings by 30 Nov 2026.** The ЕООД filing is submitted and a lawyer is engaged on
  a fixed-fee quote (E-2, E-3).
- **(c) Legal artifacts current by 15 Dec 2026.** RoPA, DPIA, LIA and the DPA inventory
  are brought up to the as-built schema before the lawyer brief goes out (E-4).
- **(d) Repo licence and licence-gap files decided by 31 Dec 2026** (E-5, E-6).
- **(e) Name clearance done and EUTM filed by 15 Dec 2026, or a written decision to
  launch unregistered** (E-7).

If (a)–(c) slip past 31 Jan 2027, the honest answer becomes **NO-GO for a May 2027 public
launch**. The fallback is a closed beta with no stored zones under a natural person, which
L-10 forbids.

## 2. Strengths (sound as built)

- **Scope-of-service is real, not boilerplate.** README states a normative
  non-life-safety scope, "never declares a fire out" and "112 first". The editorial
  standard (`EDITORIAL-STANDARD.md` §4) bans any own-voice "fire is out / safe" claim and
  any own-voice instruction to act. Review 09 §3 called scope definition the strongest
  liability tool, and this is the evidence a court would read.
- **Attribution is engineered.** `credits.ts` is a typed registry (781 lines, more than 40
  ids, including LANCE disclaimers and the ECMWF five-part notice). Gate CI-13 checks that
  the right credits are present on every surface. Few projects can prove attribution
  mechanically.
- **The licence-before-code rule mostly held.** 16 per-source files exist, each with a
  verbatim quote and an identifier. Open-Meteo is correctly fenced to development under
  the commercial-in-trajectory doctrine. EOX 2018+ was dropped rather than risked.
- **Privacy by design is visible in code.** There are no trackers (M5 DONE). Erasure and
  export cover webhooks (commit 09edebd). The erasure plan is explicit about what it does
  not yet cover (`ERASURE_OUT_OF_SCOPE`, `ERASURE_OPEN_ITEMS`). Staff tables are named out
  of scope rather than silently missed.
- **Liability evidence beats drafting.** Dispatch evidence (LIA-2: 24 months at full
  fidelity, then pseudonymised up to 5 years, matching the ЗЗД чл. 110 limitation period),
  the decision log (014) and the curated-correction model mean that after an incident the
  service can show what it said, when, and why.
- **The cost model is structurally survivable.** €6–21/mo with a ≤ €25/mo ceiling (R3).
  No revenue scenario can force a shutdown; only founder time can.
- **Lead times are already catalogued.** EXTERNAL-ACCOUNTS rows 22–24 state the ЕООД,
  lawyer and EUTM lead times correctly. The gap is execution, not knowledge.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | CP1 is due 2026-10-31 with no protocol file and no report; by the gate's own text the business is paused, yet V2/V3 build continues without a recorded decision | `docs/GATES.md` CP1; `docs/reports/` absent (`ls`: No such file) |
| R-2 | **Critical** | No ЕООД and no lawyer. L-10 requires the ЕООД before the first stored zone, and DPAs must be signed in its name. Chain length ≈ 10–14 weeks; no start date is recorded | EXTERNAL-ACCOUNTS rows 22–23; launch-checklist V1/V2 rows OPEN; ROPA "Controller: FOUNDER DECISION, not yet incorporated" |
| R-3 | **High** | RoPA/DPIA/LIA are stale. Missing: webhooks (035, alert payloads to integrator endpoints; the controller/processor role is undetermined), staff plane (026–031), digest log (018). Wrong citation 036→034 | `docs/legal/ropa.md` §3.11; `docs/legal/README.md` "as of migrations 001–012"; `server/db/migrations/` |
| R-4 | **High** | The DPA inventory is missing NASA GIBS client-direct (V2-E2, viewer IPs go to NASA), Sentry and Grafana Cloud (EXTERNAL-ACCOUNTS marks both "DPA required"), and webhook recipients. OpenFreeMap is live client-direct with no privacy-page disclosure verified | `docs/legal/dpa-inventory.md` D1–D10 |
| R-5 | **High** | Public repo with no licence = all rights reserved. Security design (05) and the anti-abuse/sealer code are public; no contribution terms; the name and brand are unprotected | `gh repo view`: PUBLIC, `licenseInfo: null`; no `LICENSE` |
| R-6 | **High** | Inputs without a licence file: MeteoAlarm (credit text taken from an Atom `<rights>` element), Protomaps, Noto, Copernicus DEM / Terrarium ("not yet checked"), FireSat (adapter + `efa:firesat` in 060; EFA has published "no redistribution terms"; free tier is NC), EDO (V3-F1). CelesTrak: no licence published | `docs/licenses/` (16 files); `credits.ts`; `server/src/adapters/firesat/firesat-format.ts` |
| R-7 | **High** | Redistribution through an API is not cleared for EFFIS raw rasters, CEMS (API undocumented) or EUMETSAT beyond Core. Yet V2-G1 API and V3-D1 OGC / D3 MCP / D4 embed would redistribute derived data. V2-Q4 is unanswered | launch-checklist B4; V2-FEATURES §Q4; V3-WORKPLAN D1/D3 blocked |
| R-8 | **High** | B2B drift. Webhooks, staff/municipal, API and embed groundwork were built before v1 consumer essentials. Neither C3 (LOI + funding application before paid work) nor CP3 sequencing is respected in effort | V2-FEATURES §7; V3-WORKPLAN; review 10 §9.2 C1–C4 |
| R-9 | **High** | Funding track silent. Eurostars was due a skip/go decision by 1 Sep 2026 and no outcome is recorded; Galileo and Mapbox applications have no recorded status; CP2 needs ≥ 1 funding application by 30 Apr 2027 | WORKLOG (Eurostars "past-due"); EXTERNAL-ACCOUNTS rows 15–16 |
| R-10 | **Medium** | Name not cleared (M3 OPEN). EUTM takes ~4–6 months plus a 3-month opposition window, so filing after December means no registered mark in season 1. "Watch"-type marks may collide (to verify) | launch-checklist M3; EXTERNAL-ACCOUNTS row 24 |
| R-11 | **Medium** | PLD 2024/2853 applies to products placed on the market after 9 Dec 2026, so a May 2027 launch is in scope (software is a product; pure information is not). No PI insurance quote exists | launch-checklist B6; 09 §3 |
| R-12 | **Medium** | Competitive preemption (ISKRA). The "empty niche" thesis of review 10 §6 no longer holds; positioning and partner pitch must be rewritten | WORKLOG 2026-09-28; RISKS R6 |
| R-13 | **Medium** | The cost model has never met reality: no host, no deploy, no SES production quota, no metered free tier. €6–21/mo is a design number, not a bill | RISKS "No delivery path to a host"; EXTERNAL-ACCOUNTS row 20 |
| R-14 | **Medium** | Licence verifications are stale (2026-07-22 for most files), with no re-verification date in GATES | `docs/licenses/*` "verified" lines |
| R-15 | **Low** | Retention jobs are unarmed (webhook 30-day log, push endpoints not encrypted at rest), so the RoPA/privacy text would promise retention the code does not enforce | launch-checklist V-rows; V2-FEATURES §7 G2 |

## 4. Detailed recommendations

| E | Tag | Maps to | Recommendation | Owner | Effort | Lead time |
|---|---|---|---|---|---|---|
| E-1 | [MVP] | R-1, R-8 | Settle CP1 in writing by 14 Nov. Preferred: a backfill-replay CP1 report (2024–25 season, the minimum-n path GATES already allows) in `docs/reports/cp1-2026.md`. Alternative: a founder re-baseline that moves CP1 to a dated replay checkpoint and states which business activity is paused until then | founder + agent | 4 founder-h + 6 Opus-h | 2 weeks |
| E-2 | [MVP] | R-2 | File the ЕООД in November: name check, capital deposit, notary, bank account, registry. Then sign/accept DPAs (Hetzner, Cloudflare, AWS SES, Sentry, Grafana, Healthchecks) in its name | founder (+ accountant) | 12 founder-h; €300–900 | 2–4 weeks |
| E-3 | [MVP] | R-2, R-11 | Engage a Bulgarian advocate on a fixed-fee quote for ToS + privacy + DPIA review + the 09 §10 questions, with this review and 09 as the brief. Ask for a PI-insurance broker referral in the same call **[BG lawyer]** | founder | 4 founder-h + fee (to verify) | 4–8 weeks to markup |
| E-4 | [MVP] | R-3, R-4, R-15 | Delta the legal set to the as-built schema: RoPA entries for 018, 026–031, 035 and the V3 block; DPIA sections for webhooks (recipient role) and staff; LIA for staff audit retention; fix the 034 citation; DPA rows for GIBS, Sentry, Grafana and webhook recipients; privacy text naming the client-direct hosts (OFM, GIBS, Esri if enabled) | agent | 8 Opus-h | before the lawyer brief |
| E-5 | [MVP] | R-5 | Decide the repo licence. Options: (i) AGPL-3.0 + trademark policy (civic, forkable, blocks closed SaaS copies); (ii) source-available (BUSL/Elastic) to protect future B2B; (iii) make the repo private until launch. Recommended: (i) for code, all rights reserved on the name/logo, CC BY 4.0 for the archive (18 §5.5). Add `LICENSE`, `license` fields and a `CONTRIBUTING`/DCO note | founder decides, agent writes | 2 founder-h + 2 Opus-h | 1 week |
| E-6 | [MVP] | R-6, R-14 | Write the missing licence files: MeteoAlarm, Protomaps, Noto (OFL 1.1, to verify), Copernicus DEM, Terrarium/ETOPO1, FireSat (NC/evaluation-only, so not on any public surface), EDO (before V3-F1). Confirm CelesTrak's terms in writing or fence it to internal pass prediction. Add a "re-verify all terms" row to GATES at beta and at launch | agent (+ founder emails) | 6 Opus-h + 2 founder-h | 2–6 weeks for replies |
| E-7 | [v1] | R-10 | Name clearance (eSearch plus, TMview, BG registry, ЗМГО чл. 11 screen) by 30 Nov; file the EUTM (classes 9/42, optional 38) by 15 Dec so registration can land around May–Jun 2027 if unopposed (to verify) | founder (+ lawyer) | 6 founder-h; €900–1,050 | 4–6 months + 3 months opposition |
| E-8 | [v1] | R-7 | Write a redistribution matrix per source (raw / derived / display-only) and answer V2-Q4 from it. Until then, freeze V2-G1/V3-D1/D3/D4 external exposure; EFFIS rasters and CEMS stay display-only | agent + founder | 4 Opus-h + 2 founder-h | gate before any API key is issued |
| E-9 | [v1] | R-8, R-9 | B2B freeze until CP2. No new V2-G*/V3-D*/G* work until the v1 consumer path (PWA, sign-up, zones, push) is launch-complete. B2B effort is limited to replay demos for LOIs. Record the freeze in V3-WORKPLAN | founder | 1 founder-h | immediate |
| E-10 | [v1] | R-9 | Record the funding outcomes (Eurostars skip, Galileo/Mapbox submitted or not). Then prepare one whitelisted application for CP2: CASSINI Challenges 2027 or Accelerator B8 (windows to verify), ≤ 40 h under R9 | founder (+ agent draft) | 30 founder-h + 8 Opus-h | windows Q1 2027 (to verify) |
| E-11 | [v1] | R-12 | Reposition against ISKRA: one page on what Fire Watch is *not*, and the honesty, permalink and alert-discipline claims as the pitch to WWF and Meteo Balkans. Consider an ISKRA partnership (feed or link exchange) instead of a map race | founder | 6 founder-h | before partner outreach (Dec) |
| E-12 | [v1] | R-11, R-13 | Get a PI/professional liability quote that covers the PLD exposure. Run a 30-day production-cost sample once a host exists, and write the real number into RISKS R3 | founder | 4 founder-h | quote 2–4 weeks |

## 5. Legal, licensing & business deep dive

### 5.1 What changed since reviews 09, 10 and 18

- **09 (2026-07-22, CONDITIONAL GO).** The plan has largely been executed in documents:
  all six legal artifacts exist and the credits registry plus CI-13 are live. Execution
  outside the repo has not happened: none of the GATE-v1 rows that need an entity, a
  lawyer or a filing has moved. The schema has since grown by about 25 migrations without
  the artifacts following.
- **10 (2026-07-22).** Its 90-day checklist (§9.5) is mostly unrecorded:
  - item 3, the Eurostars decision: no outcome recorded;
  - item 4, Galileo/Mapbox: no status recorded;
  - item 5, the accountant consult: no record;
  - item 9, name clearance: OPEN;
  - item 10, the freemium-boundary statement: not found;
  - item 11, CP1: no report.

  Its central thesis ("civic asset, hybrid revenue, season 1 free") still stands. Its
  competitive map does not: see 5.5.
- **18 (2026-08-25).** The archive licence, custodian and inbound-support surface are
  unchanged. E-5's licence decision should also settle 18's archive licence, so that one
  founder decision closes both.

### 5.2 Legal launch readiness (L-10) and lead times

| Requirement (L-10 / launch-checklist) | State 2026-10-30 | Blocking dependency | Latest safe start for May 2027 |
|---|---|---|---|
| ЕООД as controller | not started | founder | **15 Nov 2026** |
| DPAs signed in the entity's name (D1–D10 + gaps) | 0 archived | ЕООД; host choice | Dec 2026 |
| Privacy policy published | draft page built (`privacy.tsx`) | lawyer markup; controller identity | Feb 2027 |
| ToS with ЗЗП-valid limits (no exclusion for death/injury: чл. 143/146) **[BG lawyer]** | OPEN | lawyer | Feb 2027 |
| DPIA signed | DRAFT, stale | E-4 delta; lawyer | Mar 2027 |
| RoPA current | stale (001–012) | E-4 | Dec 2026 |
| Withdrawal-right handling for any paid tier **[BG lawyer]** | OPEN | only if paid at launch (recommended: none) | n/a in season 1 |
| Breach rehearsal (КЗЛД, 72 h) | runbook DRAFT (`breach-runbook.md`), rehearsal OPEN (V21) | entity + runbook | Apr 2027 |
| Hardware-key 2FA on root accounts | not verified | accounts exist | with each account |
| Name clearance / EUTM | OPEN | founder | clearance 30 Nov, filing 15 Dec |

Season 1 should stay entirely free (review 10 C1). That removes withdrawal rights, VAT,
merchant-of-record setup and B2C payment terms from the launch path. Only the data
protection and liability items remain.

### 5.3 Licence compliance of every input actually integrated

| Input | Licence (as recorded) | Commercial / in-trajectory | Licence file | API/embed redistribution (V2-G1, V3-D*) | Action |
|---|---|---|---|---|---|
| NASA FIRMS / LANCE | CC0 1.0 + LANCE disclaimer | Yes | yes | Yes (derived) | re-verify at gate |
| NASA GIBS (client-direct) | NASA open data | Yes | yes | display only; IP disclosure | add DPA/privacy row |
| EFFIS | CC BY 4.0 (EU content) | Yes | yes | **raw danger rasters not cleared** | E-8 |
| ECMWF Open Data | CC BY 4.0 + ECMWF terms | Yes | yes | Yes, with five-part notice | — |
| EUMETSAT LSA SAF | CC BY 4.0 (Core, Art. 5.1/20) | Yes (Core only) | yes | Yes for Core; Recommended tier barred | keep Core-only |
| EUMETSAT MTG LI | CC BY 4.0 (Core) | Yes | yes | Yes | account not yet opened |
| Copernicus Sentinel | EU Reg. 377/2014 open | Yes | yes | Yes | — |
| Copernicus EMS | open, cite source | Yes (as read) | yes | API undocumented, to verify | E-8 |
| OSM / OpenFreeMap / Protomaps | ODbL 1.0 produced work; OFM MIT; Protomaps builds | Yes | OSM yes; **Protomaps no** | share-alike applies to derivative DBs only | E-6 |
| Noto glyphs | SIL OFL 1.1 (to verify) | Yes | **no** | n/a | E-6 |
| Copernicus DEM GLO-30 / Terrarium (ETOPO1) | Copernicus DEM licence / public domain (to verify) | to verify | **no** | display only | E-6 |
| GeoNames | CC BY 4.0 | Yes | yes | Yes | — |
| Natural Earth | public domain | Yes | yes | Yes | — |
| EEA Natura 2000 | CC BY 4.0 | Yes | yes | Yes | — |
| ESA WorldCover | CC BY 4.0 | Yes | yes | Yes | — |
| MeteoAlarm | "equivalent to CC BY 4.0" (Atom `<rights>`, 2026-10-24) | to verify; national-provider terms may differ | **no** | **unknown** | E-6; confirm per provider (НИМХ) |
| CelesTrak TLEs | **none published** | **not addressed** | yes (records gap) | internal only | E-6: written ask or fence |
| Open-Meteo | CC BY 4.0 data; NC free tier | **No** | yes | none | fenced to dev, correct |
| Esri World Imagery | ArcGIS terms; never proxied | Yes on the location platform (to verify) | **no** | never | founder decision, then file |
| FireSat / EFA | **none published**; free tier NC | **No** | **no** | **no** | never on a public surface until written terms |
| EDO (V3-F1) | to verify | to verify | **no** | to verify | licence gate before code (already in V3) |

The rule "no adapter without a licence file" was broken twice. FireSat has an adapter and
a reserved source id. MeteoAlarm has an adapter and a shipped credit. Both are fixtures
only today, so no harm has been done yet. The FireSat adapter is the dangerous one. EFA
publishes no redistribution terms, and its free tier is non-commercial, so under the
commercial-in-trajectory doctrine (09 §2.2.I) anything FireSat-derived must stay off the
public map, the API and the archive until written terms exist.

### 5.4 Implications of the public repository

- **Copyright.** Without a licence, nobody may lawfully copy, modify or redistribute the
  code. A public repo with no licence is therefore not "open source". It attracts no
  contributors and still gives competitors (ISKRA included) a full reading of the design.
- **Security.** `docs/reviews/05-security.md`, the threat model, rate-limit/abuse logic
  and the webhook secret sealer are public. That is acceptable only if no security
  relies on obscurity. Review 28 owns the verification. From the legal side, confirm that
  no secrets, fixtures with personal data, or real e-mail addresses are in history. The
  secret gate and gitleaks are in CI, but a one-off full-history scan is cheap
  reassurance.
- **Data protection.** The fixtures are synthetic, as far as sampled. Any real FIRMS or
  news-log fixture is public data. Any test fixture that resembles a real person's zone
  must not be derived from a real address.
- **Trademark.** Public code with the name all over it, plus no registered mark, means
  that someone else can file first. This is another reason for E-7.
- **Recommendation.** AGPL-3.0 for code, a short trademark policy, and CC BY 4.0 for
  published data and archives. This fits the civic thesis, keeps a closed SaaS clone
  obliged to publish its changes, and leaves B2B revenue (support, SLA, integration) to
  the ЕООД as the copyright holder, who can dual-license. **[BG lawyer]**: confirm that
  agent-written code is owned by the founder or the ЕООД (assignment on incorporation)
  and that AGPL is compatible with every dependency licence (a `pnpm licenses` sweep,
  agent task).

### 5.5 Business: the missed season, funding, solo founder, cost, ISKRA, B2B drift

- **The missed season.** CP1 was designed around live shadow data from Sep–Oct 2026. No
  host was ever provisioned (RISKS "No delivery path to a host"), so that season is gone
  and cannot be repeated. The gate already allows a backfill-replay primary read when
  there are fewer than 20 perimeters. Use it, but report it honestly as replay evidence
  rather than live evidence. CP2's beta-live precondition then becomes the first live
  test, in March–April 2027 (the spring burn season), which is thin but real.
- **Funding.** Zero applications in four months. CP2 needs ≥ 1 by 30 Apr 2027. CASSINI
  Challenges / Accelerator remain the best fit; windows are expected Q1 2027 (to verify).
  CASSINI accepts individuals, so the application does not wait for the ЕООД, though
  НИФ does. Keep each application to 40 hours or less.
- **Solo founder and agent-built code.** About 1,868 tracked files and 180 commits have
  been produced largely by agents. The continuity risk (18 §5.7) has grown. The legal
  corollary: only the founder can sign, file, appear and answer КЗЛД. A two-week founder
  absence in May–Aug 2027 would leave a controller unable to meet the 72-hour breach
  clock. Name a deputy contact in the privacy policy (lawyer or accountant) **[BG lawyer]**.
- **Cost model.** The design (€6–21/mo) is credible, but unverified because nothing is
  deployed. Add the legal line that review 10 §9.4 deferred: incorporation €300–900,
  accounting €600–1,200/yr, EUTM ~€900–1,050, lawyer fee (to verify), and PI insurance
  (to verify). Year-1 legal/admin cash therefore probably exceeds infrastructure by an
  order of magnitude. It is still small, but it is not €25/mo.
- **ISKRA.** It has more sources, its own reception, faster polling, firefighter tooling
  and a map the founder rated better. Fire Watch should not race on layers. Its defensible
  ground is the set of things ISKRA was not seen to offer: fail-closed alerts, honest
  freshness, permanent permalinks, a GDPR-grade account model, public retrospectives and
  editorial discipline. A cooperation pitch (Fire Watch alerts or permalinks linking to
  ISKRA's map, or the reverse) may beat competition (to verify their appetite).
- **B2B drift vs the civic thesis.** Building webhooks and staff planes is not wrong.
  Building them before the consumer launch surface is a sequencing error. It spends the
  scarce resource (founder review time) on customers who do not exist, and it creates
  legal surface (webhook recipients, staff personal data, API redistribution) that the
  lawyer must now review before launch. E-9 freezes new B2B work until CP2. Already-built
  features stay dark (unregistered routes) and out of the privacy text until they are
  switched on.

### 5.6 Dated legal & business critical path (Nov 2026 → May 2027)

| Date | Milestone | Owner | Depends on |
|---|---|---|---|
| 2026-11-07 | Funding outcomes recorded (Eurostars, Galileo, Mapbox); B2B freeze recorded | founder | — |
| 2026-11-14 | CP1 replay report or re-baseline in GATES | founder + agent | backfill corpus |
| 2026-11-15 | ЕООД documents prepared; accountant consult held | founder | name check |
| 2026-11-30 | ЕООД filed; lawyer engaged (fixed fee); name clearance done; repo licence decided | founder | — |
| 2026-12-09 | PLD 2024/2853 applies — PI quote requested | founder | lawyer referral |
| 2026-12-15 | Legal set delta merged (E-4); EUTM filed; licence-gap files written (E-6) | agent / founder | ЕООД name |
| 2026-12-31 | ЕООД registered; DPAs accepted in its name; lawyer brief sent | founder | host chosen |
| 2027-01-31 | Redistribution matrix (E-8); CASSINI application drafted (window to verify) | agent + founder | — |
| 2027-02-28 | Lawyer markup returned; ToS + privacy final; partner outreach (WWF / Meteo Balkans) with ISKRA-aware pitch | lawyer / founder | brief |
| 2027-03-15 | DPIA signed; retention jobs armed; SES production quota filed; terms re-verified (all sources) | founder + agent | markup |
| 2027-03-31 | Beta live (CP2 precondition); breach rehearsal held | founder | host, L-10 drafts |
| 2027-04-30 | **CP2**: partnership, ≥ 1 funding application, ≥ 500 alert-armed users | founder | all above |
| 2027-05 | **L-10 passed → public launch**; EUTM registration expected around May–Jun if unopposed (to verify) | founder | CP2 |

Slack on this path is about two weeks, all of it in November.

## 6. Open questions for the founder

1. **CP1: replay report or re-baseline?** Recommended: a replay report under the
   minimum-n path, labelled "replay, not live", plus a one-line GATES note that the live
   shadow season was missed.
2. **Repo licence?** Recommended: AGPL-3.0 for code, a trademark policy, CC BY 4.0 for the
   archive. Making the repo private is the fallback only if the B2B path becomes primary.
3. **ЕООД alone, or сдружение + ЕООД?** Recommended: ЕООД now, because it is on the
   critical path. Decide on the association at CP3 (review 10 Q2).
4. **Webhooks and staff plane at launch?** Recommended: keep both unregistered in season 1.
   Document them in the RoPA anyway, so switching them on is a config change rather than a
   legal review.
5. **FireSat and EDO?** Recommended: no public surface without written terms. Keep the
   FireSat adapter fixtures-only and email EFA for terms now.
6. **Positioning vs ISKRA: compete or cooperate?** Recommended: cooperate on map/data,
   compete on alerts and honesty. Make one contact before partner outreach.
7. **Is a paid tier possible in season 1?** Recommended: no. That keeps VAT, withdrawal
   rights and merchant-of-record out of the launch path (review 10 C1).
8. **PI insurance?** Recommended: get one quote before 9 Dec 2026 and decide on the
   number. Do not let it block the launch.
9. **EUTM, or launch unregistered?** Recommended: file by 15 Dec. If clearance finds a
   conflict, rename before any press, not after.

## Appendix A — Proposed rows for the shared documents

**(a) TASKS rows**

- [ ] **R5-BIZ-1 — Settle CP1: replay report or recorded re-baseline.** Spec: review 32 E-1. Writes: docs/reports/cp1-2026.md, docs/GATES.md. Done when: the report exists with PCR/PLB numbers and the "replay" label, or GATES records a dated re-baseline signed by the founder. Est: 10 h. Status: blocked-owner.
- [ ] **R5-BIZ-2 — Form the ЕООД and accept processor DPAs in its name.** Spec: review 32 E-2. Writes: docs/legal/dpa-inventory.md, docs/legal/ropa.md (controller row). Done when: the registry entry number is recorded and every `required` DPA row is marked accepted with a date. Est: 12 h. Status: blocked-owner.
- [ ] **R5-BIZ-3 — Engage a Bulgarian lawyer for ToS, privacy and DPIA review.** Spec: review 32 E-3. Writes: docs/legal/launch-checklist.md. Done when: an engagement on a fixed fee is recorded and the brief (09 + 32) has been sent. Est: 4 h. Status: blocked-owner.
- [ ] **R5-BIZ-4 — Bring the RoPA/DPIA/LIA/DPA inventory to the as-built schema.** Spec: review 32 E-4. Writes: docs/legal/ropa.md, docs/legal/dpia.md, docs/legal/lia.md, docs/legal/dpa-inventory.md, docs/legal/README.md. Done when: every migration that creates a table with personal data (018, 026–031, 034, 035, V3 block) is cited by its correct file name, and GIBS, Sentry, Grafana and webhook recipients each have a DPA row. Est: 8 h. Status: open.
- [ ] **R5-BIZ-5 — Decide and apply the repository licence.** Spec: review 32 E-5. Writes: LICENSE, package.json `license` fields, CONTRIBUTING.md. Done when: `gh repo view --json licenseInfo` returns non-null and every package declares the same licence. Est: 4 h. Status: blocked-owner.
- [ ] **R5-BIZ-6 — Write the missing licence files and fence the unlicensed inputs.** Spec: review 32 E-6. Writes: docs/licenses/{meteoalarm,protomaps,noto,copernicus-dem,terrarium,firesat,esri}.md. Done when: every adapter directory and every `credits.ts` source has a licence file, and FireSat/CelesTrak are marked fenced with a test or lint that blocks their public use. Est: 8 h. Status: open.
- [ ] **R5-BIZ-7 — Name clearance and EUTM filing.** Spec: review 32 E-7. Writes: docs/legal/launch-checklist.md (M3). Done when: the clearance record is filed and the EUTM application number is recorded, or a written decision to launch unregistered exists. Est: 6 h. Status: blocked-owner.
- [ ] **R5-BIZ-8 — Redistribution matrix and V2-Q4 answer.** Spec: review 32 E-8. Writes: docs/licenses/README.md, docs/V2-FEATURES.md (Q4). Done when: each source has a raw/derived/display-only verdict, and V2-G1/V3-D1/D3/D4 reference it as their gate. Est: 6 h. Status: open.
- [ ] **R5-BIZ-9 — Record the B2B freeze until CP2.** Spec: review 32 E-9. Writes: docs/V3-WORKPLAN.md, docs/V2-FEATURES.md. Done when: both files state the freeze and the date it lifts, and no new V2-G/V3-D/G item is marked in progress. Est: 1 h. Status: blocked-owner.
- [ ] **R5-BIZ-10 — Record funding outcomes and submit one CP2 application.** Spec: review 32 E-10. Writes: docs/EXTERNAL-ACCOUNTS.md, docs/reports/funding-2027.md. Done when: Eurostars, Galileo and Mapbox each have a recorded outcome, and one application has a submission receipt dated before 2027-04-30. Est: 38 h. Status: blocked-external.
- [ ] **R5-BIZ-11 — ISKRA-aware positioning page and partner pitch.** Spec: review 32 E-11. Writes: docs/POSITIONING.md. Done when: the page names three differentiators that are verifiable in the product, and the WWF/Meteo Balkans outreach uses it. Est: 6 h. Status: blocked-owner.
- [ ] **R5-BIZ-12 — PI insurance quote and a real 30-day cost sample.** Spec: review 32 E-12. Writes: docs/RISKS.md (R3, R11 note). Done when: a quote figure and a measured monthly infrastructure cost are recorded. Est: 4 h. Status: blocked-external.

**(b) RISKS §2 / GATES rows**

- RISKS §2: **Legal lead-time slip** | ЕООД, lawyer and EUTM not started; each month of delay removes a month of slack before L-10 | Trigger: no ЕООД filing by 2026-11-30 | Response: R5-BIZ-2/3/7; if 2027-01-31 passes without a lawyer markup, re-plan May 2027 as a closed beta.
- RISKS §2: **Unlicensed-input drift** | adapters and credits shipped ahead of licence files (MeteoAlarm, FireSat, Protomaps, DEM) | Trigger: any adapter directory without `docs/licenses/<id>.md` | Response: R5-BIZ-6, plus a CI check that maps adapter ids to licence files.
- RISKS §1 R6 update: **materialised** (ISKRA, 2026-09). Mitigation becomes "differentiate on alerts and honesty; offer cooperation".
- GATES L-10 addition: "Terms of every public-surface source re-verified within 60 days of launch; the RoPA cites every personal-data migration by its correct file name."
- GATES CP1 note: "Live shadow season 2026 missed; CP1 read from backfill replay per the minimum-n rule (or re-baselined), recorded 2026-11."

**(c) Synthesis paragraph for 00-summary**

> Review 32 (legal & business, as built) returns CONDITIONAL GO for May 2027, but the
> legal track is one missed month from NO-GO. The privacy and attribution engineering is
> strong, while the founder-only actions (ЕООД, lawyer, name clearance, CP1 report, funding
> outcomes) have not started, and each has a lead time of weeks to months. The legal set
> is stale against migrations 018–036. The repo is public with no licence, and six inputs
> lack licence files, FireSat among them. B2B features have been built ahead of the civic
> launch path, in a market where ISKRA has already taken the "first Bulgarian fire map"
> position. Everything is recoverable if November is spent on filings, not features.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| Repo is public, no licence | `gh repo view IvanBBaev/fire-watch --json visibility,licenseInfo` (read-only); `ls LICENSE*` (none); `grep '"license"' **/package.json` (none; all `"private": true`) |
| CP1 has no report | `ls docs/reports` → "No such file or directory"; grep for a CP1 protocol file found none |
| Legal artifacts are as of 001–012 | `docs/legal/README.md` header; `ropa.md` §3.11 cites `036_account_preferences.sql`, while `server/db/migrations/` has `034_account_preferences.sql` and `036_meta_alert_states.sql` |
| Webhooks/staff/digest absent from RoPA/DPIA | grep for `webhook`, `staff`, `digest` in `docs/legal/*.md` against migration names 018, 026–031, 035 |
| Licence-file coverage | `ls docs/licenses` (16 files) compared with `server/src/adapters/*` and the `credits.ts` ids |
| FireSat terms absent | `server/src/adapters/firesat/firesat-format.ts` header; EXTERNAL-ACCOUNTS row 1; migration 060 `efa:firesat` |
| Licence identifiers in §5.3 | each `docs/licenses/*.md` "Licence identifier" / "Commercial use" row, quoted; items not on file are marked "to verify" |
| Lead times and costs | EXTERNAL-ACCOUNTS rows 15–16, 20–24; review 10 §5.5/§9.4. EUIPO timing and fees are not re-checked online ("to verify") |
| ISKRA findings | WORKLOG 2026-09-28 entry; no external visit made |
| Funding status | WORKLOG grep for Eurostars / Galileo / Mapbox; no outcome lines found |
| Not verified | Current PLD transposition status in Bulgaria, CASSINI 2027 windows, Noto/DEM/Esri licence text, EUIPO processing times, lawyer fees: all marked "to verify" |
