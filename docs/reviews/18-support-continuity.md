# Review 18 — Support, community & operator continuity

*Reviewer role: senior support & community lead / continuity owner. Date: 2026-08-25. Status: complete.*
*Inputs reviewed: `docs/OPERATIONS.md` §3–§5, `docs/GATES.md` §3 and §4, `docs/RISKS.md`,
`docs/IMPLEMENTATION-PLAN.md` WP5–WP9, `README.md` invariants,
`reviews/10-business-gtm.md` §4/§8/§9, `reviews/04-sre.md`, `reviews/05-security.md` §5.4,
`reviews/07-product-ux.md` §5.7, `reviews/16-editorial.md`. Project is in implementation (WP0–WP1).*

---

## 1. Summary verdict

**CONDITIONAL GO — the project has an excellent plan for machines waking a human up, and
no plan at all for humans contacting one.**

Read `OPERATIONS.md` §3.1 carefully and it is a genuinely good solo-operator on-call
design: one Telegram chat with a loud sound, a DND exception, a season-mode voice
escalation at 10 minutes, acknowledgement as a deliberate act with a reason, and an honest
30-minute expectation. Every part of that is about **the system paging the operator**.

Now search the corpus for the opposite direction — a user, a journalist, a municipality, a
volunteer, a lawyer, or a parent in a village reaching *in*. There is a moderator mentioned
in a DoD line, "1–2 volunteer moderators (НАДРБ)" as a mitigation cell in R2, a
transparency page, and nothing else: **no inbox, no response undertaking, no triage rule,
no volume model, no standing replies, and no rule for what happens when the message says
"there is a fire above my village, what do I do".** The one message class that is
guaranteed to arrive is the one with no defined handling.

Five structural findings:

1. **Support volume is a function of the same event as traffic, and only traffic is
   planned for.** R1 prices the viral fire as an infrastructure problem and solves it
   correctly — own tiles, snapshot-first, CDN spike survival. But a CDN absorbs requests;
   it does not absorb email. The same day that sends 100–1000× traffic sends the
   proportional inbox, to one person who is also handling the incident, also curating
   (16), and possibly also asleep (§5.2, R-1).
2. **The archive is the only promise in the project with an unbounded horizon and no
   continuity mechanism.** Invariant 5 says permalinks are forever. CP3's sunset branch
   says data is "archived and published". Between those two sentences there is no
   custodian, no deposit, no mirror, no licence for the archive itself, and no funded
   domain. "Forever" currently means "for as long as one person keeps paying for a domain
   and a VM" (§5.5, R-2).
3. **The moderator plan is a headcount, not a pipeline.** "1–2 volunteer moderators from
   the НАДРБ cohort" appears as a mitigation in R2 and as "≥ 1 moderator" in a DoD. Nobody
   owns recruiting them, vetting them, training them, giving them tooling that does not
   also give them the ability to publish a wrong fire state, supervising them, or replacing
   them when they drift away — which volunteers do, especially after their first season
   (§5.6, R-3).
4. **There is no second person, and several gates quietly assume one.** L-11's literal
   3 AM wake-up test, 05 §5.4's separate admin plane, 16's two-person rule for any curated
   push, ADR-004's manual-broadcast control, and the entire October–November recovery block
   all presuppose that somebody else exists or that the one person is available. In August
   2027, with 50k users, the bus factor is 1 and the failure is not hypothetical — it is a
   holiday, a hospital, or a family emergency (§5.7, R-4).
5. **Burnout is treated as a personal risk when it is a system property.** 10 §8 already
   says this better than most: "the mitigation is not heroism but architecture". The
   architecture half is being delivered (fail-closed alerts, automatic degradation, the
   error-budget freeze). The *load* half — support, moderation, curation, community, press
   — has been added continuously since, by every review including this one, and nobody has
   ever summed it (§5.9, R-5).

The GO condition is small and unglamorous: one inbox with a published, honest, deliberately
weak undertaking; three standing replies including the life-safety one; a triage rule; and
a continuity file that lets someone else keep the archive alive. None of it is code. All of
it must exist before the first real user does.

