# Review 17 — Hardware, RF & field engineering

*Reviewer role: senior hardware / RF & field-systems engineer. Date: 2026-08-25. Status: complete.*
*Inputs reviewed: `docs/DATA-SOURCES-EXTENDED.md` Parts I, L and M, `docs/OPERATIONS.md`,
`docs/RISKS.md`, `docs/IMPLEMENTATION-PLAN.md`, `reviews/03-geodata.md` §5,
`reviews/04-sre.md` §5 and §6, `reviews/10-business-gtm.md` §8. Project is in implementation (WP0–WP1).*

---

## 1. Summary verdict

**CONDITIONAL GO on the €100–400 dish; HOLD on everything else — and the condition is a
written rule about ownership that does not currently exist.**

This is the newest seat in the corpus and the only one that could not have been filled in
July. It was created in August by `DATA-SOURCES-EXTENDED.md`, which put three classes of
physical equipment inside the plan horizon — a EUMETCast receive station in Wave 2, LoRa
nodes and a camera tower in Wave 5, an X-band tracking station as the declared ceiling in
Wave 6 — and by one question in `04-sre.md` that has been open since July and never
answered: *"EUMETCast (satellite dish + DVB hardware — a physical ops dependency at
someone's house?)"*. The question mark is the finding. The recommendation to buy exists;
the answer to what buying means does not.

The purchase itself is correct. §I1's analysis is the strongest cost/benefit argument in
the whole source survey: ~€100–400 one-off, €0 recurring, no new licence category, no new
false-positive model, and it attacks 1–3 h → 10–30 min on the metric users actually feel.
An RF engineer would sign that off without hesitation. What an RF engineer would *not*
sign off is the surrounding silence.

Five structural findings:

1. **The ops model changes and nobody has said so.** `OPERATIONS.md` describes one VM in
   a datacenter with an IaC-rebuildable host and a documented restore. A dish means a
   **second production site, in a residence, with no redundancy, no remote hands, no SLA,
   no rebuild path, and a physical dependency on one person's roof** — precisely the shape
   R2 (key-person, High × High) was written about. That is not an accessory to the ops
   contract; it is an amendment to it (§5.2, R-1).
2. **The cost model prices the box and not the tail.** €100–400 is the capital line.
   Mount, cable, surge protection, a machine that stays on, its electricity, its
   replacement in year four, and — dominating everything — the operator hours to install,
   align, and diagnose it, are not in any budget. R3's ≤ €25/mo ceiling has never been
   tested against a physical asset (§5.4, R-2).
3. **The single thing that decides whether the purchase works is unstarted.** The link
   budget at the actual site. §I1.1 flags it as UNVERIFIED and "no longer cost-deciding" —
   correct on price, wrong on risk. Antenna size is not the risk; **an obstructed or
   marginal site is**, and no amount of dish diameter fixes a building to the south or a
   Ku-band margin that collapses in the summer convective storms that arrive in exactly the
   season the station exists to serve (§5.3, R-3).
4. **The €15–40k X-band ceiling is priced as if capital were the obstacle.** It is not.
   The obstacles are a site with clear sky at low elevation, a motorised tracker that must
   survive weather unattended, permits, power, and a maintenance owner — and, uniquely
   here, the fact that receiving Fengyun downlink is trivially easy while *republishing*
   what it contains is legally unresolved (§H2.4). A project can build the station and
   still not be allowed to use it (§5.7, R-4).
5. **The sense side is a fleet, and fleets have a different failure model than software.**
   Five LoRa nodes and one camera tower are not "a pilot" in the software sense — they are
   assets in the field that corrode, get stolen, get struck, run out of battery in
   December, and require a drive to fix. Part L costs them at €40–900 each and the true
   annual cost is dominated by travel and by the fact that a dead node reports nothing,
   which looks identical to no fire (§5.8, R-5, R-6).

The GO condition is §5.1's ownership rule: a written test that every proposed physical
asset must pass before money is spent. It takes one page and it is the artifact that
prevents the failure mode this seat exists to prevent — which is **buying first**.

