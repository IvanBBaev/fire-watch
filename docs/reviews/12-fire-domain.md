# Review 12 — Wildfire domain expert (fire behavior + Bulgarian emergency management)

*Date: 2026-07-22. Reviewer role: senior fire-behavior analyst / emergency-management
practitioner, Southeast-European (Bulgarian) fire regimes and civil-protection systems.
Inputs: `docs/ANALYSIS.md`, `docs/reviews/00-summary.md`. Engineering and latency reality
taken as given; this review is about what the data means on the ground, who actually needs
it, and where a well-meaning map can cause harm.*

*Bulgarian terms are given in Cyrillic with transliteration and translation on first use.*

---

## Verdict: CONDITIONAL GO — the product is honest and useful **only** if it stops thinking of itself as a fire-detection service and commits to being a fire-*situation* service

The engineering reviews validated the pipeline. From the domain side, the single most
important truth is this: **the modal Bulgarian fire will be over before your first data
point about it exists.** Most of Bulgaria's ~33,000 annual fire responses are grass and
rubbish fires lasting under a few hours; VIIRS NRT arrives up to 3 h late, 4–6 times a day.
The product will systematically miss, in operational time, the very fires that dominate the
statistics — and that is fine, **provided the product is framed around the fires that
matter**: the multi-hour, multi-day campaign fires that produce ~90% of burned area, the
smoke that affects a hundred times more people than flames, and the situational-awareness
gap between "nothing" and "evacuate now" that official channels demonstrably leave open
(Voden 2024 is the case study of that gap costing houses).

Conditions for GO, from the domain side:

1. **The honest use-case statement (below) goes into ANALYSIS.md and the UI copy.** No
   marketing language may imply first-alarm detection.
2. **The "out" lifecycle is renamed and reworded** — the product may never display
   "out"/"extinguished" from satellite silence. Exact wording tiers in §4; the internal
   `→out` state in the architecture diagram must become `→no-longer-detected` /
   `→archived`.
3. **The never-send message list (§3.4) becomes a hard product policy**, enforced in the
   Notification Gateway templates (ties to review T3).
4. **Agri-burn context tagging ships with the map, not after it** (ties to T5) — a
   March–April map full of red dots labelled "wildfires" over Danubian cropland destroys
   credibility with exactly the professional audience whose tolerance we need.

### Executive summary

- **Fire regime:** Bulgaria's fire season is bimodal — a spring agricultural-burning window
  (March–April) and the main July–September season, with an October stubble echo; the
  season is measurably lengthening. 2024 was the worst year in over a decade (45,435 ha
  mapped by EFFIS across 256 fires); 2025 was worse again, with Bulgaria among the EU's
  most-affected countries. Two fuel worlds coexist: fast grass–shrub fires in the SE hills
  (Sakar, Dervent Heights, Strandzha) and long conifer campaign fires in the SW mountains
  (Pirin, Slavyanka, Rila, Rhodopes) — they need different product behavior.
- **Latency honesty:** at 3 h (polar) / 15–30 min (GEO, large fires only), the product is a
  *tracking* tool, not a *detection* tool. Honest use cases: campaign-fire tracking,
  "is the fire near my village still active / growing", diaspora monitoring, smoke-source
  identification, danger-forecast awareness, post-fire history. Not: first alarm (neighbors
  and 112 beat satellites by hours), evacuation triggering.
- **Institutions:** ГДПБЗН is the operational monopoly and will treat the product with
  indifference-to-suspicion at best — the realistic goal is *tolerance earned by accuracy*,
  not endorsement. The genuinely underserved users are municipal civil-protection staff,
  volunteer formations *awaiting activation*, forestry field units, and rural residents +
  the enormous Bulgarian diaspora.
- **The single biggest harm risk** is not panic — it is *false reassurance*: an empty or
  stale map read as "no fire". Freshness banners (T6) are a domain-safety requirement, not
  a UX nicety.
- **Terminology is a credibility gate:** локализиран (lokaliziran, "contained") and
  ликвидиран (likvidiran, "extinguished/liquidated") are official operational states that
  only ГДПБЗН declares. The product must quote them with attribution and never derive them
  from satellite data.

---

## 1. Bulgarian fire regime — a primer for the team

### 1.1 Seasonality: two seasons plus a lengthening tail

Bulgaria's fire calendar is **bimodal**, and the two peaks are different phenomena:

| Window | What burns | Driver | Product relevance |
|---|---|---|---|
| **March–April** | Dry dead grass from last year, stubble, pruning piles, pasture "cleaning" | Deliberate agricultural burning (illegal but endemic) escaping into forest edges; pre-green-up cured fuels + spring wind | Highest *count* of detections; lowest wildfire signal-to-noise. The map must context-tag these or it cries wolf for a month |
| **May–June** | Little | Green-up; live fuel moisture high | Readiness/education window |
| **July–September** | Everything: harvested grain fields, pasture, shrub, oak coppice, conifer plantations | Heat waves, drought-cured fuels, harvest activity, human ignitions (>90–96% of fires are human-caused) | The season the product exists for. The largest fires of 2024 and 2025 were all in this window |
| **October** | Stubble, late pasture burns; hunting-season ignitions | Post-harvest burning, dry autumns | Second false-positive wave; occasional real escapes |
| **November–February** | Isolated grass/wetland fires in dry winters | Increasingly non-zero — WWF and Silva Balcanica both note fires shifting into autumn/winter | Off-season content; keep pipeline warm |

The scientific literature confirms the pattern and its worsening: fires in SW Bulgaria show
an elevated spring/winter contribution extending risk beyond the classic summer season
(Silva Balcanica 27(1), 2025), and WWF Bulgaria documents >90% human causation and a
lengthening season. Over 2015–2024, Bulgaria recorded **4,835 forest fires burning
62,320.9 ha** — a long-term average forest-fire size of **~12.9 ha**, with the median far
smaller (the mean is dragged up by a handful of megafires).

Legal context worth encoding as product knowledge: **stubble and vegetation burning is
illegal year-round** (Закон за опазване на земеделските земи — Agricultural Land
Protection Act — and annual fire-season orders), yet it is the leading ignition pathway.
Every March the countryside burns anyway. A "likely agricultural burn" tag is therefore
descriptive, not exculpatory — some of those escapes become the year's disasters.

The official **пожароопасен сезон** (pozharoopasen sezon, "fire-danger season") in forest
territories is declared by order — typically April through October/November — by regional
governors on proposal of the forestry authorities. Surfacing "fire season is officially
open in your region" is a legitimate, official-sourced content beat [v1].

### 1.2 Fuel geography: two fire worlds (plus three edge cases)

**World 1 — the Southeast grass–shrub complex (Sakar, Dervent Heights, Strandzha foothills,
Haskovo–Yambol–Burgas hills).** Cured grass, abandoned pasture reverting to thorny shrub
(draka — Paliurus), oak coppice, scattered pine plantations. Terrain is rolling, roads are
sparse, villages are depopulated and elderly. Fires here are **wind-driven, fast, and
short-lived per run**: a grass fire under 40 km/h wind moves at up to ~8 km/h sustained
(the ~20%-of-wind-speed rule for grass; observed range 1.6–17 km/h under critical
conditions — MDPI Fire 5(2):55). That is faster than anyone walks uphill through scrub. A
village can go from "smoke on the horizon" to houses burning in **under an hour** — Voden
2024 residents described the village igniting "like a torch within 10 minutes" of the
fire's arrival. These fires kill people and burn houses, but each *run* is over in hours.
The multi-day versions (Sakar 2025) are sequences of runs and reburns across a huge
perimeter.

