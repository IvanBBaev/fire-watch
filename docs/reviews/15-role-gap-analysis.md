# Review 15 — Which senior seats were never filled

*Reviewer role: review-corpus owner. Date: 2026-08-25. Status: complete.*
*Inputs reviewed: `reviews/01`–`14`, `docs/ANALYSIS.md`, `docs/GATES.md`, `docs/RISKS.md`,
`docs/OPERATIONS.md`, `docs/IMPLEMENTATION-PLAN.md`, `docs/DATA-SOURCES-EXTENDED.md`.
The project is in implementation (WP0–WP1).*

---

## 1. Summary verdict

**Four senior seats were never filled, and one of them was opened by a document written
after the corpus closed.** The twelve role reviews of July 2026 covered the engineering,
product, legal and domain surface thoroughly enough that most "obvious" additions —
a DPO, a DBRE, an MLOps engineer — would be re-reading work already done. That is the
finding, not a formality: **this gap analysis rejects more roles than it opens**, and the
rejections are listed with the section that already owns the ground, so the next person
who proposes them can see why.

What the corpus does not have is a seat for any of the following:

1. **Editorial.** The product's own one-line definition is "fused from every usable free
   satellite source **plus curated official information**" ([README.md:4-5](../../README.md#L4-L5)).
   The satellite half has four reviews (03, 11, 12, plus the data-source survey). The
   curated half has an admin form in WP6, a wording ladder in GLOSSARY §3, and an open
   question that two reviews escalated and nobody answered. Nobody has written the rule
   for what may be published in Fire Watch's own voice, from which sources, or how it is
   corrected when it is wrong.
2. **Hardware / RF & field engineering.** Review 04 asked the question literally —
   "EUMETCast (satellite dish + DVB hardware — *a physical ops dependency at someone's
   house?*)" ([04-sre.md:568](04-sre.md#L568)) — and left it open. Ten months later
   `DATA-SOURCES-EXTENDED.md` §I1, §I2 and Part L propose three separate classes of
   physical equipment. The question is now load-bearing and still unanswered by anyone
   qualified to answer it.
3. **Support, community & operator continuity.** "Solo curation capacity in season" and
   "moderation capacity as a launch precondition" are both in the escalated-questions list
   of [`00-summary.md`](00-summary.md) §Open questions. R2 in [`RISKS.md`](../RISKS.md) —
   key-person + seasonality — is rated High × High and its mitigations are all *engineering*
   mitigations. No seat owns the human side: who answers the inbox, who is the second
   person, and what happens to a "permalinks are forever" archive if the one person stops.
4. **Accessibility & language inclusion.** Three reviews each hold a piece (06 §5.4 the
   CVD lint, 07 §5.8 the design commitments, 09 §4.3 the legal exemption) and none holds
   the whole. Consequence: the WP4 definition of done reduces accessibility to three
   testable criteria, the legal position cites the wrong WCAG version, and no one has
   asked how a map-first product works for a screen-reader user or for the ~8 % of the
   country whose first language is not the one the product ships in — concentrated,
   as it happens, in the south-eastern fire region.

**The meta-finding.** Three of these four are not new information. They are questions the
corpus *raised* and then routed to nobody. A review round produces an owner for each of
its findings or it produces a list; the July rounds produced owners for everything that
mapped onto an existing seat and a list for everything that did not. **A finding with no
seat behind it is a finding that will be rediscovered at cost.**

## 2. Method — what counts as a gap

A role is **covered** when some review owns its *decisions*, not when the corpus contains
its *vocabulary*. Two tests, both of which must fail before a seat is declared missing:

| Test | Question |
|---|---|
| **T-A — decision ownership** | Is there a section that makes this role's calls and can be cited when the call is questioned? |
| **T-B — artifact ownership** | Does some plan, gate or DoD name a deliverable this role would produce, with an owner? |

A role that fails T-A but passes T-B is the most dangerous shape: the artifact is promised
and nobody has reasoned about its content. WP7's DPIA passes both (05 §5.3.4 reasons about
it). WP6's "minimal curation tooling" passes T-B and fails T-A — the form exists in the
plan, the editorial standard it enforces does not exist anywhere.

Scope limit, stated up front: this review identifies seats and their first-order findings.
It does **not** re-open decisions the existing twelve reviews made. Where a new seat
disagrees with an old one — 19 does, with 09 §4.3 — the disagreement is argued in that
review and escalated, never silently applied.

## 3. The twelve filled seats and what each owns