## 2. Strengths (technically sound as proposed)

- **The latency ladder (§I0) is correct and honestly priced.** Every rung has a real cost
  and a real gain, the US-only rungs are marked unavailable rather than aspirational, and
  the €50 SDR option is priced and rejected on the merits (§I3) instead of being ignored.
  That is unusually disciplined for a document written by someone who clearly wants the
  hardware.
- **Basic versus HVS was resolved with the right evidence.** Channel E1B-SAF-2, PID 500,
  Transponder 1 — a specific, checkable answer that removes €400–800 from the decision.
- **The vendor was believed over the documentation on antenna size**, with the conflict
  recorded rather than hidden. That is exactly the right call: a vendor who ships stations
  has to be right about them, and the reasoning is auditable later.
- **Receive-only is the right RF posture.** Everything in Wave 2 is a receiver. No
  transmitter means no emissions licence, no interference liability, no coordination — the
  single largest regulatory simplification available in this domain, and the corpus arrived
  at it without needing to be told.
- **The camera-tower insight is genuinely good field engineering.** "Siting is usually the
  hardest and most expensive part of a camera network, and much of it already exists" —
  the disused горски наблюдателни кули and telecom masts — is the observation that makes
  §L3 plausible where §L1's arithmetic makes gas sensors impossible. It is also the
  observation that turns the problem from an engineering one into a partnership one, which
  is the correct conclusion.
- **Drones are out of scope, in writing** (§L4). Every wildfire project has this argument;
  having it once and recording the answer is worth a page of anything else.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | **Hardware-commitment creep**: physical assets enter the system one justified purchase at a time, and the ops model, the key-person risk and the cost ceiling absorb the change silently | §5.1, §5.2 |
| R-2 | **High** | Total cost of ownership is unmodelled — capital is priced, the tail (power, replacement, hours, travel) is not; R3's €25/mo ceiling has no physical-asset clause | §5.4 |
| R-3 | **High** | No link budget and no site survey; the purchase can arrive and not work, and the failure will surface as intermittent loss during summer storms rather than as a clean failure | §5.3 |
| R-4 | **High** | A received-but-unpublishable stream: Fengyun reception is technically open, redistribution terms are UNVERIFIED and gating — capital spent ahead of a licence answer is capital at risk | §5.7 |
| R-5 | **Medium-High** | Field assets fail silently; a dead sensor and a quiet forest produce identical data, which is the false-reassurance failure mode arriving through hardware | §5.8.4 |
| R-6 | **Medium-High** | No maintenance owner, no spares policy, no travel budget for any field asset; "someone will drive out" is not a plan for an asset 200 km away in August | §5.8.5 |
| R-7 | **Medium** | Regulatory position for receive-only stations and for any mast is assumed, not checked (КРС / ЗЕС, ЗУТ, aviation obstacle marking) | §5.6 |
| R-8 | **Medium** | Physical liability is uninsured and unexamined: a mast, a lithium battery or a mains installation owned by a fire-safety product | §5.9 |
| R-9 | **Medium** | The EUMETCast ingest path into the existing pipeline is undesigned — a second, differently-shaped source with no CSV, no HTTP poll, and no place in the current adapter model | §5.3.5 |
| R-10 | **Low-Medium** | No decommissioning plan: CP3's sunset branch archives data and publishes it, and says nothing about the physical assets or where the dish goes | §5.10 |
| R-11 | **Low** | Lightning and surge protection unaddressed for an outdoor antenna feeding a machine on the same mains as everything else the operator owns | §5.5.3 |

## 4. Detailed recommendations

Tags: **[MVP]** = before any hardware purchase; **[v1]** = before the 2027 season;
**[v2]** = later or conditional.

- **H1 [MVP] (R-1): adopt the four-question ownership rule** (§5.1) and record it as an
  addendum to `OPERATIONS.md`. No physical asset is bought until it passes all four.
- **H2 [MVP] (R-3): do the site survey before the order, not after.** Compass, inclinometer
  and a phone are sufficient for a go/no-go (§5.3.2). One hour of work that can prevent
  a purchase.