**World 2 — the Southwest/mountain conifer complex (Pirin, Slavyanka, Ograzhden, Maleshevo,
Rila and W. Rhodope fringes, Struma and Mesta valleys).** Mediterranean climate influence
penetrates up the Struma valley; fuels are Austrian/Scots pine plantations (20th-century
afforestation — dense, unthinned, ladder-fueled), juniper, oak-hornbeam, and at altitude
natural pine with deep needle duff. Fires here are **terrain-driven campaign fires**:
steep, inaccessible, often burning for weeks with aerial-only suppression windows.
Slavyanka 2024 burned for over a month, unfightable on the ground because of **mined
terrain** on the border strip (a genuinely Bulgarian-Greek problem the team should know
exists); Pirin/Ilindentsi 2025 ran >4,000 ha, entered the national park, forced the
evacuation of ~400 people from Ploski, and took a month to be declared extinguished.

**World 3 — the Danubian and Thracian plains.** Industrial grain agriculture; the fire
regime is stubble and standing-crop fires: enormous, minutes-to-hours fast, economically
painful (a combine or a whole block of unharvested wheat), rarely threatening forests.
Detections here are numerous in July and October and mostly *should not* generate wildfire
alerts, but a stubble fire under wind reaching a village is a real (and recurring) event —
suppression, not classification, is the differentiator.

**Edge cases the product must know:**
- **Maritsa-Iztok lignite basin (Stara Zagora region):** open-pit lignite mines and three
  TPPs; lignite self-heats and smolders when exposed — persistent thermal anomalies that
  are *never* vegetation fires. Already covered by the T5 static hot-source mask; the
  domain addition is that seam/stockpile smolder can persist for **weeks to months**, so no
  time-based logic will ever age it out — the mask must be permanent geography.
- **Wetland/peaty soils (Dragoman marsh, Vitosha and Rila bogs):** rare, but reed/organic
  soil fires smolder for days and produce intermittent detections. Low priority; do not
  auto-archive aggressively there [v2, verify locations against a wetlands layer].
- **Cross-border fires (Greece, Serbia, North Macedonia, Turkey):** the SE and SW fire
  worlds both sit on borders. 2024 Slavyanka and 2025 BG–RS (Rani Lug area) fires crossed
  or threatened to cross. The +100 km AOI buffer in ANALYSIS.md is domain-correct; keep it.

### 1.3 Size and duration reality — and what 3 h latency honestly buys

The numbers the team must internalize:

- ГДПБЗН responded to **47,111 incidents in 2025, of which 33,428 were fires; only 7,910
  (23.7%) caused any direct material damage** (МВР annual report, via ruse.news). The
  overwhelming majority are grass/rubbish/stubble fires measured in decares and hours.
- Forest fires proper: a few hundred to ~1,500 per year depending on the season
  (2015–2024 average ~480/yr), **long-term mean size ~13 ha, median well under 10 ha**,
  typical duration hours to one operational period.
- EFFIS 2024 mapped **256 fires / 45,435 ha** — i.e., the mapped (≥~30 ha) fires are a tiny
  minority of all fires but carry essentially all the burned area; **two fires of ~8,000 ha
  each plus 15 fires >500 ha produced most of the 2024 damage** (JRC annual report via
  Sofia Globe).

Now the brutal arithmetic. A typical Bulgarian fire ignites early-to-mid afternoon (peak
human activity + peak fire weather). Suppose ignition at 14:00:

- Next VIIRS overpass may be ~13:30 (just missed) → next chance ~01:30, or an afternoon
  Aqua/NOAA pass ~14:30 if lucky. Add up to 3 h NRT processing → **first polar data point
  between ~17:00 and next morning.**
- MTG FRP-PIXEL (10-min cadence, 15–30 min latency) sees the fire only once its flaming
  front is intense enough for a ~2 km pixel — in practice a well-developed fire of at least
  a few hectares of active flame, sooner in grass under wind, possibly never for a
  smoldering 2-ha oak-litter fire.
- Meanwhile: a neighbor called 112 at 14:05, the РСПБЗН engine rolled at 14:10, and the
  modal fire is **out before our first pixel exists**.

**Therefore, fires the product will never show in operational time:** the ~90%+ of fires
that are small, short, and quickly suppressed — including, painfully, the first hour of a
Voden-type village-destroying wind run. **Fires the product will show, and show well:**
anything that survives into a second satellite pass — which is precisely the set of fires
that grow, escalate, force evacuations, burn for days, and make the news. For those, the
product offers something no official channel currently gives the public: continuously
updated location, extent, growth direction, intensity trend, and freshness-honest status.

### The honest use-case statement (adopt verbatim)

> Fire Watch is a **situational-awareness and tracking service for developing and ongoing
> fires**, built on satellite data that is minutes-to-hours behind reality. It will usually
> not be the first to know a fire has started — people on the ground and 112 are. It exists
> to answer: *"the fire I heard about — where is it, how big, which way has it grown, is it
> still being detected, and what is the danger level around me today?"* It is not a
> life-safety alarm, it never declares a fire out, and in an emergency 112 and official
> evacuation orders always come first.

### 1.4 Case studies: 2024–2025 as the design corpus

**Voden, July 2024 (Yambol region, Dervent Heights/SE grass-shrub world).** A wind-driven
fire overran half the village on 18 July 2024: 15 houses destroyed, ~20 damaged, ~250 ha of
forest plus agricultural land burned; residents self-evacuated with flames in sight.
**BG-ALERT was never triggered** — officials cited power and coverage failures, publicly
disputed (Mediapool: "the fire in Voden and the enormous failure"; the same article claims
the siren/alert infrastructure covers only ~52% of territory). Domain lessons for us:
(a) the official warning chain can fail exactly when needed; (b) satellite latency means we
would *also* have been late for the initial run — honesty requires admitting both;
(c) where we *would* have helped: the fire burned in the area for days — "still active /
growing toward X" tracking, and the danger-forecast layer screaming extreme days in
advance.

**Slavyanka/Orvilos, July–August 2024 (BG–GR border, mountain conifer world).** Started
~mid-July (Greek side, suspected lightning), burned **30+ days**, ground crews blocked by
**mined border terrain**, aerial suppression only for weeks (Greek helicopters; Swedish
planes via the EU mechanism; Bulgarian military helicopter, ~120+ personnel when it crossed
into Bulgaria near Senokos). Lessons: (a) multi-week events are normal in the SW mountains —
event lifecycle and reignition windows must accommodate a month, not a week; (b) cross-
border events need seamless display across the border with the caveat that suppression
status on the other side is opaque; (c) for such fires the product is at its best — nobody
else gave the public a daily perimeter.

**Sakar, August 2025 (Harmanli/Topolovgrad municipalities, SE world).** Night ignition near
Dositeevo–Kolarovo, wind-driven; partial бедствено положение (bedstveno polozhenie, state
of emergency) declared in Harmanli and later Topolovgrad; a second large fire near
Cherepovo; **over 30,000 decares (3,000+ ha)** of forest, stubble, pasture and shrub
affected per Tribune.bg, with fronts repeatedly re-flaring over days; roads closed.
Lessons: (a) **Bulgarian media report burned area in декари (decares, 1 ha = 10 дка)** —
and routinely confuse units; the product must display both ha and дка in the BG UI and
never inherit media numbers without unit-checking; (b) multiple simultaneous large events
in one district are the norm in a bad week — event clustering must not merge them; (c) road
closures are the most-requested local information we *cannot* reliably provide — link out
to official sources rather than guessing [see §7].