## 2. Strengths (sound as proposed)

- **§3.1 is honest about being one person.** "There is no war room, no on-call rotation and
  no escalation policy beyond §3.1" and "the only two levers a solo operator actually has
  are automatic degradation and deferring work" is the most clear-eyed operational writing
  in the corpus. Support should be designed to the same standard rather than to an
  aspirational one.
- **Acknowledgement-with-a-reason** ("I saw it and went back to sleep is a valid decision")
  is a mature primitive and it generalises directly to support triage (§5.3.4).
- **The error-budget freeze is a real continuity mechanism**, not theatre: a freeze that
  exempts ingestion continuity and security while stopping features is exactly the right
  shape for a solo operator, and it is written down in advance "so it is not a mood".
- **The October–November recovery block exists as a plan line.** Most solo projects never
  name recovery at all. The problem is only that nothing defends it (§5.9.3).
- **The НАДРБ cohort is the right community**, and the analysis behind it is real: 286
  formations, 3,647 municipal volunteers across 95.1 % of municipalities, verified against
  the MVR register. Motivated, distributed, phone-first, and already doing the work. This
  is a far better foundation than a generic user community.
- **The transparency posture** — published expectations, public retrospectives, the
  disclaimer doing double duty — means support will inherit a product that has already told
  users the truth, which halves the hardest kind of support conversation.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | No support function: no channel, no undertaking, no triage, no standing replies — and the life-safety message class has no defined handling at all | §5.2, §5.3, §5.4 |
| R-2 | **Critical** | **Single-operator archive survival**: invariant 5 promises permalinks forever with no custodian, no mirror, no archive licence and no funded continuity | §5.5 |
| R-3 | **High** | Moderator recruitment is a headcount with no pipeline; a volunteer with curation rights is an editorial and security decision nobody has made | §5.6 |
| R-4 | **High** | Bus factor 1, with no credential escrow, no handover file and no named successor — while several gates assume a second person exists | §5.7 |
| R-5 | **High** | Cumulative in-season human load has never been summed across support, moderation, curation, incidents, press and community | §5.9 |
| R-6 | **Medium-High** | Support volume spikes with the same event as traffic; R1's mitigations are infrastructural and do not touch it | §5.2 |
| R-7 | **Medium-High** | No press path: a viral fire produces media contact within hours, and an unanswered journalist writes the story anyway | §5.4.3 |
| R-8 | **Medium** | Community expectations are being created faster than capacity to serve them — free accounts, volunteer badges, beta cohorts and partner relationships all imply a responsiveness nobody has budgeted | §5.8 |
| R-9 | **Medium** | Abuse and legal contact (takedown, GDPR requests, a hostile complaint) has a documented substance in 05/09 but no *arrival path* and no clock owner, while GDPR request deadlines are statutory | §5.4.4 |
| R-10 | **Medium** | No offboarding: a volunteer who leaves keeps access until someone remembers | §5.6.5 |
| R-11 | **Low-Medium** | Support has no feedback loop into the product; the highest-value thing a small support function produces — the ranked list of what confuses people — is currently discarded | §5.3.6 |

## 4. Detailed recommendations

Tags: **[MVP]** = before the public beta serves real users; **[v1]** = before the 2027
season; **[v2]** = later.

- **S1 [MVP] (R-1): one inbox, one published undertaking.** A single address, an honest
  SLA that is deliberately weak, and a stated out-of-scope line — §5.3.
- **S2 [MVP] (R-1): the life-safety standing reply, auto-sent.** Any inbound message
  receives an immediate automatic acknowledgement whose **first line is 112** — §5.4.1.
  This is the single highest-value item in the review and it is a mail-filter rule.
- **S3 [MVP] (R-2): the archive continuity plan** — custodian, mirror, licence, domain
  runway, and the dead-man's handover — §5.5. Cheap now, impossible later.
- **S4 [MVP] (R-4): the continuity file** — Appendix B. One encrypted document, one trusted
  holder, reviewed each season boundary.
- **S5 [MVP] (R-9): route legal and privacy contact to a named clock.** A GDPR request has
  a statutory deadline; a request that lands in a general inbox with no clock is a breach
  waiting to be discovered — §5.4.4.