- **H3 [MVP] (R-2): price the three-year TCO, not the box** (Appendix B). If the honest
  three-year figure is above ~€25/mo amortised, R3 has been breached and the business
  review owns the decision, not this one.
- **H4 [MVP] (R-1, R-9): declare the station non-load-bearing in writing.** EUMETCast is a
  **latency improvement layered over** the FIRMS path, never a replacement for it. The
  system must be provably correct with the dish unplugged — which is also what makes the
  residence problem survivable (§5.2.3).
- **H5 [v1] (R-9): design the ingest path before ordering** — a file-drop adapter with a
  spool directory, not a poller (§5.3.5). It is small, but it is not zero, and discovering
  it after the hardware arrives wastes the hardware's whole first season.
- **H6 [v1] (R-7): ask КРС the receive-only question in writing** and record the answer
  (§5.6). One email. The expected answer is "no licence required"; an assumed answer is
  worth nothing when a neighbour complains about a dish.
- **H7 [v1] (R-5): every field asset gets a heartbeat before it gets a sensor** (§5.8.4).
  A node that has not reported is an incident, and the health surface already has the
  vocabulary for it (`OPERATIONS.md` §2, and the dead-man's-switch pattern already in the
  worker).
- **H8 [v2] (R-4): no X-band capital until the Fengyun licence resolves** — the sequencing
  §I2 already states, restated here as a rule with an owner rather than a verdict.
- **H9 [v2] (R-6, R-8): before the first field asset leaves a desk**, name a maintenance
  owner, a spares budget, a maximum travel radius, and check whether household insurance
  covers an outdoor installation used commercially (§5.9).
- **H10 [v2] (R-10): write the decommissioning line into CP3's sunset branch** — three
  sentences, and it makes the sunset branch honest.

## 5. Hardware, RF & field-engineering deep dive

### 5.1 When may this project own physical equipment? (H1)

The corpus has no rule, so purchases will be justified individually and the aggregate will
never be examined. This is the mechanism of R-1: every step is defensible, the destination
is not. The rule is four questions, and an asset must pass all four:

1. **Does the system remain correct if this asset is unplugged forever?** If no, the asset
   is load-bearing and the answer is no — a single unattended device in a residence cannot
   be load-bearing for a public safety-adjacent service. (EUMETCast: yes, it remains
   correct — §5.3.5. A sole camera tower feeding detections: only if its output is clearly
   scoped as one source among many.)
2. **Is there a named person who will physically service it, and is the site within their
   reach in the season?** Not "we", not "someone". A name and a distance.
3. **Is the three-year total cost, including hours at a stated rate, inside the ceiling
   R3 sets?** Capital alone is not an answer.
4. **If the project stops tomorrow, what happens to it?** A dish comes off a wall. A mast
   on someone else's land with a battery in it is a liability with a legal owner.

Applied today: **EUMETCast passes all four** (unplugged-safe, at the operator's own
address, ~€10/mo amortised, comes off a wall). **A camera tower passes 1 and 4 and fails
2 and 3 unless a partner owns the site** — which is exactly why §L3's conclusion is
"partnership", and why that conclusion should be a rule rather than an observation.
**X-band fails 2, 3 and 4 today**, which matches its Wave 6 placement.

### 5.2 The residence-as-datacenter problem (R-1)

#### 5.2.1 What actually changes

`OPERATIONS.md` describes a host contract with properties that all quietly assume a
datacenter: rebuildable from IaC, restorable from documented backups, reachable when the
operator is not there, on power and network someone else guarantees. A EUMETCast station
has none of those. It introduces:

- **A second production location** whose address is a home address — with everything that
  implies for the transparency page, for the entity question (10 Q1), and for what a
  hostile party can find out.
- **A dependency on domestic power and domestic internet**, neither of which has an SLA,
  both of which fail in the same summer storms that produce the fires.
- **No remote hands.** A wedged receiver at 3 AM while the operator is 300 km away is not
  recoverable, and it fails during the season by construction, because that is when the
  operator travels least and the weather is worst.