**Ilindentsi/Pirin, July–August 2025 (SW world).** Registered 25 July near Ilindentsi
(Strumyani municipality); >4,000 ha; entered Pirin National Park; on 29 July the regional
governor triggered **BG-ALERT for the preventive evacuation of ~400 people from Ploski**
(they returned two days later); declared fully extinguished only ~a month after ignition
(BTA). Lessons: (a) BG-ALERT *is* used for fire evacuations when the chain works — our
product's job is everything *before and around* that moment, never the moment itself;
(b) "contained — for now" headlines (Novinite) show even journalists live in the
локализиран/ликвидиран distinction; (c) a month-long event with quiet smoldering phases
under canopy will show satellite gaps of days — **non-detection intervals inside an active
event are normal**, which kills any naive "no detections for 48 h → cooling" rule for
mountain fires.

### 1.5 Climate trajectory

- 2024: worst burned area in >a decade — 45,435 ha, exceeding the previous four years
  combined; two-thirds on Natura 2000 land (JRC via Sofia Globe).
- 2025: EU record year (1,079,538 ha EU-27, ~double the 2006–2024 average — JRC); Bulgaria
  again among the most-affected member states by share of territory; WWF counts ~300,000
  decares (~30,000 ha) of forest lost.
- Direction of travel: longer seasons, more winter/spring fires, more simultaneous large
  events, more cross-border events. The product's addressable problem is growing every
  year — which is exactly why credibility discipline matters now, before the audience
  arrives.

---

## 2. Who actually does what in a Bulgarian fire — and what each actor is to us

### 2.1 ГДПБЗН (GDPBZN — Directorate-General "Fire Safety and Civil Protection", МВР)

The operational monopoly. Structure (mvr.bg/gdpbzn): national directorate in Sofia with a
national operational center; **regional directorates (РДПБЗН)** in each of the 28 districts
(Sofia city has the Столична дирекция); beneath them **200+ district services (РСПБЗН —
Rayonna sluzhba PBZN)** with the actual engines and crews. ГДПБЗН is also the lead of the
**Единна спасителна система** (Unified Rescue System) under the Закон за защита при
бедствия (Disaster Protection Act) — i.e., it commands not only its own units but
coordinates everyone else at an incident.

**Escalation ladder in practice:**
1. 112 call → district operational center → local РСПБЗН responds (minutes).
2. Fire exceeds local capacity → РДПБЗН reinforces from neighboring services, requests
   forestry machinery, activates municipal volunteers via the mayor.
3. Multi-municipality / mass-evacuation threat → mayor (municipal) or governor (regional)
   declares бедствено положение; a regional or national щаб (shtab, crisis staff) forms;
   ГДПБЗН national level coordinates; military support and EU Civil Protection Mechanism
   requests go through this level.

**Relationship to the product: potential quiet data consumer; never a "user" we may claim.**
Their operational picture comes from crews on the ground, not satellites; but regional
duty officers *do* look at FIRMS/EFFIS during multi-fire days. Realistic ceiling:
individual duty officers bookmarking the site because it is faster to read than raw FIRMS.
Offer data quietly (§10); never state or imply they use or endorse us.

### 2.2 Доброволни формирования (dobrovolni formirovaniya — municipal volunteer units)

Created by mayors under the Disaster Protection Act; national registry kept by ГДПБЗН
(each formation has a unique code, each volunteer a personal ID number); a National
Programme for volunteer development 2022–2026 exists. Reality check: formations exist on
paper in a large share of Bulgaria's 265 municipalities, but numbers are a few thousand
volunteers nationally [verify exact current count against the ГДПБЗН public registry],
equipment is often minimal (PPE, hand tools, occasionally a donated engine), training
uneven, and activation is legally **only via the mayor / ГДПБЗН** — volunteers are not
self-dispatching responders. Separate from these are NGO/informal groups and the
Национална асоциация на доброволците (NAVRB).

**Relationship: the single best-fit professional user segment.** Between activations they
have no operational picture at all — no TETRA radio, no dispatch feed. A map answering
"is the event near our municipality still active, where has it grown" while they *wait for
activation* is genuinely useful and safe. Risk: encouraging self-dispatch — see §6b/§7.

### 2.3 Forestry system: ИАГ, state enterprises, ДГС/ДЛС

ИАГ (Izpalnitelna agentsiya po gorite — Executive Forest Agency) sets policy and runs
prevention (joint ИАГ–ГДПБЗН inspections are standard pre-season practice — mzh.government.bg).
Operationally the forest estate is run by **six state forestry enterprises** (ЮЗДП, ЮЦДП,
СИДП, СЗДП, ЮИДП, СЦДП) through territorial **ДГС/ДЛС (state forestry/hunting units)**.
Their fire duties: watchtower and patrol detection during the declared fire season,
**first attack in forest territories** (specialized patrol groups, tractors/dozers for
mineralized strips — firebreaks), and supplying heavy machinery to ГДПБЗН-led incidents.
In practice a forest fire is a joint ГДПБЗН + ДГС operation from hour one.

**Relationship: second-best user segment and the most realistic B2B anchor.** A ДГС fire
duty officer with 20,000 ha of estate is exactly the polygon-monitoring customer of the v2
B2B tier; before that, field foresters checking "did last night's storm start anything in
our block" are honest MVP users. They already know EFFIS; our pitch is speed of reading
and alerting, not data they lack.

### 2.4 Municipalities

Mayors carry legal civil-protection duties: municipal disaster plans, volunteer
formations, evacuation orders, declaring municipal бедствено положение, informing the
population. In small municipalities this is one overworked secretary and the mayor's
mobile phone; their public communication channel of choice is **the municipal Facebook
page** — a fact the product should exploit (municipal FB posts are a prime curation
source for incident status [v1]).

**Relationship: user AND distribution channel.** A municipal officer refreshing our event
page during an incident is realistic on day one; a municipality embedding the map on its
site is the cheapest credible distribution we can get [v1 outreach target].

### 2.5 Military and state aviation

The blunt truth: Bulgaria's aerial firefighting capacity is **two to a handful of
airworthy Cougar helicopters with bambi buckets (~2–2.5 t)** at 24th Air Base Krumovo,
chronic pilot shortage (media-reported deficits of ~46% pilots / 57% flight engineers),
an Mi-17 returned to firefighting duty in 2024 after a decade, and a slow program to
equip more Cougars (Mediapool; Svobodna Evropa: "why only two Bulgarian helicopters fight
the fires"). There is no fixed-wing national firefighting fleet. Every serious season
Bulgaria activates the **EU Civil Protection Mechanism** — in 2025 six countries (CZ, SK,
FR, HU, RO, SE) sent aerial assets. rescEU's permanent fleet (12 DHC-515s on order,
Fire Boss aircraft, first rescEU helicopters delivered to RO/SK/CZ for the 2026 season)
will help regionally but nothing is permanently based in Bulgaria [verify seasonal
positioning each year].

**Relationship: bystander.** Air assets navigate by coordinates from the incident
commander, not consumer maps. Do not build for them; do mention aerial operations in
curated incident notes (the public asks "why is no helicopter flying" constantly — an
education content beat).

### 2.6 Summary table