| # | Role | Owns (decision surface) |
|---|---|---|
| 01 | Architect | Ports & adapters, module boundaries, deployment shape, the "no serverless" call |
| 02 | Backend | Schema, clustering execution model, API surface, outbox, idempotence |
| 03 | Geodata | Projections, PostGIS schema, partitioning and the NRT→SP swap, ε from pixel geometry, EFFIS/WMS layer names |
| 04 | SRE / operations | Freshness budgets, monitoring legs, backup tiers, the 3 AM path, host contract |
| 05 | Security | Threat model, alert-pipeline integrity, GDPR & privacy engineering, authn/authz, abuse, supply chain |
| 06 | QA | Test strategy, golden fixtures, CVD/style lints, release regime, correctness metrics |
| 07 | Product / UX | Screen inventory, the honest clock, information hierarchy, alert UX, trust surfaces, onboarding |
| 08 | Frontend | Framework and core boundary, reconciler, MapLibre integration, PWA, bundle budgets, i18n mechanics |
| 09 | Legal & licensing | Source licences, attribution block, entity/ToS/VAT staging, liability posture, НК чл. 326 boundary |
| 10 | Business / GTM | Market sizing, B2B segments, partnerships, pricing, checkpoints CP1–CP3, risk register R1–R10 |
| 11 | Data science | Confidence score, parameter fitting protocol, survival model for "no longer detected", FP classes, calibration |
| 12 | Fire domain | Bulgarian fire regime, the actor map, the honest use-case statement, wording tiers, harm scenarios |

Reviews 13 (second-round audit) and 14 (corner cases) are **audits of the corpus**, not
seats: they check the distilled layer against its sources and enumerate scenarios. They
are counted here so the numbering is not mistaken for fourteen roles.

## 4. The four missing seats, ranked by what each changes

Ranked by the same criterion the July rounds used — **what would be decided differently,
and how expensive is the rediscovery** — not by how interesting the role is.