- **A physical single point of failure attached to a person**, which is R2 expressed in
  aluminium.

#### 5.2.2 What does *not* change, and why that is the whole answer

The station is a **latency accelerator on data we already receive by another path**. The
FIRMS poller keeps running. The Data Store pull keeps running. If the dish is unplugged,
the product degrades from 10–30 min to 1–3 h — which is the product we are shipping in
2027 anyway.

That single property is what makes the residence problem acceptable, and it is why H4
insists it be written down. The moment anyone treats the dish as the primary path — because
it is faster, and it will be tempting — the residence becomes load-bearing and question 1
of §5.1 flips. This is the creep in R-1, in its most likely concrete form.

#### 5.2.3 The rule, stated plainly

> The EUMETCast station is an optional accelerator. Every alert, every event, and every
> published surface must be reachable, correct and timely-enough on the internet paths
> alone. No code path may depend on the station's presence; its absence is a degraded-source
> banner, never an outage.

That sentence belongs in `OPERATIONS.md`, and it converts a critical ops risk into a
monitoring row.

### 5.3 The EUMETCast station: what has to be true (R-3)

#### 5.3.1 The RF chain, and where it fails

Ku-band, EUTELSAT 10A, DVB-S2, receive-only. Chain: dish → LNB → coax → DVB-S2 receiver
(the Novra S401 Pro, per §I1) → IP → TelliCast client on a machine → files on disk. Five
failure surfaces, in the order they actually bite:

1. **Obstruction** — a tree, a building, a neighbour's extension. Binary, and no equipment
   fixes it. It is also the one that changes over years, because trees grow.
2. **Pointing** — a Ku dish is unforgiving; tenths of a degree matter. This is a
   half-day job for someone who has never done it, and 20 minutes for someone who has.
3. **Rain fade** — the loss that arrives exactly when it hurts most. Ku-band attenuates in
   heavy rain, and Bulgarian summer convective storms are the heavy-rain case. §I1's
   "1.8 m recommended to minimise rain fade" is the vendor telling us this and it should be
   read as a requirement rather than a preference (§5.3.3).
4. **Cable, connectors and water ingress** — the classic outdoor failure. Weatherproofing
   an F-connector properly is a five-minute job that, done badly, produces an intermittent
   fault six months later that reads like a software bug.
5. **The receiving machine** — an always-on host with a licence key, a client daemon, and
   disk that fills. This is a small server in a house, and it needs the same monitoring as
   any other host.

#### 5.3.2 The site survey (H2) — an hour, before spending anything

EUTELSAT 10A is at **10° East**. From Sofia (~42.7° N, 23.3° E) the look direction is
**south, slightly west**, at a **mid-elevation angle in the mid-30s of degrees** — enough
to clear low obstacles, not enough to clear a building. Both figures are geometry, and both
must be computed for the actual coordinates rather than taken from this review; every
dish-pointing calculator does it, and the vendor supplies the exact azimuth/elevation for
a postcode.

The survey is: stand at the proposed mounting point, face that azimuth, measure the
elevation to the top of anything in the way. If nothing intrudes on the path with a few
degrees of margin, the site passes. If something does, the site fails and the purchase
stops — no dish size fixes an obstruction.

Also recorded during the survey, because a second visit is wasteful: mounting surface and
what it is made of, cable run length to the machine, whether the run crosses a lightning-
exposed edge, mains availability at the machine end, and whether the mount is visible from
the street (§5.6 and §5.9 both care).

#### 5.3.3 Sizing, and the argument for buying the bigger dish

§I1.1 records a source conflict on antenna size and follows the vendor: 1.25 m or 1.8 m
for Basic, 1.8 m recommended against rain fade. This review agrees and goes further —
**buy 1.8 m unless the site physically cannot take it.**

The reasoning is availability, not signal. A link that works in clear sky and drops in
heavy rain is not a 95 %-available link; it is a link that is **absent precisely during
the convective storms that both start fires (dry lightning) and accompany the season**.
Extra aperture is the cheapest availability money can buy — the delta is tens of euros
against a purchase whose entire value is timeliness during the worst weeks of the year. The
only reasons to take 1.25 m are a mount that cannot carry 1.8 m, a wind-load or planning
constraint, or a visual objection from whoever owns the wall.