| Actor | Role in a fire | Product relationship | Realistic ask |
|---|---|---|---|
| ГДПБЗН / РСПБЗН | Command + suppression everywhere | Quiet data consumer at best | Tolerance; never claim use |
| Volunteer formations | Mop-up, logistics, patrols — when activated | **Core professional user** | Awareness while awaiting activation |
| ДГС/ДЛС + enterprises | Detection, first attack, machinery in forest | **Core user; future B2B** | Polygon watch zones [v2] |
| Municipalities | Evacuation, population info, volunteers | User + distribution partner | Embed map; curation source |
| Military aviation / rescEU | Aerial suppression (scarce) | Bystander | Education content only |
| Media (BTA, bTV, NOVA, regionals) | Amplification | Consumer of our map (with attribution) | Embeds → growth [v1] |

---

## 3. The official warning landscape — and the gap we honestly fill

### 3.1 What exists

- **112** — the universal emergency number; intake only, no outbound public information.
- **BG-ALERT** — cell-broadcast public warning, nationwide since late 2023, operated by
  МВР/ГДПБЗН. 2025 usage (МВР annual report via ruse.news): **89 activations, of which 36
  for fires, 13 fire-danger warnings, 3 evacuation-readiness, 3 actual evacuations**. It
  works — Ploski 2025 was a successful preventive fire evacuation. Known gaps: it is
  triggered by authorities *when they decide to*, late-stage by design ("prepare to
  evacuate"/"evacuate" territory); older handsets and misconfigured phones miss it;
  coverage/power dependencies failed publicly at Voden 2024; and it carries no map, no
  updates, no "what happened next".
- **Sirens (НСРПО early-warning system)** — acoustic coverage concentrated in cities and
  around hazard sites; large rural areas (exactly the fire country) are outside effective
  coverage [media claim ~52% territory coverage — verify].
- **Media practice** — national TV covers fires that are already disasters, hours late,
  with unit errors; regional outlets and municipal Facebook pages are faster and closer
  but fragmented. There is **no Bulgarian equivalent of US public scanner traffic** — МВР
  radio is encrypted TETRA — so the Watch-Duty-style human curation model must be built on
  official bulletins, municipal posts, and media, not radio monitoring. This is a
  structural difference from the US the team must plan around.

### 3.2 The genuine gap

Between "nothing" (no official signal exists for a developing fire) and "evacuate now"
(BG-ALERT fires) there is a **hours-to-days-long situational-awareness vacuum**: where is
the fire, how big, which way is it growing, is it near the road I drive, is the smoke over
my village from *that* fire, is it still burning today. Officials do not fill it (no
capacity, no mandate, real operational focus); media fill it patchily and late. That
vacuum is our product. It is also — critically — a vacuum whose information is *useful at
3 h latency*, because the questions are about trend and geography, not about the next ten
minutes.

### 3.3 Where we must defer, always

- Evacuation decisions and all-clear/return decisions — mayor/governor/police only.
- Suppression status (локализиран/ликвидиран) — ГДПБЗН statements only, quoted with source.
- Road closures — police/АПИ; we link, we do not assert.
- Cause attribution ("arson") — never; it is criminal-investigation territory.

### 3.4 Messages the product must NEVER send (hard policy for the Notification Gateway)

1. Any variant of **"all clear"**, "safe", "safe to return", "danger passed".
2. **"Extinguished" / "изгасен" / "потушен"** derived from our own data (only quoted
   official statements, attributed, with link and timestamp).
3. **"Evacuate" / "prepare to evacuate"** in our own voice — we may *relay* an official
   order verbatim, clearly attributed ("Областният управител обяви евакуация — source"),
   ideally linking BG-ALERT/municipal source; the push copy must lead with the authority's
   name, not ours.
4. **"No fires in your area"** as a reassurance (an empty state is "no satellite
   detections", never "no fires").
5. Directional predictions in alert copy ("the fire is heading for X") — wind context yes,
   trajectory claims no [see §5].
6. "Firefighters are (not) on scene" unless quoting an official/media source with
   attribution.
7. Anything instructing people to go toward a fire (including "verify and report back").
8. Health advice beyond generic, sourced smoke guidance ("close windows; official guidance:
   link") [v1, with a public-health source].

---

## 4. The "out" question — answered from the domain side

*(This closes the open question escalated in `00-summary.md`.)*

### 4.1 What the official states actually mean

Bulgarian fire-service practice uses two operational milestones (same doctrine family as
the Russian/Soviet fire-service terminology the definitions trace to):

- **Локализиран (lokaliziran — "contained/localized"):** spread has been stopped; the fire
  is held within a perimeter; threat to people eliminated; conditions exist to extinguish
  with forces on hand. **The fire is still burning.** Media and ГДПБЗН use this word daily
  in season ("пожарът е локализиран"). It is frequently followed by re-escalation when
  wind returns — "contained" perimeters in Sakar 2025 re-flared repeatedly.
- **Ликвидиран (likvidiran — "extinguished/liquidated"):** burning has ceased *and*
  conditions for reignition are considered excluded; crews typically remain for
  обезопасяване/дежурство (securing/fire watch) precisely because this judgment is
  fallible. Only the responsible fire authority declares it.

The product's UI in Bulgarian must use these words **only when quoting official statements**
and must use them correctly (a "локализиран" badge must never render as "потушен"). Using
them loosely is the fastest way to be dismissed by every professional who sees the site.

### 4.2 Why satellite non-detection ≠ out

1. **Smoldering is largely invisible.** Duff, litter, roots, stumps, thick downed wood burn
   flameless at temperatures/areas below VIIRS' detection envelope (VIIRS catches ~ a small
   flaming front at night under ideal conditions; daytime and sub-canopy sensitivity is far
   worse; MTG's ~2 km pixels need well-developed flaming). A mountain fire "quiet" for
   three passes is routinely still alive — Pirin 2025 smoldered under canopy between
   flare-ups for weeks.
2. **Obscuration:** cloud, smoke, and canopy block detections for whole passes; a missed
   overpass is not evidence of absence (this is T6's "decay frozen while source stale",
   extended: decay must also account for cloud cover over the event [v1 — cloud-mask flag
   from the FIRMS granule metadata or a simple cloud-fraction check]).
3. **Diurnal rhythm:** fires lie down at night (humidity recovery) and re-intensify
   mid-afternoon. A morning pass showing nothing predicts nothing about 15:00.
4. **Reburns and wind shifts:** interior islands of unburned fuel torch days later; a wind
   shift re-activates a "cold" flank. In the SE grass world, the *same perimeter* often
   produces new runs for several days (Sakar 2025).

### 4.3 What a satellite-only product may honestly display (exact wording tiers)

Event end-of-life state machine (rename internal `out` state accordingly):

| Tier | Trigger | EN copy | BG copy |
|---|---|---|---|
| **Active** | Detection in latest expected pass | "Actively detected — last satellite detection HH:MM" | "Активно засичане — последно сателитно засичане HH:MM" |
| **Signal weakening** | ≥2 passes with falling FRP/count | "Weakening satellite signal over the last N passes — fires often re-intensify in the afternoon" | "Отслабващ сателитен сигнал през последните N наблюдения — пожарите често се разгарят отново следобед" |
| **No longer detected** | ≥N clear-sky expected passes with nothing | "**No longer detected by satellites since <date HH:MM>.** This does not mean the fire is out — satellites cannot see smoldering, burning under trees or through cloud." | "**Не се засича от сателити от <дата HH:MM>.** Това не означава, че пожарът е изгасен — сателитите не виждат тлеене, горене под короните или през облаци." |
| **Officially contained** (curated) | ГДПБЗН/municipal statement | "Declared contained (локализиран) by authorities on <date> — source. Containment means spread is stopped; the fire may still burn inside the perimeter." | "Обявен за локализиран от властите на <дата> — източник. Локализиран означава спряно разпространение; пожарът може още да гори в периметъра." |
| **Officially extinguished** (curated) | Official statement only | "Declared extinguished (ликвидиран) by authorities on <date> — source." | "Обявен за ликвидиран от властите на <дата> — източник." |
| **Archived** | No detections for the archive window | "Event archived: no satellite detections for N days. New nearby detections may reopen it as a possible reignition." | "Събитието е архивирано: без сателитни засичания от N дни. Нови засичания наблизо могат да го отворят отново като възможно повторно разгаряне." |

**The word "extinguished"/"изгасен" never appears except in the officially-sourced tier.**

### 4.4 Reignition windows — verifying the 7-day assumption

The engineering round adopted a ~7-day reignition window (new detection within X km
reopens/links the event). Domain verdict: **7 days is right for the grass–shrub and
agricultural worlds, too short for the mountain conifer world, and meaningless for
lignite.** Recommended, fuel- and size-dependent:

| Event class | Reignition/link window | Rationale |
|---|---|---|
| Grass/agri events (<100 ha, cropland/pasture land cover) | **7 days** | Fine fuels fully consumed; later fires are new ignitions |
| Shrub/mixed events and any event 100–1,000 ha | **14 days** | Heavy-fuel islands, reburn runs (Sakar 2025 pattern) |
| Forest events >1,000 ha or in conifer/high-duff land cover | **21–30 days** | Holdover smoldering in duff/roots; Slavyanka and Pirin both exceeded 4 weeks of life |
| Inside static hot-source mask (Maritsa-Iztok mines/TPPs, Neftochim, cement) | **No events at all** | Permanent industrial/lignite thermal sources |

Linking copy: "possible reignition of <event>" — *possible*, because a fresh human ignition
in the same footprint is equally likely in Bulgaria (>90% human causation) and we cannot
distinguish them. Never present a linked event as proof of inadequate mop-up — that is an
operational accusation with legal weight (the Slavyanka lawsuit shows how contentious
"inadequate extinguishing" claims are).

---

## 5. Fire-behavior context users actually need

### 5.1 FWI danger classes translated to Bulgarian ground truth

EFFIS uses the Canadian FWI with harmonized European classes (very low <5.2, low 5.2–11.2,
moderate 11.2–21.3, high 21.3–38.0, very high 38.0–50.0, extreme ≥50 — EFFIS fire-danger
viewer). What they *mean* in Bulgarian fuels (educational copy, [MVP]):

- **Low/Moderate:** escaped burns creep, crews catch them small; a bad outcome needs bad
  luck.
- **High:** cured grass carries fire readily; afternoon escapes outrun a single engine
  crew; the SE hills produce their multi-hundred-decare days here.
- **Very high:** wind-driven grass runs measured in km/h; pine plantations can crown;
  this is the level at which municipalities should be checking volunteer readiness — and
  at which the product should nudge watch-zone users ("Very high danger in your zone
  today").
- **Extreme:** Voden/Sakar/Pirin weather. New ignitions become campaign fires in hours;
  suppression shifts to protecting villages, not perimeter control. Any detection near a
  settlement at Extreme deserves the product's highest visual priority.

Important honesty note: FWI is a *weather* index at ~8 km. It says how a fire would behave
*if ignited*, not that one will ignite. Copy must never render the danger layer as "fire
expected here".

### 5.2 Wind — the dominant driver (and the local winds that matter)

Every catastrophic Bulgarian fire of 2024–2025 was a wind event. Local wind knowledge worth
encoding as education and (v1) event-context hints:

- **Diurnal mountain-valley cycle:** upslope/up-valley afternoon winds push fires uphill
  into inaccessible terrain by day; nighttime downslope drainage reverses direction —
  crews' "quiet night" is real but temporary. Product hint: fires in mountain terrain
  often change direction between our overpasses; a morning centroid shift downhill is not
  an anomaly.
- **Foehn/bora-type downslope events:** dry, gusty northerly winds spilling over the Stara
  Planina onto the sub-Balkan valleys, and föhn effects in the lee of Rila/Pirin, produce
  the most dangerous fire weather Bulgaria gets — hot, dry, 60+ km/h gusts. The Struma
  corridor (Kresna gorge) funnels and accelerates regional flow — a reason SW Bulgaria
  burns the way it does.
- **Black Sea breeze:** onshore afternoon breeze reverses to offshore at night —
  coastal-zone fires (Strandzha coast, dune grass) flip direction on a 24 h cycle.
- **Frontal passages:** the classic killer is the pre-frontal SW wind followed by an
  abrupt NW shift that turns a fire's long flank into a new head. This is a [v1]
  event-context hint worth building from Open-Meteo data: "wind shift expected around
  HH:MM" — hint, not prediction of fire movement.

### 5.3 Slope, aspect, and reading the terrain map

Educational content [MVP], because it converts a flat map into understanding: fire spreads
faster uphill (rule of thumb: rate roughly doubles per ~10° of slope — preheating of
upslope fuels); south/southwest aspects carry the driest fuels and burn first; gullies and
saddles channel wind and fire like chimneys (canyon alignment was a factor in the fatal
professional burnovers of the last decades worldwide — and Bulgarian terrain is full of
such gullies). Practical user translation: *"if the fire is below your village on a slope,
you have far less time than the map distance suggests."*

### 5.4 Rate-of-spread and spotting numbers for honest education copy

| Fuel | Sustained head-fire ROS | Rule of thumb | Source |
|---|---|---|---|
| Cured grass/stubble | 1.6–17 km/h observed; ~10 km/h at 50 km/h wind | ~20% of 10-m wind speed | MDPI Fire 5(2):55; CSIRO grassland model |
| Shrub / conifer forest | up to ~5–10 km/h in extreme wind; usually much less | ~10% of 10-m wind speed | Cruz & Alexander 2019 (Ann. For. Sci.) |
| Crown fire in pine plantations | 2–8 km/h with short-range spotting | — | standard fire-behavior literature |
| Spotting (pine) | typically 100–500 m ahead; up to ~2 km in extreme plume-driven cases | firebrands cross firebreaks and roads | fire-behavior literature |

The line the task asked for is defensible and should ship as education copy:
**"A grass fire in wind moves faster than you can walk — often faster than you can run
uphill."** (Adult brisk walking ~5 km/h on flat, ~2–3 km/h uphill; grass fires routinely
exceed both.)

### 5.5 What belongs where

- **[MVP] Education:** FWI class meanings; ROS table above; slope/aspect basics; smoke vs
  flame reading; "why satellites are late" explainer; локализиран/ликвидиран explainer.
- **[v1] Event-context hints:** current + 12 h wind arrow at the event; FWI class of the
  event's cell today/tomorrow; "wind shift expected"; terrain shading under the event;
  diurnal note ("fires often re-intensify 13:00–18:00").
- **[Never — out of scope] Modeling:** spread simulation, arrival-time isochrones, ember
  probability, "threat cones". One wrong cone that contradicts an official decision ends
  the product's credibility, and doing it right (fuel maps + calibration + validation) is
  an institute's job, not a solo developer's. This hard boundary also keeps us legally
  defensible: we relay observations and official forecasts, we do not forecast fire.

---

## 6. User segments ranked by how well 15 min–3 h latency serves them

Ranked best-served → worst-served, with the top product implication each:

1. **Diaspora checking on home villages (superbly served).** 1.7–2.5 million Bulgarians
   abroad (UNDESA 2020: ~1.7M; other estimates higher), disproportionately from exactly
   the depopulated rural districts that burn. They cannot call 112, they *can* refresh a
   map at any latency; their notifications tolerate hours. They are also the most likely
   early payers (supporting monitoring of the family house). *Implication:* i18n EN from
   MVP; watch zones purchasable from abroad; shareable event permalinks ("виж какво става
   при нас" — "look what's happening back home") are the growth loop. This segment is the
   BG-specific product superpower and deserves explicit prioritization in ANALYSIS.md.
2. **Researchers, insurers, post-season analysts (fully served).** Latency irrelevant;
   what matters is a clean event archive with per-event detection history and final
   perimeters. *Implication:* the append-only detections table is already the product;
   [v2] season reports per municipality — also the credibility artifact for §10.
3. **Forestry staff (well served).** Their operational tempo is hours-to-days; morning
   check "what happened overnight near our blocks" fits NRT perfectly. *Implication:*
   [v1] polygon-lite (watch zone around a ДГС), [v2] real B2B polygons + webhooks.
4. **Journalists (well served).** They need location, extent, growth, history — at
   newsroom tempo. *Implication:* embeddable map + per-event permalink with attribution
   requirement; being the picture every newsroom screenshots is free distribution — and a
   correctness responsibility (unit-correct ha/дка figures!).
5. **Beekeepers / farmers / herders (moderately served).** Livestock and hives move
   slowly; lead time matters more than freshness. A "fire event active/growing within
   10 km of your pasture" push 2 h late still buys hours for moving animals. But the
   fastest grass runs (their actual nightmare) outrun our data. *Implication:* honest
   zone-alert copy ("detected as of HH:MM — conditions may have changed"); pair every
   alert with today's FWI so they act on danger days *before* fires.
6. **Volunteers (moderately served — with a safety edge).** Well served for awareness
   while awaiting activation and for family/property awareness. Poorly served (and must
   not be served) for tactical decisions. *Implication:* a "volunteer mode" is a trap —
   do not build dispatch-like features; do add copy in the volunteer-facing content:
   "Деятелите се активират само по установения ред" ("volunteers deploy only through the
   official chain") — self-dispatch discouragement designed in, see §7.
7. **Rural residents near an active fire (poorly served for life safety — say it
   plainly).** For the first hour of a fast fire, our data does not exist yet; for the
   ongoing days, we are their best public source ("is it still active, did it grow toward
   us overnight"). *Implication:* the product's own onboarding must set this expectation
   ("if you see flames or smoke near you, call 112 — do not wait for this app");
   freshness banner always visible at village zoom; the FWI layer is our *actual*
   life-safety contribution to this segment (danger awareness before ignition).

---

## 7. Harm scenarios and concrete mitigations

| # | Scenario (practice-grounded) | Harm | Product mitigation (concrete) |
|---|---|---|---|
| H1 | Resident sees event "weakening"/absent on stale data, decides not to prepare/leave; fire re-intensifies (Sakar re-flares, Pirin flare-ups) | Injury/death, property loss | Freshness timestamp on every surface; "no longer detected ≠ out" copy (§4.3); staleness banner freezes lifecycle (T6); onboarding disclaimer; never any "safe" state |
| H2 | Onlookers converge on fire roads at road-level zoom; block engines and evacuation routes (documented recurring behavior at Bulgarian fires) | Obstructed response | No routing/directions to events, ever; event rendered as centroid + uncertainty area, not road-snapped; at zoom > ~1:25k show detection footprint, not a pin implying a precise "go here" point; copy on every event page: "Do not travel toward the fire area — keep roads clear for responders" (BG: "Не пътувайте към района на пожара") |
| H3 | Volunteers self-dispatch past police lines using our map ("freelancing") | Untracked people inside an incident; liability | No "responders needed" or check-in features; volunteer content states the legal activation chain; crowdsource prompts never ask anyone to *go look*; report flow's first line: "Ако виждате пожар, първо позвънете на 112" ("If you see fire, call 112 first") |
| H4 | Agri burn near a village rendered as a wildfire → panic calls, distrust; or the inverse — real escape dismissed as "just stubble" | Panic / complacency | Land-cover tag ("cropland — possible agricultural burn") with muted styling; default zone alerts suppressed for low-persistence cropland detections but *shown on map*; tag is probabilistic in copy ("possible"), and persistence across ≥2 passes upgrades it to a normal event (agri escapes are how disasters start) |
| H5 | Smoke plume geolocation confusion — users pin "fire" where smoke *appears* (tens of km downwind) | False events, wasted attention | Education content on smoke drift; crowdsourced smoke reports typed separately and never rendered as fire icons (§8); event pages show wind direction so users can self-explain smoke |
| H6 | Empty map during a FIRMS/LSA SAF outage read as "no fires" during a heat wave | Mass false security | T6 in full: per-source freshness SLI, banner "satellite data delayed since HH:MM — the absence of detections is not evidence of absence of fire", meta-alert to operator; the map never renders an *empty state message* that sounds reassuring |
| H7 | Cross-border event (Greek/Serbian side) appears to threaten a BG village; product silence on suppression reads as "nobody is responding" | Panic, rumor amplification | Border overlay; copy: "suppression status for events outside Bulgaria may be unavailable"; curate from Greek/Serbian official sources for major border events [v1] |
| H8 | Media republish our numbers with дка/ha unit errors amplified | Public misinformation attributed to us | Always display both units in BG UI ("~3 200 дка (320 ha)"); embed/permalink pages carry units explicitly; press-facing "about our data" page |
| H9 | An event page becomes "evidence" in blame wars (arson accusations, "they let it burn") | Legal exposure, community conflict | No cause fields, no suppression-quality commentary; historical pages carry the same non-detection caveats; ToS forbid presenting the service as an official record |

---

## 8. Crowdsourced reports — the domain view

*(Complements the security review's "evidence, never triggers" ladder.)*

### 8.1 What field reports are actually worth

Reliable and valuable:
- **Photo of a smoke column with a recognizable landmark/horizon** — the single most
  useful report type; a bearing from a known point localizes a fire better than a verbal
  description ever will.
- **Bearing + landmark** ("smoke behind the Golo Bardo ridge as seen from the Pernik road")
  — dispatcher-grade information; two such reports from different points triangulate.
- **Smoke character:** white/grey = grass/fine fuels or damp fuel; darker/browner = heavy
  fuels or structures; column standing vertical = light wind, plume-driven; sheared flat =
  wind-driven and moving. Volume/rate of growth over minutes ≈ intensity trend.
- **Negative/status observations tied to an existing event:** "no visible smoke from
  <viewpoint> this morning", "helicopter working since 09:00", "engines staged at the
  village square" — excellent curation input, clearly attributable, low harm.

Mostly noise: verbal distance estimates ("about 2 km away" — people are wildly wrong);
smell of smoke (travels tens of km); night glow (reflections, misjudged distance);
secondhand reports ("my cousin says…").

### 8.2 Minimal report taxonomy (matches how a dispatcher thinks)

1. **Smoke sighted** — observer location (GPS), bearing (compass or landmark), photo,
   smoke color/behavior, time. → renders (after moderation) as a *smoke report* marker,
   visually distinct from satellite detections, never as a fire event.
2. **Flames sighted** — same fields + what is burning (grass/trees/building) + rough
   front length. First line of the form: "Обадихте ли се на 112?" ("Have you called
   112?") with a yes/no field — both a nudge and a triage datum.
3. **Existing-event observation** — status update anchored to an event (active/quiet/
   responders present/aircraft working). Lowest risk, highest curation value.
4. **Not-a-wildfire flag** — "this is a stubble burn / the TPP / a barbecue"; feeds the
   false-positive suppression loop (T5).
5. **Aftermath** — burned-area photo for perimeter refinement/history.

### 8.3 Moderator verification questions (worksheet)

- Where exactly were you standing (map pin), and which direction were you looking
  (landmark better than degrees)?
- Is the photo original and just taken (EXIF time/GPS present)? Does the terrain in frame
  match the claimed viewpoint (quick check against the map)?
- Is the smoke *rooted* (column base visible = near fire) or only a drift layer aloft
  (= distant fire, report localizes nothing)?
- Does the bearing intersect any current satellite detection or known agri-burn area? Any
  second report on a crossing bearing?
- Is there an official/media mention yet? (If yes — anchor to event; if no and two
  independent bearings agree — publish as *unconfirmed smoke report*, never as an event.)

Moderation capacity remains a launch precondition (security review) — the domain addition
is that **in-season report volume follows the fire weather**: staff the moderation duty by
FWI forecast, not by calendar.

---

## 9. Seasonal operations calendar for the product team

| Period | On the ground | Product surface & ops |
|---|---|---|
| **March–April** | Agri-burn wave; first forest escapes on windy days; пожароопасен сезон declared regionally | "Burn-season mode": agri-tags prominent, education push ("burning stubble is illegal and how it escapes"), recalibrate false-positive mask after winter; expect the year's highest detection *counts* |
| **May–June** | Green-up lull; institutions run readiness drills; season orders issued | Pre-season release freeze prep (QA gate); FWI education campaign; watch-zone signup push ("set your zones before the season"); annual re-verification of sources/partners (rescEU positioning, BG-ALERT changes) |
| **July–September** | Main season: heat waves, campaign fires, EUCPM activations, BG-ALERT fire alerts | Peak ops: freshness SLOs, incident curation for majors, moderation staffed by FWI, no risky deploys (fire-season release gate per QA); daily situational content; H1–H9 mitigations live |
| **October** | Stubble echo, hunting-season ignitions, late dry-autumn fires | Keep agri-tag mode; season wind-down content; begin season-report data pulls |
| **November–February** | Sporadic winter grass fires (increasing); institutions write annual reports | **Retention program:** interactive season review (burned area per municipality, dNBR maps), "how satellites see fires" explainers, prevention content, product changelog; publish the season report that doubles as the §10 credibility artifact; backfill/reprocessing and clustering re-tuning on the season's data |

This directly answers the UX off-season retention question: winter retention is *review and
learning* content plus the danger-forecast layer (which stays mildly interesting year-round),
not fake urgency.

---

## 10. Credibility strategy with the professional community

A hobby-looking map earns **tolerance** (not endorsement) from ГДПБЗН and the forestry
system the same way Watch Duty earned it from CAL FIRE-adjacent agencies: by being
accurate, terminologically correct, operationally humble, and quietly useful — for years.

Principles:
1. **Accuracy discipline over speed.** One confidently wrong event placement quoted by a
   journalist costs more than fifty correct ones earn. Corrections are published, visibly
   and fast, with a changelog. (The QA launch gates — PCR ≥95%, precision ≥85% — are also
   the credibility gates.)
2. **Correct terminology, everywhere.** локализиран/ликвидиран used precisely and only
   with attribution (§4); decares *and* hectares; "detection", not "fire", for raw pixels;
   "satellite last saw", not "status". Professionals read one screen and know instantly
   whether we understand the domain.
3. **Never claim an operational role.** No "helping firefighters", no press releases about
   "cooperation with ГДПБЗН", no emergency-service visual cosplay (no flashing sirens, no
   МВР-like branding). The About page states plainly: informational service, not part of
   the Unified Rescue System, 112 first.
4. **Offer data quietly.** A short letter (not a press release) to the ГДПБЗН press office
   and to the six forestry enterprises after the first season: here is what we log, here
   is a free institutional view/export, use it or ignore it. Same to WWF Bulgaria (their
   annual fire analysis needs exactly our data) and the FIRE-RES Bulgarian living lab —
   the NGO/science flank is a softer entry than МВР and lends citable legitimacy.
5. **Publish the season report.** A rigorous, correctly-unit-ed, satellite-based season
   summary per municipality, released each November, is the artifact that makes
   journalists, researchers, and eventually institutions treat the product as serious.

### Ranked recommendations

**[MVP — before or at first public launch]**
1. Honest use-case statement (§1.3) verbatim in About/onboarding + ANALYSIS.md.
2. End-of-life wording tiers (§4.3) implemented; internal `out` state renamed;
   fuel/size-dependent reignition windows (§4.4) in ADR-002.
3. Never-send list (§3.4) enforced as Notification Gateway template policy (ADR-004).
4. Agri-burn/land-cover context tags + Maritsa-Iztok-class permanent masks (with T5).
5. Freshness/empty-state copy per H1/H6 ("absence of detections ≠ absence of fire").
6. Education pack v1: FWI classes in BG terms, ROS table ("faster than you can walk
   uphill"), smoke-reading, satellite-latency explainer, локализиран/ликвидиран explainer.
7. No-routing / centroid-not-pin rendering policy (H2); "do not travel toward the fire"
   copy on event pages.
8. Both units (дка + ha) in all BG-facing copy.

**[v1 — with alerts/PWA]**
9. Curated incident log for majors sourced from ГДПБЗН bulletins + municipal Facebook +
   BTA, with per-item attribution (the BG substitute for scanner traffic).
10. Relay-only handling of official evacuation orders (attributed, linked, authority-first
    copy); BG-ALERT activations mirrored as curated items where public.
11. Event-context hints: wind now/12 h + shift warning, event-cell FWI, diurnal
    re-intensification note; alert copy carries "as of HH:MM".
12. Crowdsourcing per §8 taxonomy with 112-first flow and moderation staffed by FWI.
13. Diaspora-first growth: EN locale, foreign-currency payments, shareable permalinks.
14. Municipal embed offer to the 20 most fire-exposed municipalities (Harmanli,
    Topolovgrad, Svilengrad, Bolyarovo, Elhovo, Strumyani, Sandanski, Kresna…).
15. Cross-border curation for major GR/RS/MK/TR border events (H7).

**[v2]**
16. Forestry B2B polygons/webhooks (ДГС/ДЛС, state enterprises as anchor accounts).
17. November season report per municipality (credibility artifact + B2B lead-gen).
18. Quiet institutional data offer (ГДПБЗН, enterprises, WWF, FIRE-RES lab).
19. Wetland/organic-soil slow-archive handling; Balkan expansion of curation model.

---

## Open questions (for the product owner / next review round)

1. **Curation capacity in season:** the BG substitute for scanner traffic is human reading
   of bulletins and municipal Facebook — for a solo operator during a Sakar-type week,
   what is the sustainable curation SLA, and what does the product show when curation
   lags (auto-events only, clearly labeled)? Ties to the SRE solo-on-call question.
2. **Relaying evacuation orders:** is verbatim relay of official orders in push
   notifications legally safe (and desirable), or do we restrict relays to in-app curated
   items in v1? Needs the legal review's input on liability for delayed/incomplete relay
   (an order we relay 40 min late is a new harm vector).
3. **Detection-to-event threshold at Extreme FWI:** do we drop the ≥2-detection
   persistence rule near settlements on Extreme days (faster visibility, more false
   positives) — a domain-tunable worth an explicit experiment in the shadow season?
4. **Volunteer formations as a formal channel:** approach NAVRB/municipal formations for
   structured feedback in season 1, or stay fully passive until credibility is
   established? (Recommendation: one pilot municipality, chosen where a formation is
   active — e.g., Harmanli — but decide deliberately.)
5. **Exact current volunteer-registry and РСПБЗН counts** [verify against mvr.bg registry
   before any published "who does what" content], and annual re-verification of rescEU
   seasonal positioning relevant to Bulgaria.
6. **Cloud-cover awareness in the lifecycle** (§4.2): is a cloud-fraction check per missed
   pass feasible in v1, or do we accept "clear-sky passes" as approximated by pass
   predictor + season?

---

## Sources

Bulgarian institutions and statistics:
- ГДПБЗН structure — https://www.mvr.bg/gdpbzn and https://mvr.bg/gdpbzn/дирекцията/структура/default
- ГДПБЗН registries (volunteer formations) — https://www.mvr.bg/gdpbzn/info-center/справочна-информация/регистри
- Volunteer formations overview — https://www.mvr.bg/gdpbzn/дирекцията/дейности-на-гдпбзн/dobrovolni_form
- МВР 2025 report via Ruse.news (47,111 incidents; 33,428 fires; BG-ALERT 89 activations, 36 fire) — https://ruse.news/index.php/2026/03/23/bg-alert-zadejstvana-89-pati-prez-2025-g/
- Сметна палата audit of ГДПБЗН (2025) — https://www.bulnao.government.bg/bg/documents/15232/GDPBZN_OD_07.2025.pdf
- ИАГ–ГДПБЗН joint prevention checks — https://www.mzh.government.bg/bg/press-center/novini/svmestni-proverki-na-iag-i-gdpbzn-za-prevenciya-na/
- Haskovo RDPBZN annual figures — https://www.haskovo.net/news/603307/4-zaginali-i-28-postradali-pri-1447-pozhara-v-haskovsko-za-godina
- Kardzhali RDPBZN 2025 (436 fires) — https://www.novjivot.info/2026/03/26/ (Нов Живот)

Fire regime and science:
- Silva Balcanica 27(1) 2025 — SW Bulgaria fire seasonality; 2015–2024: 4,835 fires / 62,320.9 ha — https://public.pensoft.net/items/ (doi: 10.3897/silvabalcanica.27.e180848)
- WWF: >90% of BG forest fires human-caused — https://wwfcee.org/what-we-do/forest/over-90-of-forest-fires-in-bulgaria-caused-by-human-activity-wwf-warns and https://www.bta.bg/en/news/bulgaria/925799
- WWF fire analysis 2026 (PDF) — https://wwfeu.awsassets.panda.org/downloads/wwf_forest-fire-analysis-2026.pdf
- WWF: Bulgaria among worst-hit 2025 (~300k дка forest) — https://wwfcee.org/news/bulgaria-ranks-among-eus-worst-hit-countries-by-forest-fires-in-2025
- Heat waves and forest fires in Bulgaria (Natural Hazards, 2022) — https://link.springer.com/article/10.1007/s11069-022-05451-3
- FIRE-RES living lab Bulgaria — https://fire-res.eu/living-lab/living-lab-bulgaria/
- JRC annual report 2024 via Sofia Globe (45,435 ha / 256 fires; 2×~8,000 ha) — https://sofiaglobe.com/2025/03/25/total-area-burnt-in-forest-fires-in-bulgaria-in-2024-highest-in-a-decade-ec-report/
- JRC: 2025 EU record season (1,079,538 ha) — https://joint-research-centre.ec.europa.eu/jrc-news-and-updates/2025-was-eus-most-destructive-wildfire-season-record-2026-03-31_en and https://civil-protection-humanitarian-aid.ec.europa.eu/news-stories/news/europe-faces-worst-wildfire-year-record-fire-seasons-grow-longer-and-more-destructive-2025-12-05_en
- EFFIS fire danger classes — https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/fire-danger-forecast

2024–2025 case studies:
- Slavyanka 30-day fire, mined terrain — https://btvnovinite.bg/svetut/pozharat-v-planinata-slavjanka-veche-30-dni-gori-garcite-se-moljat-za-dazhd.html and https://bntnews.bg/news/v-planinata-slavyanka-prodalzhava-da-gori-lokaliziran-e-pozharat-nad-senokos-1288302news.html
- Voden 2024 failure analysis — https://www.mediapool.bg/pozharat-v-selo-voden-i-ogromniyat-proval-news361384.html and https://www.mediapool.bg/pozharite-izgoreli-kashti-i-evakuirani-hora-v-yambolskoto-selo-voden-galeriya-i-video-news361206.html
- Sakar 2025 (Harmanli/Topolovgrad; >30k дка) — https://tribune.bg/bg/obshtestvo/pozharat-v-sakar-e-ovladyam-no/ and https://bntnews.bg/news/obyaveno-e-chastichno-bedstveno-polozhenie-v-obshtina-harmanli-zaradi-razrastvashtiya-se-pozhar-v-sakar-1350297news.html and https://bnrnews.bg/horizont/post/320342/lokaliziran-e-golemiat-pojar-v-sakar-planina-izbuhnal-krai-s-cherepovo
- Pirin/Ilindentsi 2025 (>4,000 ha; Ploski evacuation via BG-ALERT; month-long) — https://www.bta.bg/en/news/939409-wildfire-near-ilindentsi-engulfs-over-4-000-hectares-spreads-into-pirin-nationa and https://www.bta.bg/en/news/bulgaria/953167-month-old-fire-in-pirin-mountain-finally-put-down and https://www.novinite.com/articles/233704/Bulgarian+Authorities+Contain+Pirin+Fire+-+For+Now
- DG ECHO daily flash, BG wildfires Jul 2025 — https://reliefweb.int/report/bulgaria/bulgaria-wildfires-dg-echo-effis-media-echo-daily-flash-28-july-2025

Warning systems and aviation:
- BG-ALERT overview — https://www.guidebg.com/bg-alert-bulgaria-public-warning-how-it-works/
- Aerial capacity: two helicopters — https://www.svobodnaevropa.bg/a/helikopteri-pozhari/33061865.html ; Cougar program and MO/МВР dispute — https://www.mediapool.bg/oshte-nyakolko-kugar-a-shte-litnat-spor-mezhdu-mo-i-mvr-koi-da-gasi-pozharite-ot-vazduh-news361754.html ; Mi-17 return — https://news.bg/bulgaria/za-parvi-pat-ot-10-g-mi-17-gasi-pozhar-ot-vazduha.html
- rescEU fleet and 2025 deployments (6 countries aided BG) — https://civil-protection-humanitarian-aid.ec.europa.eu/what/civil-protection/resceu_en and https://www.airmedandrescue.com/latest/news/european-firefighting-assets-deployed-combat-wildfires and https://civil-protection-humanitarian-aid.ec.europa.eu/news-stories/news/resceu-firefighting-airplanes-production-launched-2024-08-13_en

Fire behavior:
- Grassland ROS under critical conditions (1.6–17 km/h; ~20% of wind) — https://www.mdpi.com/2571-6255/5/2/55
- 10% wind-speed rule for forest/shrub ROS — https://link.springer.com/article/10.1007/s13595-019-0829-8

Diaspora:
- UNDESA ~1.7M (2020) via Prague Process factsheet — https://www.pragueprocess.eu/en/news-events/news/645-factsheets-belgium-bulgaria-denmark-germany-kosovo-and-romania ; higher estimates — https://china-cee.eu/2019/12/19/bulgaria-social-briefing-nearly-2-5-million-bulgarians-live-abroad/ and https://en.wikipedia.org/wiki/Bulgarian_diaspora