| Rank | Seat | Review | What it changes that no filled seat would catch | Cost of rediscovery |
|---|---|---|---|---|
| 1 | Hardware, RF & field engineering | [17](17-hardware-rf.md) | Whether Fire Watch ever owns physical equipment, and under what rule. Three proposals in `DATA-SOURCES-EXTENDED.md` (§I1 EUMETCast dish, §I2 X-band station, Part L towers/nodes) are currently un-adjudicated, and each one silently rewrites the ops model, the host contract, the insurance position and R2. | Highest — the failure mode is *buying* first. Money and a physical dependency are both hard to unwind. |
| 2 | Editorial & curation standards | [16](16-editorial.md) | The rule for publishing in our own voice; the official-source ladder; the correction and retraction path; what the product shows when curation lags. Directly gates the `officially_contained` / `officially_extinguished` states that GLOSSARY §3 already ships copy for. | High — the discovery event is a wrong curated statement during a real fire, which is R4, the kill scenario. |
| 3 | Support, community & operator continuity | [18](18-support-continuity.md) | Who answers, on what SLA, with which second person; the moderator pipeline that gates crowdsourced reports; the archive's survival independent of one operator, which invariant 5 promises. | High but slower — the discovery event is the August the operator is unavailable. |
| 4 | Accessibility & language inclusion | [19](19-accessibility-inclusion.md) | The screen-reader and keyboard architecture of a map-first product; the EAA position (09 §4.3's exemption reasoning needs re-checking against the current entity plan and against WCAG 2.2); minority-language reach in the highest-risk region. | Medium — retrofit cost, plus a legal position that is cheap now and expensive at the first B2B contract. |

Each of the four reviews is written to the corpus's house format: verdict, strengths,
severity-ranked risks with R-n identifiers, recommendations mapped to those risks, a deep
dive, and open questions. Their risk numbering is local to each review, as in 01–12.

## 5. Roles considered and rejected — with the section that already owns the ground

Rejected means **do not commission**; it does not mean the topic is finished. Where a
narrow delta survives the rejection, it is named and routed to an existing seat.

| Candidate role | Rejected because | Surviving delta, and where it goes |
|---|---|---|
| **Privacy / DPO** | [05 §5.3](05-security.md) is a complete privacy-engineering review: what we hold and why it is sensitive, minimization by circle-and-radius, app-layer encryption over a coarse index, a full data-inventory table with lawful basis and retention per row, the 6(1)(b)-not-consent call for alerts, the DPIA warrant against WP248, the processor/transfer table, third-party viewport leakage, and the rights and breach pipeline. WP7's DoD names every artifact with an owner. Passes T-A and T-B. | The **client-side geolocation** the web client gained in August 2026 post-dates the review. Its rule — coordinates never leave the device, stored camera precision capped at ~4 decimal degrees — is currently a code convention with no document. Route to 05's owner as a §5.3 addendum, not a new review. |
| **Database reliability engineering** | [03 §5.4–§5.7](03-geodata.md) owns the schema, monthly range partitioning, the partition key/PK constraint, the NRT→SP partition swap, GiST indexing and the volume analysis; [04 §5.5–§5.6](04-sre.md) owns backup tiers, RPO/PITR and the quarterly restore drill, and [`OPERATIONS.md`](../OPERATIONS.md) §6 makes both operational. 02 §5.4 adds the pooling and connection story. | Autovacuum tuning on an append-only partitioned table is genuinely unwritten — but it is a paragraph in `OPERATIONS.md` §6, not a seat. |
| **ML / MLOps** | [11 §10](11-data-science.md) kills ML-maximalism explicitly with a data-volume argument: at ~2–5k events, logistic regression plus Platt scaling is the honest ceiling. There is no model to operate. | None. Revisit only if the event corpus passes an order of magnitude. |
| **Frontend performance** | [08 §5.5](08-frontend.md) sets the budgets and CI-12 enforces them per PR. | None. |
| **Meteorology / fire weather** | [12 §5](12-fire-domain.md) translates FWI classes to Bulgarian ground truth, owns wind/slope/ROS and states the ~8 km resolution honesty caveat; [03 §5.x](03-geodata.md) owns the live EFFIS layer names (`mf010.fwi` and components, resolved from capabilities, never hardcoded); 11 uses FWI as feature `x_fwi` with a stated posterior question; `DATA-SOURCES.md` §D3/§D6 fixes ECMWF Open Data as the weather source of record and fences Open-Meteo. Four seats, no hole. | None at MVP. A met seat becomes real only if we ever *compute* FWI rather than consume it. |
| **IP / licensing** | [09](09-legal-licensing.md) in full, extended three times by `DATA-SOURCES-EXTENDED.md` Part N. | None. |
| **API design** | [02](02-backend.md) §5.2–§5.3 with ADR-003. | None. |
| **Threat modelling / appsec** | [05 §5.1](05-security.md), §5.2, §5.5, §5.6. | None. |
| **Test strategy** | [06](06-qa.md) plus the CI-1…CI-15 register in [`GATES.md`](../GATES.md) §1. | None. |
| **Finance / accounting** | [10 §2, §9](10-business-gtm.md) owns cost base, VAT threshold and the Paddle-as-MoR call; 09 owns entity staging. | Bookkeeping mechanics for an ЕООД are a service to buy, not a seat to fill. |
| **Emergency-management liaison** | [12 §2](12-fire-domain.md) maps every actor and §10 sets the credibility strategy; [10 §4](10-business-gtm.md) sequences the outreach. | None. |

## 6. What this analysis changes in the shared documents

Four items, each small and each traceable to one of the new reviews:

1. **`RISKS.md` §2** gains three watchlist rows: hardware-commitment creep (17 R-1),
   curated-statement error (16 R-1), and single-operator archive survival (18 R-2).
2. **`GATES.md` §3** gains **L-15** (editorial standard published and the correction path
   rehearsed before the first curated statement ships) and **L-16** (the accessibility
   criteria in WP4's DoD extended to a named conformance target with a stated legal
   position). Both are launch-gate shaped; neither is a CI gate, because neither is
   mechanically checkable.
3. **`README.md`** documentation map: "Twelve role reviews (01–12)" becomes accurate for
   sixteen reviews across three rounds plus two audits.
4. **`00-summary.md`** gains a round-3 synthesis, so the corpus keeps one entry point.

Nothing in the existing twelve reviews is edited. Where round 3 disagrees with round 2 —
19 vs 09 §4.3 on the accessibility exemption — the disagreement is recorded as an
escalated open question with a named decider, which is how rounds 1 and 2 handled the
same situation.

## 7. Open questions this analysis itself raises

1. **Is four the right number, or is it the number that fit?** The honest answer is that
   four seats survived a test designed to reject; a fifth (data stewardship / long-term
   preservation) was folded into 18 §5.5 rather than given its own review, because its
   findings all bottom out in operator continuity. If the archive ever acquires
   obligations of its own — a funder's open-data condition, an institutional mirror —
   it deserves separating out.
2. **Who decides the round-3 disagreements?** Rounds 1 and 2 escalated to "the product
   owner", which is the same person as everyone else on this project. That worked while
   the disagreements were technical. 19's EAA question is a legal position, and 09's
   author is the seat that would have to change its mind.
3. **When does the corpus stop?** A pre-code corpus of ten thousand lines was defensible
   because it was cheap relative to building the wrong thing. The project is now in
   implementation. The rule this analysis proposes: **after round 3, a new review is
   commissioned only when a document written after the corpus closed creates a decision
   nobody owns** — which is exactly how seat 17 was created, and is the only one of the
   four that could not have been found in July.