#### 5.3.4 Operating it as a host, not an appliance

The receiving machine is production infrastructure and should inherit the existing
practice rather than invent one: unattended security updates, disk-space alarm (TelliCast
writes continuously and a full disk is the most likely first outage), a heartbeat into the
same monitoring that the worker already uses, and — the one that is always forgotten — a
**recorded copy of the TelliCast licence key and the receiver configuration**, stored where
`EXTERNAL-ACCOUNTS.md` records everything else, so the station is rebuildable by someone
who did not build it.

#### 5.3.5 The ingest path is a different shape (R-9, H5)

Every source in the system today is pulled: an HTTP request returning CSV or JSON, on a
cadence, into a validating adapter. EUMETCast is **pushed**: a multicast stream that a
client daemon turns into files appearing in a directory. There is no request, no poll, no
HTTP status, no retry, no "the source is down" — there is only a directory that stops
filling up.

The adapter this needs is a **spool watcher**: files land, are read once, are moved to a
processed area, and are never re-read; partial files are ignored until complete; the
absence of new files for longer than a threshold is a freshness-budget breach rather than
an error. It fits the ports-and-adapters model cleanly — it is a different adapter behind
the same port — but it is genuinely new code, and it must exist before the hardware is
useful. Ordering hardware first is how a station sits in a box until October.

Two properties to design in from the start: **the same detection arriving twice** (once
fast via EARS, once slow via FIRMS) must deduplicate to one event, which the existing
identity rules should already handle but must be tested against; and the **provenance of a
detection must record which path delivered it**, or the latency improvement can never be
measured and the entire purchase is unevaluable.

### 5.4 What it actually costs (R-2, H3)

The €100–400 is the box. Three-year ownership, honestly:

| Line | Estimate | Note |
|---|---|---|
| Dish, LNB, mount, cable, connectors | €80–200 | 1.8 m offset dish, standard TV hardware |
| DVB-S2 receiver | €200–400 | The vendor default is the expensive end |
| Surge protection + grounding | €20–60 | §5.5.3; skipping this is the classic false economy |
| Receiving machine | €0–150 | A second-hand mini-PC or an existing always-on box |
| Electricity, 3 years | ~€30–60 | A ~10 W always-on machine at Bulgarian domestic rates |
| Installation labour | 4–8 h | The dominant real cost, and it is operator hours in a project whose top risk is operator hours |
| Maintenance | 1–3 h/yr | Re-peaking after storms, disk, updates |
| Replacement risk | ~20 % over 3 yr | LNBs die; receivers less often |
| **Three-year total** | **~€350–900 + ~10–20 h** | **≈ €10–25/mo amortised, plus the hours** |

Against R3's ≤ €25/mo ceiling for *all* fixed costs, this is not negligible: it is
comparable to the entire infrastructure line. It is still worth it — it is the only
purchase in the document that buys a step change in the metric users feel — but it should
be recorded as **a budget decision that consumes headroom**, not as a rounding error. And
the hours belong in R2's column, not in a materials budget.

### 5.5 Failure modes, and what they do to the ops contract

#### 5.5.1 The failures, ranked by likelihood

| Failure | Likelihood | Symptom | Response |
|---|---|---|---|
| Disk full on the receiving machine | **High** | Stream stops silently | Alarm at 80 %; retention policy on the spool |
| Rain fade | **High**, seasonal | Minutes-to-hours of gaps in bad weather | Expected, not an incident; bigger dish reduces it |
| Domestic internet or power outage | Medium | Everything stops | Degraded banner; FIRMS path unaffected |
| Pointing drift after a storm | Medium | Gradual quality loss, then dropout | Annual re-peak; signal-quality trend in monitoring |
| Water ingress at the connector | Medium, delayed | Intermittent, months later | Weatherproof properly on day one |
| LNB failure | Low-Medium | Total loss | ~€20 spare on the shelf |
| Receiver failure | Low | Total loss | Weeks of lead time — accept the outage |
| Lightning | Low | Total loss, possibly of more | §5.5.3 |