- **S6 [v1] (R-3, R-10): the moderator pipeline as a written process** — recruit, vet,
  train, scope, supervise, offboard — §5.6, with least-privilege tooling that cannot
  publish an official state.
- **S7 [v1] (R-6): the spike playbook** — what support looks like on the worst day, decided
  in advance: auto-reply switches to incident mode, the status page becomes the answer, and
  everything non-life-safety waits — §5.2.3.
- **S8 [v1] (R-7): a press path and a two-page press kit**, so the journalist gets the
  disclaimer verbatim instead of inventing one — §5.4.3.
- **S9 [v1] (R-5): sum the human load** across all reviews and compare it to available
  hours in an August week — §5.9.2. If the sum exceeds the hours, the plan is wrong
  somewhere, and it is better to find out in a spreadsheet.
- **S10 [v2] (R-11): a monthly support digest** — the five most common questions, feeding
  the FAQ and the product backlog — §5.3.6.

## 5. Support, community & continuity deep dive

### 5.1 Support is not on-call, and the difference matters

| | **On-call (owned by 04 / `OPERATIONS.md`)** | **Support (unowned)** |
|---|---|---|
| Initiator | A monitor | A person |
| Volume | Bounded by the number of alarms | Unbounded, and correlated with attention |
| Latency expectation | Set by us (30 min, in season) | Set by the sender's anxiety |
| Content | Machine state | Anything, including grief and anger |
| Failure mode | An incident continues | Trust ends, quietly and permanently |
| Can be automated away | Substantially | Only the first reply |

The corpus has repeatedly reasoned about the first column and imported its comfort into
the second. They do not share a design. In particular, "the architecture, not the human,
covers the rest" is true for alerts and false for people: an unanswered person does not
degrade gracefully to a T2 fallback.

### 5.2 The volume nobody has modelled (R-1, R-6)

#### 5.2.1 Baseline

Industry rules of thumb for a free consumer utility put monthly contact rates somewhere
around **0.5–2 % of active users**, lower for a product with a good FAQ and no account
requirement, higher for one that people rely on emotionally. Marked as an estimate, not a
measurement — but the order of magnitude is what matters:

| Users (alert-armed weekly, CP3's metric) | Contacts/month at 0.5 % | At 2 % |
|---|---|---|
| 500 (CP2 threshold) | ~3 | ~10 |
| 2,000 (CP3 threshold) | ~10 | ~40 |
| 20,000 | ~100 | ~400 |
| 50,000 (R1's viral scenario) | ~250 | ~1,000 |

At CP2 scale this is trivially manageable and the temptation is to conclude there is no
problem. At CP3 scale it is an evening a week. At R1 scale it is a full-time job, arriving
on the day that is already the worst day.

#### 5.2.2 The spike is not proportional — it is worse

Contacts do not scale with users; they scale with **users × salience**. On a viral fire
day, the fraction contacting rises at the same time as the population: more users, and a
larger share of them motivated. A 10× user spike with a 3× engagement multiplier is a 30×
inbox. Additionally, the spike arrives **skewed toward the classes with the highest
handling cost**: life-safety, press, and "your map is wrong".

#### 5.2.3 The spike playbook (S7)

Decided in advance, because it cannot be decided at the time:

1. **Incident mode is a switch**, not a judgement. Above a threshold, the auto-reply
   changes to say plainly: high volume, individual replies are delayed, here is the status
   page, here is what we know, **112 for emergencies**.
2. **The status page becomes the answer.** One update per hour during an incident beats
   fifty personal replies, and it is the same information. This is what a status page is
   *for* and the project already has one.
3. **Only two classes get individual handling during a spike**: life-safety and press.
   Everything else queues, and the auto-reply has already said so.
4. **The queue is worked down after, not during.** Explicitly permitted, in writing, so a
   tired operator does not treat it as failure.

### 5.3 The support surface (S1)

#### 5.3.1 One channel

One email address, published. Not a chat widget (implies presence), not a ticket portal
(implies staff), not DMs on three social platforms (unbounded and unarchivable). The
Telegram alert channel is *outbound* and must never become an inbound support channel by
accident — that is the fastest way to destroy the one notification path that has to keep
working at 3 AM.

An in-app "report a problem with this event" affordance may exist and should post to the
same inbox with the event id attached; it is a form, not a second channel.

#### 5.3.2 The undertaking, published, and deliberately weak

> We read every message. We aim to reply within **five working days**, and often sooner.
> During a major fire, replies take longer — the same person is keeping the map running.
> **We are not an emergency service: call 112.**

Five working days looks embarrassing next to a commercial SLA and is the correct number
for one person with a day job. A promise of 24 hours, broken in August, costs more trust
than a slow promise kept. This is the same principle as the honest clock (invariant 3),
applied to the humans.

#### 5.3.3 The out-of-scope line

Published alongside it, because the alternative is discovering it one message at a time:
we cannot dispatch help, cannot confirm whether a specific fire threatens a specific
address, cannot advise on evacuation, and cannot tell anyone whether it is safe to go home.
Each of those, answered informally and wrongly, is a direct route to the R4 kill scenario
via an inbox rather than via a push notification.

#### 5.3.4 Triage: four buckets, in priority order

Borrowing §3.1's acknowledgement-with-a-reason primitive, every message gets classified
once and the class determines the clock:

| Class | Clock | Handling |
|---|---|---|
| **Life-safety** — anything implying present danger to a person | **Immediate, automatic** | The S2 standing reply; no human judgement in the loop, ever |
| **Legal / privacy** — GDPR request, takedown, complaint | **Statutory** (§5.4.4) | Named clock, logged on arrival |
| **Press** | Same day if possible | §5.4.3 |
| **Everything else** — bugs, data errors, questions, praise | Five working days | Batched |

The critical property is that **classification happens before reading**, by keyword and by
the automatic reply, because the life-safety class must not wait for the operator to open
the mail.

#### 5.3.5 Standing replies

Appendix A. Roughly ten of them cover the great majority of a small product's volume, and
writing them costs an afternoon once. The two that matter most — life-safety and "your map
is wrong / missing my fire" — are also the two that carry the product's core honesty, so
they should be written by whoever owns the wording contract and held to the same never-send
discipline as the UI copy (invariant 2 applies to email, and nothing currently says so).

#### 5.3.6 The feedback loop (S10)

The single most valuable output of a small support function is not the replies; it is the
ranked list of what confuses people. One line per contact in a text file — class, one-line
summary, event id if any — and once a month the top five go to the FAQ and the backlog.
Without it, the same confusion is answered a hundred times and fixed never.

### 5.4 The four message classes that are not ordinary support

#### 5.4.1 Life-safety (S2) — the one that will definitely happen

Someone will write "има пожар над село X, какво да правим". Possibly at 02:40. Possibly
while the operator is asleep, driving, or on the other side of the country. The message
may be the first the project ever receives.

The response must be **automatic, immediate, and independent of the operator**: every
inbound message triggers an auto-reply whose first line is 112, followed by the standing
"do not travel toward the fire" line, followed by the response-time reality. A mail-filter
rule and a saved template. It removes the worst failure mode in this review — a plea for
help sitting unread for nine hours — for approximately zero cost.

What it must **not** do is attempt to be useful about the specific fire. No links to the
event page, no "our map shows", no reassurance. The automatic reply routes to the
authorities and says when a human will read it. That is the whole job.

#### 5.4.2 "Your map is wrong"

The highest-volume interesting class, and it splits three ways: the map is right and the
user misread it (a UI finding), the map is stale within budget (an honest-clock finding —
if they had to write, the clock was not visible enough), or the map is genuinely wrong (a
data finding, and the most valuable message the project can receive).

Two rules: never argue, and never assert the map is right without checking. A support reply
that defends the product is a curated statement in our own voice with no source ladder
behind it — 16's R-1 arriving by email.

#### 5.4.3 Press (R-7, S8)

A viral fire produces media contact within hours, and this project is unusually
press-attractive: a solo civic developer, satellites, a national anxiety, and a partner
(WWF) who already talks to national media. CP3 counts media embeds as a success criterion,
so this is a channel the plan wants.

The failure mode is not a bad quote; it is **no quote**. An unreachable source does not
prevent the story — it produces a story that describes the product without its disclaimer,
and the disclaimer is the entire liability posture (R4, ЗЗП). A two-page press kit — what
the product is, what it explicitly is not, the normative statement from `README.md`
verbatim, data sources and their attribution, the honest limitations, one contact — makes
the accurate version the easy version. It also protects against the specific harm of a
journalist writing "an app that tells you when the fire is out", which is the one sentence
that must never appear about this product.

#### 5.4.4 Legal, privacy and abuse (R-9, S5)

09 and 05 have done the substantive work: the GDPR rights machinery, the breach runbook
with КЗЛД's 72-hour templates, the DSA-shaped mechanics for user content, the ЗЗП shield.
What is missing is the **arrival path and the clock**: a data-subject request has a
statutory deadline that starts when it arrives, not when it is noticed, and "it went to the
general inbox in August" is not a defence.

Minimum viable: a published contact route for privacy requests, a rule that any message
matching a small keyword set is logged with its arrival timestamp on the day it arrives,
and the existing runbooks attached to that log. The substance already exists; only the
trigger is missing.

### 5.5 Data stewardship and archive survival (R-2, S3)

*This is the section review 15 folded in rather than making a fifth seat. It is placed here
because archive survival is a continuity problem, not a database problem — 03 and 04
already own partitioning, PITR and restore drills.*

#### 5.5.1 The promise, and what backs it

Invariant 5: *permalinks are forever — every event `public_id` ever issued resolves for the
lifetime of the archive.* This is an unusually strong promise, correctly motivated
(citations, journalism, retrospectives, trust), and it is currently backed by: one VM, one
object-storage bucket, one domain registration, and one person's credit card. All four have
the same single point of failure, and it is not technical.

It is also the **only** commitment in the corpus with an unbounded time horizon. Everything
else — SLOs, gates, checkpoints, seasons — has a scope and a date.

#### 5.5.2 What the archive actually is

A multi-year, structured record of satellite fire detections over the Balkans, clustered
into events, with provenance, ingest-config versioning, and (from 16) curated official
statements attached. There is no other public dataset of that shape for this region: J2
found nothing on data.egov.bg, J4's БИПД/RESAC is prior art rather than an archive, and
EFFIS holds perimeters rather than a detection history with our clustering. That makes it a
small public good, and it means the interesting question is not "will we lose our data" but
"what happens to a public record when its single custodian stops".

#### 5.5.3 The five things that make it survivable

1. **An archive licence, decided now.** The detections derive from sources whose terms are
   already mapped (09, Part N); the *clustering, event identity and curated layer* are ours.
   A stated open licence on the derived archive — with the upstream attributions preserved —
   turns "our data" into "a dataset others may keep", which is the only durable form of
   survival. It also has to be checked against every upstream licence before it is claimed;
   that is one pass over an existing table, not new work.
2. **A second copy that is not ours.** A periodic dump deposited somewhere institutional —
   a university, a research repository with a DOI, an open-data portal — makes the archive
   outlive the infrastructure. One export a year is enough; the value is that it exists
   elsewhere, not that it is current.
3. **A domain runway.** The permalink promise is a *DNS* promise before it is a database
   promise. Register long, pay ahead, and note the expiry in the continuity file. A lapsed
   domain breaks every permalink ever issued, and nothing in the technical stack notices.
4. **A named custodian.** One person, named in the continuity file, who has what they need
   to keep the archive reachable — even if the service itself stops. This is the smallest
   possible answer to "forever" and it is far better than none.
5. **A published degradation path.** If the project ends, permalinks may honestly degrade
   from a live service to a static archive of the same URLs. Say so in advance, in the
   transparency page, and the promise stays true in the form that actually survives.

#### 5.5.4 The sunset branch, made concrete

CP3's ≤1-of-4 outcome — "convert to a donation-funded civic project or sunset gracefully,
data archived and published" — currently has one verb doing all the work. With §5.5.3 in
place it becomes executable: freeze ingestion, publish the final dump under the archive
licence, render the archive static behind the same URLs, redirect alerts to a farewell
notice with 112 and the official channels, and hand the domain to the custodian. That is a
week of work if the groundwork exists and an impossibility if it does not. Combine with
17 §5.10 for the physical assets and the sunset is fully specified.

### 5.6 The moderator pipeline (R-3, S6)

#### 5.6.1 What is being asked for, and what it implies

"1–2 volunteer moderators from the НАДРБ cohort by v1" is the mitigation for the project's
highest-likelihood risk and a launch precondition for crowdsourced reports (05, 09, 07
§5.7). It implies handing a volunteer some degree of write access to a public
safety-adjacent map. That is simultaneously a security decision (05 §5.4's separate admin
plane with mandatory 2FA), an editorial decision (16's source ladder and never-publish
list), and a legal one (НК чл. 326 does not distinguish between a founder and a volunteer).

#### 5.6.2 Least privilege, stated as a rule

**A volunteer moderator may triage; only the editorial owner may publish an official
state.** Concretely: a moderator can accept, reject, flag or merge a user report and add an
internal note; a moderator cannot set `officially_contained` or `officially_extinguished`,
cannot edit event geometry, cannot send anything, and cannot see personal data beyond what
triage requires. This keeps 16's ladder intact, keeps the criminal-law exposure with the
person who accepted it, and makes the role small enough that a volunteer can actually do
it well.

#### 5.6.3 The pipeline

| Stage | What it is | Cost |
|---|---|---|
| **Recruit** | Through НАДРБ formations and the beta cohort, not a public call. A named champion inside a formation is worth more than a signup form (10's own open question 4) | Meetings, already planned |
| **Vet** | Identity known, formation membership confirmed, a conversation. Not a background check — a real person who can be reached | An hour each |
| **Train** | The never-send list, the source ladder (16 §5.2), the triage worksheet (12 §8.3), and the standing "when in doubt, reject" rule | A half-day, once, reusable |
| **Scope** | Named area or named shift, so "on duty" is bounded and absence is expected rather than a failure | — |
| **Supervise** | Every moderator action is an audit row (WP6 already provides this); a weekly skim, not a review of each action | 15 min/week |
| **Retain** | Attribution if they want it, a real relationship, and honesty that this is unpaid civic work | Ongoing |
| **Offboard** | §5.6.5 | 10 min |

#### 5.6.4 The uncomfortable truth about volunteer moderation in season

Volunteer availability is **anti-correlated with need**. НАДРБ volunteers are exactly the
people who are physically at fires in August — the hour a moderator is most needed is the
hour they are least likely to be at a screen. Consequences: never make a volunteer a
single point of failure in any path; design the report queue so that an unmoderated report
is invisible rather than pending-and-shown; and treat "zero moderators available" as the
normal state during a major fire rather than as an exception. This is also the strongest
argument for 16 §5.9's conclusion that crowdsourced reports must not ship in the same
season as the first curated statements.

#### 5.6.5 Offboarding (R-10)

Volunteers drift away silently — no resignation, just a season that passes. Without a rule,
credentials accumulate. The rule: access is reviewed at every season boundary, inactive
accounts are disabled by default rather than kept "in case they come back", and disabling
is friendly and reversible. Two lines in a runbook and it prevents the most common
small-organisation security failure there is.

### 5.7 The second person and the bus factor (R-4, S4)

#### 5.7.1 What breaks today if the operator is unavailable for two weeks in August

Ingestion continues (it is automated, and correctly so). Alerts continue, failing closed.
The map stays up on T2. And then: nothing else. No support replies. No curation, so official
containment never appears. No incident response beyond automatic degradation. No press
reply during exactly the window that produces press. No moderation. If the outage is longer
than the payment cycle of any provider, the failure eventually becomes terminal and silent.

The system is genuinely well-architected for this — that is the achievement of 04 and
ADR-003 — and it is precisely why the *human* gap is the one worth naming: everything that
survives is automated, and everything that does not survive is this seat's subject matter.

#### 5.7.2 The continuity file (Appendix B)

One encrypted document, held by one trusted person who is not the operator, containing what
is needed to keep the archive reachable and the users informed. **Not** the full operational
runbook — that is `OPERATIONS.md`'s job and it is already public within the project. The
continuity file is narrower and more sensitive: where things are, who to tell, what to say,
and how to reach the accounts that keep the lights on.

Reviewed at each season boundary, at the same moment as the error-budget review, so it does
not rot.

#### 5.7.3 The "second reader" is a smaller ask than a co-founder

16 §6 asks for a second person who can do a curation sweep. This review asks for a second
person who can send a status update and answer the inbox for a week. Neither is a partner,
neither needs equity, and both are plausibly the same volunteer from §5.6. Framing it as
"cover for two weeks in August" rather than "join the project" is the difference between an
ask that gets a yes and one that gets a polite maybe.

### 5.8 Community, and the expectations it creates (R-8)

The GTM plan creates relationships faster than it creates capacity to serve them: free
accounts for volunteer formations, a "verified volunteer" report badge, a beta cohort of
100+ volunteer accounts by April 2027, partnership meetings with WWF and Meteo Balkans,
3–5 duty-officer interviews, and a press presence. Each is individually cheap and correct.
Together they are a community with a reasonable expectation of responsiveness, arriving in
the same quarter as launch.

Three rules that cost nothing and prevent the predictable disappointment:

1. **Never promise a channel that is not staffed.** A free account is a product; a
   relationship is a commitment. Give the first generously and the second sparingly.
2. **Partner communication is scheduled, not reactive** — a short monthly note to partners
   and the volunteer cohort during the season replaces most individual contact, and it is
   the same content as the status page and the support digest.
3. **The badge is a permission, not a rank.** A "verified volunteer" badge implies we have
   verified something; §5.6.2 says what, and the badge copy must not imply more than the
   vetting actually did.

### 5.9 Load, summed (R-5, S9)

#### 5.9.1 The pattern across the corpus

Every review has added human work to one person, each time defensibly, and no review has
ever subtracted any. Curation sweeps (16), moderation supervision (§5.6), support (§5.3),
incident response (04), field maintenance if hardware lands (17 §5.8.5), press (§5.4.3),
partner communication (§5.8), and the ordinary business of shipping software. Each was
scoped as "a few hours". The season is ten weeks long.

#### 5.9.2 The sum, as a working estimate

Peak in-season week, if everything in the corpus is done as written — deliberately rough,
because the point is the order of magnitude:

| Activity | Hours/week at peak |
|---|---|
| Curation sweeps (16 §5.6.1, two majors) | 5–10 |
| Support at CP3 scale | 2–5 (spike day: much more) |
| Moderation supervision | 1–2 |
| Incident response | 0–10, unpredictable |
| Press and partners | 1–3 |
| Engineering (bugs, not features) | 5+ |
| **Total** | **~15–35 h/week, on top of a day job** |

That is not survivable for ten consecutive weeks, and it does not need to be argued about —
it needs to be **decided**. The levers are: cut curation to one major (16 §5.6.1 is already
written to degrade honestly), delay crowdsourced reports (16 §5.9 already recommends it),
keep the support undertaking weak (§5.3.2), and use the freeze policy without guilt. All
four are already in the corpus. What is missing is the recognition that they are not
independent options but a **budget that must balance**, and that if it does not, the thing
that gives way is the operator.

#### 5.9.3 Defending October (S9, R-5)

The October–November recovery block is a plan line with nothing defending it, and it lands
directly on CP1 (31 October), the CP1 report, and the post-season retrospective. The
minimum defence: define what recovery mode means operationally — alerts continue
fail-closed, the map continues on automation, support moves to a two-week undertaking with
an honest auto-reply, no curation, no features, no meetings — and schedule the CP1 work
*before* the block rather than inside it. A recovery period that contains a hard checkpoint
is not a recovery period.

### 5.10 Continuity artifacts, summarised

Four documents, none long, all of which can exist before launch:

1. **The published support page** — channel, undertaking, out-of-scope, 112 (§5.3).
2. **The standing replies** — Appendix A (§5.3.5).
3. **The continuity file** — Appendix B, encrypted, one holder (§5.7.2).
4. **The archive continuity plan** — licence, deposit, domain runway, custodian, degradation
   path (§5.5.3).

Together they are perhaps a day of writing, and they convert the two Critical risks in this
review into Medium ones.

## 6. Open questions for the team

1. **Who is the second person?** Not a co-founder — someone who can answer an inbox and
   send a status update for two weeks in August, and who holds the continuity file. This is
   the same question 16 §6 asks from the editorial side, and one person could answer both.
2. **What licence does the archive carry, and where is the second copy deposited?**
   (§5.5.3.) Needs the 09 licence pass over the derived-archive question, and it should be
   answered before the archive is large enough to make the question feel expensive.
3. **Does crowdsourced reporting ship in the 2027 season at all?** 16 §5.9 says no; §5.6.4
   independently reaches the same conclusion from volunteer availability. If both are
   accepted, the plan's moderator line should be re-scoped from "moderator for reports" to
   "second reader and cover", which is a much easier recruit.
4. **What is the honest support undertaking?** §5.3.2 proposes five working days. It is a
   published promise and therefore a product-owner decision, not a support one.
5. **Is the October recovery block real?** If CP1's report is written inside it, the answer
   is no, and the schedule should say so rather than the plan pretending otherwise.

## Appendix A — The standing reply set

Written once, in Bulgarian as the normative version (English glosses here), held to the
same never-send discipline as the UI copy.

| # | Trigger | Core content |
|---|---|---|
| 1 | **Any inbound message** (automatic) | **112 first.** Do not travel toward the fire. We are not an emergency service. We read everything; replies take up to five working days, longer during a major fire. |
| 2 | Incident mode (automatic, switched) | As #1, plus: unusually high volume right now; the status page has the latest; individual replies are delayed. |
| 3 | "Is my house/village in danger?" | We cannot assess danger to a specific address. Official information comes from ГДПБЗН and the municipality; 112 for emergencies. What our map shows and what it cannot show. |
| 4 | "Your map is missing a fire" | Thank you — genuinely useful. How satellite detection works, why small or cloud-covered or short-lived fires are missed, what we will check, and that we do not update the map from unverified reports. |
| 5 | "This fire is out, remove it" | We never state that a fire is out in our own voice. When an authority declares it contained or extinguished, we show that statement with a link. Detections fade rather than disappear, and why. |
| 6 | "How fresh is this data?" | Point to the in-product answer; restate the honest-clock principle and the real latency range. |
| 7 | Press | Press kit attached; the normative statement verbatim; contact and availability. |
| 8 | Privacy / data request | Acknowledged with the arrival date recorded; routed to the 05/09 process; the statutory clock stated. |
| 9 | Volunteer / partner enquiry | What we can offer now, honestly, including that we are small. |
| 10 | Praise | A real reply. It is one of the few things that sustains a solo civic project, and the reply costs a minute. |

## Appendix B — The continuity file

Encrypted, one trusted holder who is not the operator, reviewed at every season boundary.

- **Who to tell, in order** — partners, the volunteer cohort, and the users via the status
  page and a farewell notice.
- **What to say** — a pre-written status-page notice for "the operator is unavailable",
  honest and undramatic, so it does not have to be composed by someone in distress.
- **Where everything is** — registrar, DNS, hosting, object storage, payment method,
  monitoring, and the mail domain. Pointers and account identities, never secrets in the
  clear; the vault is the vault, and this file says where it is and how to reach it.
- **The archive** — where the deposited copy lives, under what licence, and who the named
  custodian is (§5.5.3).
- **The minimum to keep alive** — the domain and the static archive. Everything else may
  stop; those two are what invariant 5 actually promises.
- **The stop procedure** — how to fail alerts closed permanently and put the site into
  archive mode, in the order that never sends a wrong notification.
- **Expiry dates** — domain, certificates, any prepaid service — because the most likely
  quiet death of this project is an unpaid renewal nobody knew about.
