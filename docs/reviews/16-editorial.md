# Review 16 — Editorial & curation standards

*Reviewer role: senior editor / newsroom standards. Date: 2026-08-25. Status: complete.*
*Inputs reviewed: `README.md`, `docs/GLOSSARY.md` §3/§3b/§5, `docs/GATES.md` §4,
`docs/IMPLEMENTATION-PLAN.md` WP6, `reviews/09-legal-licensing.md`, `reviews/12-fire-domain.md`,
`reviews/07-product-ux.md` §5.7, `reviews/00-summary.md`. Project is in implementation (WP0–WP1).*

---

## 1. Summary verdict

**CONDITIONAL GO — the curated half of the product is currently a form with no standard
behind it, and the two different editorial products it will serve have been merged by
accident.**

Fire Watch defines itself, in its own first sentence, as satellite data "**plus curated
official information**". The satellite half is specified to four decimal places across
reviews 03, 11 and 12 and a 1,400-line source survey. The curated half consists of: an
admin form in WP6 with an audit row per action; the exact strings it may render, frozen in
GLOSSARY §3 and lint-enforced by CI-10/CI-11; a domain review that says which official
words mean what (12 §4.1); and an open question, escalated twice, about what happens when
the one person doing the curating cannot keep up. Between the form and the strings there
is nothing: **no rule for which sources may be believed, no verification standard, no
correction path, and no definition of what "we do not know" looks like on the screen.**

Four structural findings:

1. **There are two editorial products, and the corpus treats them as one.** The *public
   voice* (curated incident statements, official-state transitions, cross-border context)
   and the *news log* (the internal corroboration record that GATES §2 makes the
   independent leg of CER, and CP1's protocol requires a "named news-log curator" for) are
   different artifacts with different rules. Today the same person, reading the same
   Facebook posts, produces both — which means **the product's own accuracy metric is
   scored by the same judgement it measures**. That is a measurement-independence defect,
   not merely an organizational one (§5.1, R-2).
2. **The lint protects the wording, not the claim.** CI-10 and CI-11 guarantee that a
   curated statement is *phrased* correctly. Nothing guarantees it is *true*. "Обявен за
   локализиран от властите на 24.08 — източник" passes every gate in the repository while
   citing a municipal Facebook post that was itself wrong. The never-send list is a
   vocabulary control mistaken for an editorial control (§5.3, R-1).
3. **Corrections have no mechanism, and invariant 5 makes that expensive.** Permalinks are
   forever; a curated statement attached to an event is therefore forever too. There is no
   retraction state, no correction copy in GLOSSARY §3, and no rule about whether an alert
   was already sent on the strength of the statement being retracted. A wrong "declared
   contained" that reaches a push channel is R4 — the kill scenario — arriving through the
   one path in the system that has no shadow mode and no CI gate (§5.5, R-3).
4. **The lag case is undesigned, which is the case that will actually occur.** During a
   Sakar-type week, a solo curator falls behind within hours. The product currently has no
   distinct rendering for "this event has no curated information yet" versus "this event
   has curated information and it says nothing is happening". Silence read as calm is the
   exact failure mode T6 and T10 exist to prevent, and the curated layer reintroduces it
   through a door the automated layer has already locked (§5.6, R-4).

The GO is conditional on five things, none of which needs code: a published source ladder,
a two-source rule with named exceptions, a correction state with its own copy, a curation
SLA that the UI can render honestly when it is missed, and separation of the news log from
the public voice.

## 2. Strengths (editorially sound as proposed)

- **The wording ladder is genuinely excellent.** GLOSSARY §3's tiered strings — with the
  Bulgarian operational terms *локализиран* and *ликвидиран* carried in their own meaning
  and explained inline ("containment means spread is stopped; the fire may still burn
  inside the perimeter") — solve a problem most newsrooms get wrong for years. 12 §4.1's
  translation of the official states is the best single page in the corpus for this seat.
- **"Never borrow authority" (T11) is the right editorial constitution.** Official states
  quoted with attribution and link, never restated as our own finding, is precisely the
  posture a small publisher must hold toward an institution it cannot verify.
- **The audit row per curation action** (WP6) is the correct primitive. Most of §5.5's
  correction machinery can be built on top of it rather than beside it.
- **12 §2's actor map is a usable source register in draft.** It already tells an editor
  which institution produces which statement, and — critically — that ГДПБЗН's daily
  bulletin is a summary, not an incident feed.
- **The absence of scanner traffic was found early.** Bulgaria's TETRA is encrypted; there
  is no Broadcastify equivalent. Knowing that the Watch Duty model does not transplant is
  worth more than any tooling decision, and it is already recorded (12, 00-summary).
- **НК чл. 326 is named as the criminal boundary** (09), which most editorial policies in
  this space discover late. It is the floor under everything in §5.3.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | No verification standard: any statement that passes the wording lint may be published, regardless of the strength of its source | §5.3 |
| R-2 | **Critical** | The news log that scores CER is produced by the same person and process as the public voice it validates — the corroboration metric is not independent | §5.1 |
| R-3 | **High** | No correction or retraction state; invariant 5 makes a wrong curated statement permanent, and a retracted statement that already triggered a send has no defined follow-up | §5.5 |
| R-4 | **High** | "Curation has not reached this event yet" is indistinguishable from "curation says nothing is happening" — silence read as calm | §5.6 |
| R-5 | **High** | No source ladder: a municipal Facebook post, a БТА wire item and a ГДПБЗН bulletin currently carry identical weight in the form | §5.2 |
| R-6 | **Medium-High** | Cross-border events (H7) have no source register at all — Greek, Serbian, North Macedonian and Turkish official channels are unenumerated and unread | §5.7 |
| R-7 | **Medium-High** | Curation load is unbudgeted: nobody has counted the reading hours a July week costs, so the SLA in §5.6 has no evidence base | §5.8 |
| R-8 | **Medium** | Moderation of user reports (07 §5.7, gated on capacity) shares this seat's time budget, and the two have never been costed together | §5.9 |
| R-9 | **Medium** | Quoting official text at length has a copyright dimension nobody has scoped — the licences in 09 cover *data*, not press releases and bulletins | §5.4 |
| R-10 | **Medium** | The admin form's field set is unspecified beyond "set the state"; without source URL, capture, confidence and curator identity as required fields, the audit row records the action but not its justification | §5.10 |
| R-11 | **Low-Medium** | Media embeds (CP3 criterion 2) will quote our curated statements onward; there is no policy for what a third party may republish or how a correction propagates to them | §5.5.4 |

## 4. Detailed recommendations

Each maps to a risk. Tags follow the corpus convention: **[MVP]** = before the first
curated statement ships; **[v1]** = before the 2027 season; **[v2]** = later.

- **E1 [MVP] (R-5, R-1): publish a source ladder** with four tiers and a rule per tier —
  §5.2. It is one table. It is also the artifact the L-15 gate checks for.
- **E2 [MVP] (R-1): adopt the two-source rule with three named exceptions** — §5.3. The
  exceptions matter more than the rule; a policy with no exceptions is a policy that gets
  broken silently at 3 AM.
- **E3 [MVP] (R-3): add a correction state and its copy** to GLOSSARY §3, with the same
  frozen-string treatment as the rest of the ladder, so CI-11 covers it — §5.5.
- **E4 [MVP] (R-4): design the two silences.** "No curated information" and "curated, no
  change" are different states and need different renderings; GLOSSARY §3b already has the
  degraded-copy pattern to extend — §5.6.
- **E5 [MVP] (R-2): separate the news log from the public voice** — different file,
  different schema, and a written rule that a news-log entry is never the sole source for
  a public statement, nor a public statement its own corroboration — §5.1.
- **E6 [MVP] (R-10): specify the admin form's required fields** — source URL, capture
  (screenshot or archived text), tier, curator, and a free-text justification — §5.10.
- **E7 [v1] (R-6): build the cross-border source register** — §5.7, Appendix B seeds it.
- **E8 [v1] (R-7, R-8): run a curation time study** during the 2026 shadow season, when
  the reading has to happen anyway for the news log — §5.8. Two numbers: minutes per major
  event per day, and events per day at the season peak.
- **E9 [v1] (R-9): scope the quotation question** — a short note in 09's frame on how much
  official text may be reproduced, and default to short quote plus link — §5.4.
- **E10 [v2] (R-11): publish a republication note** for media embeds: what may be quoted,
  and the undertaking that we will notify on correction — §5.5.4.

## 5. Editorial deep dive

### 5.1 Two editorial products, wrongly merged

The corpus asks the same activity — a person reading ГДПБЗН bulletins, municipal Facebook
pages and БТА during a fire — to produce two things that must not be produced together.

| | **Public voice** | **News log** |
|---|---|---|
| Audience | Users, on the event page and in alerts | The evaluation harness, and CP1's report |
| Purpose | Tell people what authorities have said | Record whether a real fire existed, independently of our detections |
| Failure mode | Publishing something wrong (R4) | Confirming our own output (circularity) |
| Latency need | Fast — hours matter | None — it may be written days later |
| Vocabulary | GLOSSARY §3's frozen strings | Free text; no user ever reads it |
| Correction | Public, with its own state | Silent edit, versioned |

The measurement problem is precise. GATES §2 makes news-log corroboration **the
independent leg of CER** specifically because EFFIS burnt-area perimeters partially derive
from the same MODIS/VIIRS detections we ingest — the EFFIS circularity finding. If the
news log is produced by a curator who has the map open, the independence that leg was
introduced to supply is gone. The curator does not have to cheat; they only have to look
at the event list to decide which municipality's Facebook page to check today. That is
enough to correlate the log with the detections.

**Recommendation E5, in operational terms.** Three rules, all cheap:

1. **Direction of work.** News-log entries are created from a *source-first* sweep — a
   fixed list of channels read on a fixed cadence — never from an event-first prompt
   ("find corroboration for `fw-2026-…`"). What the sweep finds is written down; matching
   to events happens afterwards, by a script, on coordinates and dates.
2. **Blinding what can be blinded.** The sweep is done without the map open. This is not
   ceremony: it is the difference between a log that can falsify PCR and one that cannot.
3. **Two files, one direction of flow.** A news-log entry may become the *source* for a
   public statement (that is its second use, and it is legitimate). A public statement may
   never be copied back into the news log as corroboration. The flow is one-way and the
   schema should make the violation impossible — the news log has no field that can hold
   an internal event id at write time.

**A caveat that must be stated rather than solved.** With one person, the news log is
independent of the *detections* but not of the *curator*. A curator who believes the
product is good will find corroboration more readily. That bias is not removable at this
scale; it is disclosable, and CP1's protocol — written in September 2026, before the
season it grades, and not edited afterwards — is the right place to disclose it. Name the
curator, fix the channel list, fix the cadence, and record that the log is single-scored.

### 5.2 The source ladder (E1)

Every publishable claim gets a tier. The tier determines what may be said and how many
sources are needed. This is the table that WP6's form should render as a required select.

| Tier | Sources | What may be published | Rule |
|---|---|---|---|
| **T1 — Official, attributable, durable** | ГДПБЗН national and regional bulletins; МВР press releases; official municipal announcements on a municipal domain; ИАГ / state forestry enterprise statements; a government decision in ДВ | Operational states (`officially_contained`, `officially_extinguished`), resource statements ("aircraft deployed"), official evacuation facts | Single source sufficient. Quote + link + capture. |
| **T2 — Official, attributable, ephemeral** | Municipal or ГДПБЗН **Facebook** posts; official statements quoted verbatim in a national wire item (БТА) | The same as T1, **but** capture is mandatory and the statement carries its channel in the attribution ("municipal announcement on Facebook") | Single source sufficient **only** for de-escalating facts; escalating or life-safety facts need a second source of any tier. |
| **T3 — Journalistic** | БТА, national broadcasters, established regional outlets | Context, scale, road closures, human-interest facts. **Never** an operational state in our voice | Two independent outlets, or one outlet quoting a named official. Attribute to the outlet, never to the authority. |
| **T4 — Unverified** | Social posts by non-officials, user reports, forum threads | **Nothing**, in the public voice. Usable as a *lead* that sends the curator to T1–T3, and usable in the news log flagged as T4 | Never a source for a state transition; never quoted on an event page in v1. |

Three notes an editor would insist on:

- **Tier is a property of the *statement*, not the outlet.** БТА quoting a named ГДПБЗН
  officer verbatim is a T2 statement carried by a T3 outlet, and the attribution must say
  so: "according to ГДПБЗН, quoted by БТА". Collapsing that into "according to ГДПБЗН"
  borrows authority (T11) and hides the failure mode where the outlet paraphrased.
- **Ephemerality is a real hazard, not a formality.** A municipal Facebook post can be
  edited or deleted without trace, and municipal pages are the single richest curation
  source we have (12 §2.4). Capture at read time or the statement is unsupportable a week
  later — which is exactly when someone asks about it.
- **The ladder has a floor, and it is criminal law.** НК чл. 326 punishes false alarms.
  T4 is not merely weak evidence; publishing an unverified fire claim in our own voice is
  the conduct the article describes. That is why T4's row says "nothing" rather than
  "with caveats".

### 5.3 The verification standard (E2)

**The two-source rule.** A statement is publishable in Fire Watch's own voice when it is
supported by two independent sources, at least one of which is T1 or T2.

**Independent** means: not republishing each other. Two outlets running the same БТА wire
are one source. Two municipal pages sharing the same regional directorate's text are one
source. This is the rule that gets misapplied most often and it deserves the sentence.

**Three named exceptions**, because a rule with no exceptions is broken silently:

1. **T1 de-escalation.** A ГДПБЗН bulletin declaring *локализиран* or *ликвидиран* is
   publishable alone. It is the authoritative source for its own state by definition, and
   requiring a second source would mean withholding the official position — which the
   product has no standing to do.
2. **Life-safety relay.** An official evacuation instruction may be surfaced from a single
   T1/T2 source **immediately**, because the harm of delay exceeds the harm of duplication
   — but only as a quoted, linked, timestamped item, never as an alert in our own voice,
   and subject to the unresolved escalation question in §6 Q2. This exception exists to be
   *narrow*: it authorizes showing, not pushing.
3. **Our own correction.** A retraction never waits for a second source. If we have reason
   to believe our own statement is wrong, the correction ships on that belief alone.
   Symmetry here would be a mistake: the cost of a slow correction is borne by users, the
   cost of a fast one by us.

**What is never publishable, at any tier** (extending 12 §3.4, which the Notification
Gateway already enforces for alerts — this extends it to the curated layer):

- Any claim that a fire is out, safe, or no longer a threat, in our own voice. The GLOSSARY
  §3 negation strings remain the sole exception, and they are quotations of an authority's
  state, not assertions of a fact.
- Any prediction of fire behaviour — direction, speed, what it will reach. We may quote an
  official's prediction with attribution; we may never make one.
- Any statement about cause, arson, or a named responsible party. This is the fastest route
  from a fire map to a defamation claim, and it adds nothing users need.
- Any count of casualties or damage before an official figure exists.
- Any instruction to act — evacuate, stay, travel, avoid — in our own voice. Quoted
  official instructions only, with 12's standing "do not travel to the fire area".

### 5.4 Attribution, quotation and the borrowed-authority line (R-9)

The attribution pattern is fixed by T11 and by GLOSSARY §3's existing strings: state,
authority, date, link. Two additions this seat would make:

- **Every curated statement renders its tier's provenance in words**, not just a link.
  "Municipal announcement (Facebook), 24 Aug 18:40" and "ГДПБЗН bulletin, 24 Aug 09:00"
  are different epistemic objects and the user is entitled to tell them apart. This is the
  same honesty principle the honest-clock work applies to data age (T10) — applied to
  source strength.
- **Quotation length is a licensing question nobody has scoped.** 09's licence analysis
  covers *data* sources; a ГДПБЗН press release is a text, and Bulgarian copyright's
  official-works exemption is a question for the same lawyer session 09 §10 already
  budgets, not for an engineer's judgement. Until it is answered, the default is a short
  quote (one or two sentences), a link, and a locally stored capture that is **evidence,
  not publication** — the capture is never served to users. That default is almost
  certainly safe and costs nothing.

### 5.5 Corrections, retractions and permanence (E3)

#### 5.5.1 Why this is harder here than in a newsroom

A newspaper corrects by publishing a correction; the wrong article is amended and the
record shows both. Fire Watch has two complications a newsroom does not:

- **Invariant 5** — permalinks are forever. Every event URL ever issued resolves for the
  life of the archive. A wrong statement on an event page is reachable indefinitely, and
  the people most likely to reach it later are the ones investigating what went wrong.
- **The statement may already have been sent.** The curated states are exactly the ones
  users care about most; if a curated `officially_contained` is surfaced in any channel and
  is then wrong, the correction has to travel the same channels — and the alert stack's
  entire safety design (budgets, breakers, kill switch, shadow mode) is built for
  detection-driven sends, not editorially-driven ones.

#### 5.5.2 The correction state

Add to GLOSSARY §3's ladder, with the same frozen-string discipline so CI-11 covers it:

- **`curated_correction`** — a first-class state on the statement, not a deletion. The
  original text remains visible, struck or clearly marked as withdrawn, with the correction
  above it and both timestamps shown. Never delete: a vanished statement is worse than a
  wrong one, because it destroys the record that the mistake was made.
- **Copy shape** (English seed; the Bulgarian is the normative one and belongs in
  GLOSSARY): *"Correction, <date>: we previously reported that <authority> declared this
  fire <state> on <date>. That was incorrect — <what is now known>. Source: <link>."*
- **The event's machine state reverts**, and the reversion is subject to the same rules as
  any other transition — in particular it must not manufacture a `new_fire` (CI-5's
  concern, from the other direction).

#### 5.5.3 The send question

**Recommendation:** a curated state change is **never** the sole trigger of a push in v1.
It is shown, not sent. That is a product decision as much as an editorial one, and it is
the conservative reading of R4: the automated path has shadow mode, CI gates, budgets and
a breaker; the editorial path has one tired person and a form. Until the editorial path
has an equivalent of L-1's shadow discipline, it does not get the same reach.

If that is later relaxed — and there is a reasonable case for relaying a *de-escalating*
official statement, since users ask for exactly that — the relaxation needs its own gate:
a two-person rule (ADR-004 already has the concept for manual broadcasts), a mandatory
delay window during which a correction can overtake the send, and a rehearsed correction
push. None of that exists today, which is why the answer for v1 is no.

#### 5.5.4 Downstream copies (R-11)

CP3 counts media embeds as a success criterion, which means our curated statements will be
republished. Two cheap obligations: a short republication note stating what may be quoted
(short quote plus link and timestamp, no re-hosting of official text), and an undertaking
that we notify embedders on correction. The second is only credible if we know who they
are — which the embed registry CP3 already requires for its own counting.

### 5.6 The curation SLA and the two silences (E4)

#### 5.6.1 The SLA

An SLA the operator cannot meet is worse than none, because the product will render a
promise it is breaking. The proposal is deliberately modest and tiered by event
significance rather than by clock:

| Event class | Curation undertaking | Rendering when missed |
|---|---|---|
| **Major** (the ones media and users are already asking about) | Best-effort check of T1/T2 channels at least twice daily during the season | "No curated update since <time>" |
| **Ordinary active** | Curated only if a T1/T2 statement is encountered during a normal sweep | No curation line at all; the automated layer speaks alone |
| **Everything else** | None | As above |

Note what this deliberately is not: it is not "we will tell you when a fire is contained".
It is "when we learn of an official statement, we will show it, and we will always show
you when we last looked". That is a promise a solo operator can keep in a bad week, which
is the only kind worth publishing.

#### 5.6.2 The two silences

This is the single most important UI consequence of this review. Today an event page with
no curated statement and an event page whose curated statement is stale look identical,
and both read as *nothing is happening* — the false-reassurance failure that invariant 2
and theme T10 exist to prevent. The automated layer already solved this problem for data
age (the honest clock) and for source health (GLOSSARY §3b's one degraded slot). The
curated layer must solve it the same way:

- **No curated information yet** → an explicit line: "No official statement recorded for
  this fire." Not an empty region. The absence is a fact and it should be stated.
- **Curated information exists, and it is old** → the statement plus its own age: "Latest
  official statement: 24 Aug 09:00 (2 days ago)." The user compares that against the
  detection clock themselves; that comparison is the product.
- **Curation is behind across the board** → this is a *service* state, not an event state,
  and it belongs in §3b's banner vocabulary alongside the data-staleness banner. It fires
  when the curator's last sweep is older than the season undertaking. Deriving it needs one
  timestamp — "last curation sweep" — which is not currently recorded anywhere. Record it.

The third point is the cheap one with the highest honesty return: one field, updated when
the operator does a sweep, and the product can tell the truth about its own attention.

### 5.7 Cross-border curation (E7)

12's harm scenario H7 is real and specific: a fire on the Greek or Serbian side that
appears to threaten a Bulgarian village, with our map silent on suppression, reads as
"nobody is responding". The mitigation in 12 is copy ("suppression status for events
outside Bulgaria may be unavailable") plus, for major border events, curation from Greek
and Serbian official sources — and the source register for that curation does not exist.

The honest position for v1 is asymmetric and should be published as such:

- **Bulgaria** — the full ladder above.
- **Greece, Serbia, North Macedonia, Turkey, Romania** — T1 sources enumerated (Appendix B
  seeds this), but the undertaking is *only* the standing copy, not a curation promise. We
  do not read Greek fire-service releases daily and should not pretend to.
- **Language is the practical blocker, not policy.** Reading Greek and Serbian official
  statements accurately is a skill this project does not have. Machine translation of an
  operational status term is exactly the place where it fails — the *локализиран* /
  *ликвидиран* distinction has cognates across the region with mismatched meanings. Rule:
  **never publish a translated operational state**; publish the original term, our
  best-effort gloss marked as ours, and the link.

### 5.8 The load nobody has counted (E8)

R-7 is the risk that makes the other recommendations either true or decorative. The
project's most-escalated open question — "solo curation capacity in season" — has been
carried across two review rounds without anyone producing a number, and the 2026 shadow
season is the last cheap opportunity to get one, because the reading has to happen anyway
for the news log.

**The study, in full:** during the 2026 season, for each day the operator does a sweep,
record three numbers — sweep duration in minutes, number of channels checked, number of
statements found. For each major event, record minutes spent on it that day. That is a
line in a text file per day. From it: minutes per major event per day, and the peak-day
total. Multiply the peak by the number of concurrent majors a Sakar-type week produces
(12 §1.4's case studies give the empirical range) and compare to the hours a person with a
day job actually has in August.

The likely finding is that the honest capacity is one or two majors, and that number should
then *set* the §5.6.1 SLA rather than being aspired to. If it does, the answer to the
escalated question is finally designed rather than improvised — which is exactly what
00-summary asked for.

### 5.9 Moderation is the same budget (R-8)

07 §5.7 gates crowdsourced reports on moderation capacity; 05 and 09 both make it a launch
precondition; 12 §8.3 supplies the moderator verification worksheet. All three are right,
and all three quietly assume a moderator exists. The editorial finding is narrower and
harder: **moderation and curation are the same hours**, spent at the same moment — the
peak of a major fire is simultaneously when official statements are densest and when user
reports arrive fastest.

Consequence for sequencing: crowdsourced reports must not ship in the same season as the
first curated statements. Whichever ships first gets the operator's attention; the other
gets a queue that grows silently. Since curation is load-bearing for CER and for the
official-state ladder, and reports are not, **curation ships first and reports wait for a
second person** — which routes this straight into review 18's moderator pipeline.

### 5.10 What WP6's form actually needs (E6)

The plan describes "a single-operator admin form (with an audit row per action) that can
actually set `officially_contained` / `officially_extinguished`". The audit row records
*that* an action happened; these fields record *why*, which is what a correction
investigation needs:

| Field | Required | Note |
|---|---|---|
| Target event | yes | |
| State / statement type | yes | From the frozen §3 vocabulary only — free text is never a state |
| Source tier | yes | T1–T4 select; T4 is rejected by the form for public statements |
| Source URL | yes | |
| Capture | yes | Stored text or screenshot; evidence, never served to users |
| Statement date/time | yes | The authority's timestamp, not ours — they differ and the difference matters |
| Curator | yes | Even with one curator; the field is for the second one |
| Second source | conditional | Required unless a §5.3 exception is selected, and the exception is recorded |
| Justification | yes | One free-text line, for the investigation that may never happen |

Two behaviours: the form **refuses** a public statement whose tier is T4, and it **refuses**
to save without a capture. Both refusals will be annoying at 3 AM in exactly the situation
they exist for.

## 6. Open questions for the team

1. **Who is the named news-log curator for CP1?** The protocol GATES §4 requires must name
   one in September 2026 — under three weeks away — and §5.1 says that person should be
   doing a blinded source-first sweep. If it is the same person who builds the product,
   record the limitation in the protocol rather than pretending it away.
2. **Does a curated state change ever push?** §5.5.3 recommends no for v1. This is a
   product-owner decision and it interacts with the still-open evacuation-relay question
   (12 Q2 → legal) that rounds 1 and 2 both escalated without resolving. The two should be
   decided together, because the answer "quoted relay is safe" makes both easier and the
   answer "it is not" makes both harder.
3. **What is the actual curation capacity?** §5.8's study answers it with evidence from the
   2026 season. Nothing else will.
4. **Is there a second reader before the 2027 season?** Not a moderator — a second person
   who can do a sweep. Everything in §5.6.1 degrades gracefully with one; §5.9 does not.
5. **Does quoting official Bulgarian press releases at length need a licence?** For the
   lawyer session already budgeted in 09 §10; the safe default in §5.4 holds meanwhile.

## Appendix A — Publishable or not: worked examples

| Situation | Verdict | Why |
|---|---|---|
| ГДПБЗН daily bulletin lists a fire near Harmanli as *локализиран* | **Publish** as `officially_contained`, quoted and linked | T1, exception 1 |
| Municipal Facebook post says "пожарът е овладян" ("brought under control"), no ГДПБЗН text | **Publish with care**: T2 de-escalating, single source allowed — but *овладян* is not one of the two official states, so it is quoted verbatim as a municipal statement and mapped to no machine state | §5.2 note 1; §5.7's translated-state rule applies within Bulgarian too |
| Regional news site: "the fire is heading toward the village" | **Do not publish** | Prediction of fire behaviour (§5.3) |
| Two national outlets, both quoting the same БТА item, report 3,000 дка burned | **One source, not two** — publish only if a named official is quoted, and attribute to the outlet with both units (дка and ха) | §5.3 independence; 12's units rule |
| A user reports flames visible from a road | **Not publishable**; a T4 lead that sends the curator to T1/T2 | §5.2 T4 |
| ГДПБЗН declares *ликвидиран*; our detections continue in the same pixel | **Publish the official state and the detections side by side**, dual-fact copy, as GLOSSARY §3/S12 already specify | The contradiction is the information |
| We published a `officially_contained` from a municipal post; the municipality deletes the post and says it was premature | **Correct**, do not delete; §5.5.2 copy; the capture is now the only evidence the post existed | R-3 |
| A Greek fire 4 km from the border, Greek fire service posts a status | **Show the standing cross-border copy**; do not translate the operational state | §5.7 |

## Appendix B — Source register seed

To be maintained as a real file when E1 lands; enumerated here so the work is not started
from zero. Channel URLs are deliberately not pinned in this review — they change, and a
stale list in a review is worse than a live list in a register.

- **T1 Bulgaria:** ГДПБЗН (national bulletin, regional directorates); МВР press centre;
  municipal official sites for the fire-exposed municipalities of the SE grass–shrub and
  SW conifer regions (12 §1.2); ИАГ and the six state forestry enterprises; ДВ for
  emergency-situation declarations.
- **T2 Bulgaria:** the same institutions' Facebook pages — in practice the fastest and
  most detailed channel, and the most ephemeral (12 §2.4).
- **T3 Bulgaria:** БТА; national broadcasters; the established regional outlets in the two
  fire regions.
- **T1 neighbours (context only, no undertaking):** Greek Fire Service and Πολιτική
  Προστασία; Serbian МУП Sector for Emergency Management; North Macedonian ЦУК; Turkish
  OGM and AFAD; Romanian IGSU.
- **Regional context, not a source of official states:** EFFIS and GWIS news items; the
  Charter and Copernicus EMS activation lists — the activation itself is a publishable
  fact ("EMS was activated for this fire on <date>"), which is a genuinely useful,
  verifiable, non-authoritative signal of scale.