The pattern worth naming: **most of these are silent or gradual**. A poller that fails
returns an HTTP error; a dish that fails just stops being early. The freshness budget must
therefore be per-path — "EARS-VIIRS has delivered nothing for N minutes" — and not merely
per-product, or the station can be dead for a week while the product looks healthy because
FIRMS is still arriving.

#### 5.5.2 What this adds to `OPERATIONS.md`

One monitoring leg (station heartbeat + spool freshness), one runbook page (symptom →
check signal quality → check disk → check daemon → re-peak), one entry in the degraded-
source vocabulary, and the §5.2.3 non-load-bearing rule. That is the complete ops delta,
and it is small — *because* the station is non-load-bearing. Any design that makes it
load-bearing multiplies this section.

#### 5.5.3 Lightning and surge (R-11)

An outdoor antenna on a mast, cabled into a machine that shares mains with a residence, is
a lightning-coupling path. In a country with real summer thunderstorm activity, and for a
project whose failure weeks are storm weeks, this is not paranoia. The mitigation is
cheap and standard: bond the dish mount to earth, fit an inline coax surge arrester at the
building entry, and put the receiving machine on a surge-protected outlet. Tens of euros,
once, and the alternative risk is not the receiver — it is everything else on that mains.

### 5.6 The regulatory position (R-7, H6)

Three questions, currently all assumed:

1. **Receive-only earth station licensing.** Receive-only satellite terminals are
   ordinarily exempt from individual authorisation across the EU, and EUMETCast is a
   consumer-grade Ku installation indistinguishable from satellite TV. The expected answer
   is that no КРС authorisation is needed under the ЗЕС framework. **UNVERIFIED** — worth
   one written enquiry, precisely because the expected answer is boring and a recorded
   boring answer costs nothing to have.
2. **Structures.** A dish on a residential wall is normally outside ЗУТ permitting; a
   free-standing mast for a camera tower is normally inside it, and on protected or forest
   land there are further consents. This distinction is what separates §I1 from §L3 in
   effort by an order of magnitude and it should be stated wherever the camera tower is
   discussed. **UNVERIFIED for the specific case.**
3. **Aviation obstacle marking.** Only relevant above the height thresholds, i.e. never
   for a dish and possibly for a mast — but firefighting aviation flies low over exactly
   the terrain a fire-watch tower would occupy, which makes this a safety question and not
   only a compliance one. If a tower is ever built on a ridge, this gets checked properly.

A fourth, softer, and the one most likely to bite: **whoever owns the wall**. A landlord,
a condominium association (етажна собственост), or a neighbour with an opinion. Cheaper
to ask than to remove.

### 5.7 X-band: what €15–40k does not include (R-4, H8)

§I2's revised verdict is right — the Fengyun block is the only thing that justifies a
tracking station, and it genuinely would take Bulgaria from ~6 to ~12–14 fire-capable looks
per day. The correction this seat adds is about what the capital number omits:

- **A site.** A 2.4–3.7 m motorised tracker needs a foundation or a strong roof, clear sky
  down to low elevations in *all* azimuths (a tracker follows a pass horizon to horizon;
  an obstruction on one side of the sky costs whole passes), and it must survive wind and
  ice unattended. This is not a residence. This is a small facility.
- **Permits and ownership of that facility**, per §5.6.
- **Power and network at that facility**, sized for a continuous ingest server.
- **A maintenance contract or a person**, because a motorised tracker has moving parts
  outdoors and moving parts outdoors fail.
- **Processing.** IPOPP and CSPP are free and produce VIIRS active fire locally; **Fengyun
  processing software is UNVERIFIED**, and this is the hidden cost. If a Fengyun L0→L2
  chain must be built or licensed, the software effort could exceed the hardware.
- **And the gating one: the licence.** Reception is technically unrestricted; the
  redistribution terms for a European commercial-in-trajectory service are UNVERIFIED
  (§H2.4). Spending €15–40k to receive data the project may not publish is the single
  worst outcome available in this document.

The sequencing therefore stands, with an owner attached: **licence answer → operational
customer or grant → site and maintenance owner → capital.** The order is not negotiable
and no step may be started on the expectation that a later one resolves.

### 5.8 Field engineering for the sense side (R-5, R-6)

#### 5.8.1 The economic asymmetry is correctly identified, and it should drive everything

"One camera sees tens of kilometres, one gas sensor sees 100 metres" is the sentence that
should end every gas-sensor conversation this project ever has. §L1's own arithmetic —
~€2.0 M to cover 1 % of Bulgarian forest — settles it. Dryad is a partnership or it is
nothing, and the DIY LoRa nodes in §L2 are correctly scoped as **a learning exercise, not
a data source**. This review endorses both verdicts without qualification and adds only
that the learning is real and worth the €500: siting, power budgets, mesh range in terrain
and gateway placement cannot be learned from a datasheet, and they are prerequisites for
ever evaluating a sponsored deployment competently.

#### 5.8.2 Power is the thing that kills field deployments

Solar sizing is done for the worst month, not the average. In Bulgaria that is December —
short days, low sun, snow on panels — while the fire season is June–September. A node
sized for August dies in January and the operator discovers it in June. Either size for
December (bigger panel, bigger battery, more cost) or **declare the deployment seasonal
and plan a spring recommissioning visit**. The second is cheaper and honest; the first is
what people accidentally choose by not deciding.

Second-order, and routinely missed: **lithium cells lose capacity in cold and degrade
faster when charged below 0 °C**. A node that "worked fine in the autumn" fails after its
first winter. LiFePO₄ tolerates the abuse better than Li-ion, at a small cost premium.

#### 5.8.3 The other field realities

Theft and vandalism (anything visible and portable in a remote location; a solar panel is
a stealable object). Animals and insects (wasps in enclosures, rodents on cable). Wind
loading on anything mounted high. Enclosure sealing versus ventilation — a sealed box in
sun cooks its electronics, a ventilated one lets water in; both fail. Connectivity: 4G
coverage in forest valleys is not the coverage map's coverage. And access: the site that
is a pleasant walk in May is a different proposition in the smoke of an August afternoon,
which is the one time anyone would want to visit it.

#### 5.8.4 Silent failure is the fire-domain-specific hazard (R-5, H7)

A dead sensor and a quiet forest produce the same data: nothing. In a product whose
number-one harm is false reassurance (invariant 2), a field asset that fails silently is
worse than no field asset, because a polygon on the map implies observation that is not
happening.

The rule is therefore stricter than for software: **every field asset heartbeats
independently of its measurement**, and a missed heartbeat degrades the asset's coverage
claim in the UI within one interval — not "the sensor is down" in a log, but the polygon
no longer claiming to be watched. This must be built with the first node, not retrofitted
to the fifth, because it is a data-model property and not a monitoring feature.

#### 5.8.5 Maintenance is the real cost (R-6, H9)

Per asset, per year, honestly: one or two site visits, fuel and hours, a spares stock that
must exist before the first failure (a spare node is cheap; a two-week wait in August is
not), and a named owner. For a single tower on a partner's mast within 50 km this is
tolerable. For nodes scattered across a region it is a job.

Which yields the sequencing rule: **the number of field assets is capped by the maintenance
capacity of one person, not by the budget.** Given R2, that cap is low single digits —
and it should be written as a number in the plan rather than discovered by acquiring a
fleet nobody can service.

### 5.9 Liability, insurance and the optics (R-8)

Three exposures nobody has looked at:

- **Physical harm.** A mast falls, a dish detaches, a battery vents. Whoever owns the
  installation owns the consequence. Household insurance typically excludes equipment used
  for a business, and the entity question (10 Q1) determines who "owns" anything at all.
- **The specific irony.** A lithium battery in a solar enclosure in dry forest, owned by a
  wildfire-safety product, is the one ignition source in this document that would be
  genuinely unsurvivable reputationally — a strictly worse R4 than any missed detection,
  because it would be our fire. It argues for LiFePO₄, a proper enclosure, and siting away
  from fine fuels, all of which are cheap.
- **Land and consent.** Anything on someone else's land needs a written agreement covering
  access, removal, and what happens if the project ends — which is §5.1's question 4 in
  legal form.

None of this blocks the dish. All of it blocks a tower, and it should block it *before*
the tower is exciting rather than after.

### 5.10 Decommissioning (R-10, H10)

CP3's ≤1-of-4 branch converts the project to a donation-funded civic effort or sunsets it
gracefully, with data archived and published. It says nothing about atoms. Three sentences
fix it: the dish comes down and the receiver is sold or donated; any partner-hosted asset
is removed within an agreed window under the §5.9 agreement; no asset is left powered and
unattended on someone else's land. An abandoned sensor on a mountain is a small,
permanent, embarrassing legacy, and it is entirely avoidable by writing this down now.

## 6. Open questions for the team

1. **Whose roof?** The station's location is a decision with address, insurance and
   transparency-page consequences, and it interacts with the still-open entity question
   (10 Q1). It should be answered before the order, not after delivery.
2. **Does the €10–25/mo amortised cost fit inside R3's ceiling, or does it extend it?**
   A business-review decision, not an engineering one — but it must be made explicitly,
   because this is the first physical asset the project has ever considered.
3. **Is the EUMETCast station in scope for the 2027 season at all?** Wave 2 places it in
   season 1, but the ingest adapter (H5) is unbudgeted work in a plan whose critical path
   is already the shadow-season recording. A defensible answer is "buy and install in the
   off-season, integrate for season 2" — which also gives a full winter to shake out §5.5's
   silent failures before they matter.
4. **What is the maximum number of field assets one person can service?** §5.8.5 says the
   cap is maintenance capacity, not budget. Nobody has stated the number.
5. **Who asks КРС, and when?** (H6) One email, no dependencies, and it can be sent today.

## Appendix A — Pre-purchase field checklist

Nothing is ordered until every line has an answer written down.

- [ ] Site coordinates fixed; azimuth and elevation to EUTELSAT 10A computed for **those**
      coordinates
- [ ] Line of sight verified on site, with margin, at the actual mounting point
- [ ] Mounting surface identified; wind loading acceptable for 1.8 m
- [ ] Cable run measured; entry point identified; surge arrester point identified
- [ ] Mains available at the machine end; always-on machine identified
- [ ] Wall owner / condominium consent obtained if not sole owner
- [ ] Receive-only regulatory position recorded (H6)
- [ ] Three-year TCO written down and accepted against R3 (H3)
- [ ] Ingest adapter design agreed, with the dedup and path-provenance properties (H5)
- [ ] The non-load-bearing rule recorded in `OPERATIONS.md` (H4)
- [ ] Spares decided: LNB on the shelf, receiver not
- [ ] The station is in the monitoring plan before it is on the wall

## Appendix B — Three-year cost comparison, all-in

Capital plus tail plus hours, at the same honesty for every row — the comparison Part M's
waves cannot make because they price only the purchase.

| Option | Capital | 3-yr tail | Operator hours | Fits §5.1? | Verdict |
|---|---|---|---|---|---|
| **EUMETCast Basic, 1.8 m** (§I1) | €300–800 | €50–120 | 10–20 h | **Yes, 4/4** | **Buy** — off-season install, season-2 integration |
| DIY LoRa nodes ×3 (§L2) | ~€200 | ~€50 + travel | 20–40 h | Passes 1, 3, 4; 2 is the operator | Build as learning only; never a published source |
| One Pyronear tower (§L3) | €400–900 | Site agreement + travel | 40–80 h + partner negotiation | **Fails 2 and 3 without a partner** | Only as a partnership, season 2+ |
| Dryad micro-deployment (§L1) | €5k–50k | Vendor | Negotiation | Fails 3 outright | Sponsored or not at all |
| X-band station (§I2) | €15–40k | Facility + maintenance | Substantial | **Fails 2, 3, 4** | Blocked on the Fengyun licence; the ceiling, not a plan |
