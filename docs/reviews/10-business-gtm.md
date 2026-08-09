# Review 10 — Business Strategy & Go-to-Market

**Reviewer role:** Senior business strategist / go-to-market operator — civic-tech, geo-data products, EU space-sector funding.
**Scope:** Market sizing, monetization boundary, B2B segmentation, partnerships, funding map 2026–2027, competition, GTM sequencing, business risk, 12-month plan.
**Inputs:** `docs/ANALYSIS.md` (§2 market context, §6 staged hybrid business model, §7 validation plan), reviews 01–09, and dedicated web research (all URLs cited inline; items that could not be verified are explicitly marked *unverified* or *estimate*).
**Date:** 2026-07-22.

Engineering decisions (FIRMS ~3 h Europe latency, MTG FCI 15–30 min, QA gates PCR ≥95% / alert precision ≥85% / p95 ≤15 min, "map fails open, alerts fail closed", own tiles before real traffic) are taken as given and are not re-litigated here. This review asks only: *is there a business, and how do you reach it?*

Relation to the series: reviews 01–08 supply the engineering constraints and review 09 the legal boundaries; both are consumed here as fixed inputs. Where a business recommendation leans on a prior review's theme (latency honesty, the detection archive as a long-term asset, fail-closed alerting), the dependency is noted inline rather than re-argued.

---

## 1. Summary verdict

**CONDITIONAL GO — but on a re-framed thesis.** Fire-watch is viable as a **civic asset with a hybrid revenue model** (supporter B2C + niche B2B + grants), not as a venture-scale consumer subscription business. The consumer market in Bulgaria is real but tiny in euro terms; the honest math says B2C revenue will be symbolic for at least two seasons. The business case rests on three legs, in this order of importance:

1. **Distribution and trust first.** As of July 2026 there is *no* consumer product in Bulgaria offering "live fire map + push alerts" — the niche is genuinely empty (see §6). BG-ALERT's publicly documented failures (§2.9) are the "why now". Winning here costs almost nothing in cash and creates the asset everything else monetizes.
2. **B2B is where the money is.** Watch Duty's own numbers prove it: consumer membership converts at ~0.8% even in the richest market on earth, while their Pro/B2B tier grew 6.8x in one year ([Watch Duty 2025 Annual Report](https://www.watchduty.org/blog/2025-annual-report)). The Bulgarian analogues with budget and acute pain are **energy/PV-park operators** and **state forestry enterprises** (§3), reachable under the ЗОП direct-award ceiling without tenders.
3. **Grants bridge the gap, but only the right ones.** All 2026 CASSINI deadlines have passed; the 2027 CASSINI Challenges cycle (€100k, no consortium, a wildfire company — Pyri — won in 2026) plus the reformed НИФ and the upcoming EEA/Norway "Green Business and Innovation" programme are the realistic funding line (§5). **There is no ESA BIC Bulgaria** — plans assuming one must be corrected. Consortium-based instruments (Horizon CL3, Interreg) are a solo-founder time trap in year 1.

**Conditions attached to the GO:**

- **C1 [MVP]:** Season 1 (2027) is free, ad-free, registration-optional. No paid feature ships before the trust metrics in §7.4 are met. This mirrors ANALYSIS.md §6 and is confirmed by every benchmark in §2.
- **C2 [MVP]:** Do not quit primary income on B2C projections. Plan cash on the bootstrap scenario (§9.3 A); treat grants and B2B as upside, not base case.
- **C3 [v1]:** Before building any paid tier, secure at least one B2B pilot LOI *and* submit at least one non-consortium funding application. If neither exists by the M12 checkpoint (§9.2 CP3), fire-watch continues as a donation-funded civic project or winds down gracefully — both are acceptable outcomes and should be planned for.
- **C4 [MVP]:** The freemium boundary in §2.4 (safety information never paywalled) is adopted as a permanent, published principle — it is simultaneously the ethical position and the commercially optimal one.

### Executive summary of findings

| Question | Answer |
|---|---|
| Is the consumer niche empty? | Yes — no BG consumer fire app exists; closest analogues exclude Bulgaria (EU Fires app: 13 languages, no Bulgarian, iOS-only; pozari.org: 6 W-Balkan countries, no BG; Google wildfire boundaries: 15 European/African countries, no BG). |
| Realistic B2C revenue, season 1–2 | €500–5,000/yr (supporter model, 0.3–0.8% conversion at €8–13/yr). Symbolic; covers infra, not labour. |
| Top 2 B2B beachheads | (1) Energy: PV parks & grid infrastructure; (2) Forestry: the six state enterprises (ДП) + ИАГ. Both fit under ЗОП direct-award €25,565 services ceiling. |
| Funding recommendation | Bootstrap season 1 → CASSINI Challenges/Accelerator 2027 cycle + НИФ new session + EEA/Norway Green Business (2027) + Vitosha II equity as fallback. Skip Horizon/Interreg consortia in year 1. No ESA BIC Bulgaria exists. |
| Biggest business risk | Seasonality × solo founder: 100% of demand, press attention, alert load, *and* the founder's only realistic vacation window all land in the same 3 months, every year, with no cash buffer in the bootstrap scenario. |
| Sharpest competitive threat | Near-term: the indie EU Fires app adding Bulgarian (a week of work for them). Long-term: FireSat data flowing free through Google products 2027–2028, commoditizing raw detection. Defence: local depth — Bulgarian sources, institutions, community verification. |

### What this review does NOT recommend

Anti-recommendations are decisions too; the following are explicitly rejected for the covered horizon:

- **No paid user acquisition, ever, at these LTVs** (§2.4) — earned media and partnerships only.
- **No advertising revenue** — ads on a disaster map destroy the trust position that is the entire moat (§2.7).
- **No consortium grant applications in year 1** (Horizon Europe, Interreg, LIFE) — the §5.3 time-trap math is unambiguous for a solo founder.
- **No equity raise before CP3** — raising on symbolic B2C numbers would produce bad terms and premature growth pressure; the Vitosha II conversation is gated on B2B traction (§9.3 C).
- **No public-tender (ЗОП open procedure) pursuit in year 1** — direct-award-sized contracts only (§3.0); tender sales cycles exceed the runway.
- **No Balkan expansion before [v2]** — Greece/Turkey adjacency is real (§2.8) but every hour spent there before Bulgaria is won weakens both.
- **No paid tier of any kind in season 1** (condition C1) — the freemium boundary published before launch is a one-shot credibility asset.

---

## 2. Market sizing — the honest numbers

### 2.1 Bulgaria: population, reach, and the fire-exposed core

- Population **6,423,207** (31 Dec 2025, NSI final; −0.22% y/y; 24.3% aged 65+) — [BTA](https://www.bta.bg/en/news/bulgaria/1116111-bulgaria-s-population-at-6-423-207-as-of-december-31-2025-nsi-final-data-show), [NSI](https://www.nsi.bg/en/press-release/population-and-demographic-processes-9002).
- Rural population **1.69M = 26.3%** (end-2024, NSI) — [NSI PDF](https://www.nsi.bg/en/file/28604/Population2024_en_F59F6N4.pdf). Rural + wildland-urban-interface residents are the core alert audience.
- Internet users **5.84M (87.1%)**; mobile connections 9.18M (137% of population); social media users 4.50M (67.1%) — [DataReportal Digital 2026: Bulgaria](https://datareportal.com/reports/digital-2026-bulgaria). Smartphone penetration ~97% (Statista projection series — *estimate*) — [Statista](https://www.statista.com/statistics/568075/predicted-smartphone-user-penetration-rate-in-bulgaria/).
- The recurrently fire-affected provinces (Haskovo 211,565; Stara Zagora 296,507; Sliven 172,690; Yambol 109,693; Burgas 380,286; Blagoevgrad 292,227; Kyustendil 111,736 — 2021 census, [Wikipedia](https://en.wikipedia.org/wiki/Provinces_of_Bulgaria)) total **~1.57M people, ~24% of the country**. 2024's worst fires hit Stara Zagora, Yambol, Haskovo (Sakar: one fire >6,500 ha — [ReliefWeb/ECHO](https://reliefweb.int/report/bulgaria/bulgaria-wildfires-copernicus-emsr-effis-media-echo-daily-flash-19-july-2024)); 2025's hit Blagoevgrad (Pirin/Ilindentsi, ~18,200 ha — [Novinite](https://www.novinite.com/articles/233678/Bulgaria%E2%80%99s+Pirin+Mountains+Ravaged:+Wildfire+Destroys+Over+45,000+Acres)), Rila, Strandzha, Sakar again — [WWF CEE](https://wwfcee.org/news/bulgaria-ranks-among-eus-worst-hit-countries-by-forest-fires-in-2025).

### 2.2 The problem is growing, measurably

- **2024:** >38,000 ha burned (EFFIS), double 2023; ~600 fires; Bulgaria among the most-affected EU countries — [BNR](https://bnrnews.bg/en/post/111066/38-000-hectares-of-bulgarian-land-have-been-scorched-by-wildfires-since-the-beginning-of-2024), [BTA](https://www.bta.bg/en/news/world/1022308-bulgaria-is-among-eu-countries-most-affected-by-forest-fires-in-2024).
- **2025:** **32,752 ha**, 5th in the EU (after Italy 84,348, Greece 47,819, France 36,895; a later EFFIS extraction shows 33,825 ha and 7th place — figures shift with cut-off dates, so cite "~33,000 ha"); 59 significant fires >30 ha; the EU's worst season on record at 1.034M ha total — [JRC](https://joint-research-centre.ec.europa.eu/jrc-news-and-updates/2025-was-eus-most-destructive-wildfire-season-record-2026-03-31_en), [Science Media Centre ES](https://sciencemediacentre.es/en/wildfires-2025-burned-more-one-million-hectares-across-european-union-nearly-half-area-located). The Environment Ministry calls Bulgaria the most fire-affected EU country for 2024–2025 — [Sofia Globe](https://sofiaglobe.com/2025/07/25/environment-ministry-bulgaria-is-the-eu-country-most-affected-by-fires-in-2024-2025/).
- **ИАГ (forest-fund-only) series, 2011–2025:** 7,662 fires, 108,155 ha, 45.8M BGN (~€23.4M) direct damages; 2024: 595 fires / 17,116 ha / 8.4M BGN; 2025: 547 fires / 15,461 ha / **17.5M BGN** (>90% from the single Pirin/Ilindentsi fire). Long-run average: 479 fires and 6,760 ha per year, with **two seasonal peaks** — spring (stubble/pasture burning) and high summer. Note the definitional gap: ИАГ counts forest territories only; EFFIS counts all burned land including agricultural — both are correct, quote the right one per audience.
- WWF's July 2026 analysis: >15,000 ha burned in 2025 (worst forest-fire year since 2010), damages up >8x in 15 years, >95% human-caused — [News.bg](https://news.bg/society/wwf-merkite-sreshtu-gorski-pozhari-v-balgariya-ne-sa-adekvatni-na-rastyashtiya-risk.html), [WWF PDF](https://wwfeu.awsassets.panda.org/downloads/wwf_forest-fire-analysis-2026.pdf).

### 2.3 Willingness to pay: the uncomfortable part

- Only **9% of Bulgarians hold any streaming subscription** — the lowest rate in the EU (Ireland 64%, Denmark 61%) — [Eurostat](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=E-commerce_statistics_for_individuals). Bulgaria is also last in the EU for online shopping — [Sofia Globe](https://sofiaglobe.com/2025/02/20/eurostat-bulgaria-has-lowest-percentage-of-online-shopping-in-eu/).
- Average gross salary €1,407/month (Q1 2026, NSI preliminary; net ~€1,022); minimum wage €615 — [Novinite](https://www.novinite.com/articles/238531/Bulgaria+Wages+Rise+13,+Average+Salary+Surpasses+1,400+Euros), [countryeconomy](https://countryeconomy.com/national-minimum-wage/bulgaria).
- Price anchors: Netflix BG €5.99–10.99/mo — [Shumen.UK](https://shumen.uk/articles/netflix-bulgaria-prices-rise-april-2026.html); Spotify Individual ~€5.62/mo — [bigmacindex](https://bigmacindex.com/spotify-prices-by-country). Anything above ~€5/mo competes with Netflix in the household budget; a *yearly* price of €8–13 does not.
- No public study exists on Bulgarian willingness to pay for safety/weather information (*verified absence in research; treat as a gap*). The proxies (9% streaming, last-in-EU e-commerce) imply a **conversion ceiling of ~1–2%** of active users for any paid tier, before applying the freemium discount below.

### 2.4 The honest B2C funnel [MVP]

Composite model (all inputs cited above or in §2.5; mid-points are this reviewer's estimates):

| Funnel stage | Range | Basis |
|---|---|---|
| Season-1 in-season MAU (no viral fire) | 10k–50k | AirBG.info trajectory (§5.6), empty niche, media embed strategy |
| Viral-fire spike (days) | 100k–300k | Watch Duty gained 600k users in one day during LA fires ([Firehouse](https://www.firehouse.com/technology/mobile-technology-accessories/news/55259836/watch-duty-app-gains-600k-users-in-one-day-for-updates-on-ca-wildfires)); scale to BG population ×media reach |
| Off-season MAU | 3k–10k | Fitness-app seasonality analogue: −50–70% post-peak ([retentioncheck](https://retentioncheck.com/churn-benchmarks/fitness-apps)) |
| Yearly actives, year 1 | 30k–120k | Sum of above with churn |
| Supporter conversion | **0.3–0.8%** | Watch Duty converts 0.8% in the US (§2.5); discount for BG WTP (§2.3) |
| Supporter price | €8–13/yr (15–25 BGN) | Below Spotify-monthly psychological ceiling; annual-only (§2.6) |
| **B2C revenue, season 1–2** | **€500–5,000/yr** | — |

That range covers infrastructure (€72–252/yr at the stated €6–21/mo) and nothing else. **Conclusion: B2C in Bulgaria is a legitimacy and community channel, not a business.** Every strategic decision downstream of this number — funding, B2B priority, founder time — follows from accepting it early.

Sensitivity grid (annual B2C revenue in €, supporters × annual price):

| Conversion × yearly actives | €8/yr | €13/yr | €18/yr |
|---|---|---|---|
| 0.3% × 30k actives (90 supporters) | 720 | 1,170 | 1,620 |
| 0.5% × 60k actives (300 supporters) | 2,400 | 3,900 | 5,400 |
| 0.8% × 120k actives (960 supporters) | 7,680 | 12,480 | 17,280 |

Even the best cell — which requires Watch-Duty-level conversion in the EU's lowest-WTP subscription market *and* a big viral season — does not fund a salary. €18/yr (35 BGN) is above the tested 15–25 BGN band and is included only as a stretch reference. The grid is the single most important table in this review: pin it above the desk before any B2C monetization work.

### 2.5 Benchmark evidence (why the funnel is shaped this way)

- **Watch Duty** ([2025 Annual Report](https://www.watchduty.org/blog/2025-annual-report)): 16.8M yearly active users (2.3x y/y), 1.17B page views, peak 8M users during the January 2025 LA fires. Members: **135,223** (Basic $24.99/yr: 111,124; Pro $99/yr: 24,099 — Pro grew **6.8x**). Membership revenue $5.58M + grants/donations $5.63M = $11.4M. **Conversion: 135,223 / 16.8M ≈ 0.80%** of yearly actives — in the world's richest consumer market, with the world's best wildfire brand, in a nonprofit "support the mission" framing. Cost per user served: $0.39. Expanded to all 50 US states Dec 2025, added floods Jun 2026; **no international expansion announced** — [Wikipedia](https://en.wikipedia.org/wiki/Watch_Duty), [Carrier Management](https://www.carriermanagement.com/news/2026/06/25/289440.htm).
- **Flightradar24:** >1.5M paying subscribers on ~60M monthly visitors ≈ **2.5%**, with 24/7/365 global utility (no seasonality) and two decades of brand; revenue SEK 420M (~$41.4M, 2024) — [Mexico Business News](https://mexicobusiness.news/aerospace/news/flightradar24-sells-35-stake-us500-million), [Irish Examiner](https://www.irishexaminer.com/news/spotlight/arid-41805173.html).
- **Windy:** Premium $2.99/mo or ~$24.99–29.99/yr ([App Store](https://apps.apple.com/us/app/windy-com/id1161387262)) — but its "Active fires" layer is **free** ([Windy Community](https://community.windy.com/topic/10126/new-map-on-windy-active-fires)). Raw satellite detections are already a commodity; the monetizable layer is curation, geofenced alerting, and local trust.
- **RevenueCat State of Subscription Apps 2025** (75k+ apps): median download→paid conversion **2.2% freemium vs 12.1% hard paywall** — [RevenueCat](https://www.revenuecat.com/state-of-subscription-apps-2025). A hard paywall is ethically closed to fire-watch (§2.7), so plan on the 2.2% *ceiling*, then discount for BG WTP.
- **Retention:** ~30% of annual subscribers cancel within the first month; cheap annual plans retain up to ~36% at 1 year vs ~6.7% for expensive monthlies; <10% of monthly subscribers reach year 2 — [RevenueCat 2026](https://www.revenuecat.com/state-of-subscription-apps), [SaaStr summary](https://saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth).

### 2.6 Seasonality and pricing mechanics [v1]

Fire demand is bimodal (spring stubble peak + summer peak, §2.2) and collapses in winter. Direct churn benchmarks for seasonal safety apps do not exist publicly (*verified absence*); the closest analogue, fitness apps, shows 3–4x January peaks decaying 50–70% by March. Implications:

- **Annual-only billing for the supporter tier.** Monthly billing invites October cancellation en masse; annual billing shifts churn risk to renewal and cuts it 60–80% — [eightx](https://eightx.co/blog/average-subscription-churn-rate-by-category).
- **Renew in May, not January.** Time the renewal cohort to land just before the season, when perceived value peaks.
- Expect ~30% of annual supporters to cancel in month 1 (benchmark above) — set refund policy accordingly and don't over-forecast year-2 renewals above ~40%.

### 2.7 The freemium boundary — stress-tested [MVP]

Watch Duty's position is the template: membership was "never intended as a paywall"; everything safety-critical is free, unregistered, ad-free; paid unlocks are *conveniences* — alerts beyond 4 counties, the air-tanker tracker, more saved locations — [Watch Duty membership blog](https://www.watchduty.org/blog/our-new-membership-program), [Press Democrat](https://www.pressdemocrat.com/article/news/how-watch-duty-app-works/).

**Never paid, ever (publish this as policy):** the live map; all active detections; official warnings/evacuation info; the first 1–2 saved locations with alerts; the embeddable widget for media (§5.5).
**Fair to charge for [v1]:** 3+ saved locations / geofences; historical archive & season retrospectives; SMS fallback delivery (carries real per-message cost); ad-free is not a lever (there are no ads); "supporter" badge and changelog access.
**Fair to charge for [v2]:** API access; CSV/GeoJSON export; team accounts — but these belong to the B2B ladder (§3), not B2C.

Why this boundary is also commercially optimal: (a) any hint of gated safety data in a country with BG-ALERT's track record would be a press disaster and would forfeit the partnership stack in §4; (b) the conversion delta between "supporter framing" and "feature paywall" is small at BG volumes (§2.4 says the whole pool is €500–5k), while the trust delta is existential; (c) Watch Duty's $5.6M/yr in grants and donations was *earned by* the free posture — the same is true for every funder in §5 and §6.

### 2.8 Balkan expansion — real but sequenced [v2]

- Greece: 10.37M people, 47,819 ha burned 2025. **No local consumer app**: fotiestora.gr is a free web map (FIRMS, 5-min refresh, no mobile app, no alerts, no paid tier — [fotiestora.gr](https://fotiestora.gr/en)); the state's 112 is cell broadcast, not an app ([civilprotection.gov.gr](https://civilprotection.gov.gr/en/112)); NOA/BEYOND's FireHub is an expert layer, free, covering the Balkans (MSG/SEVIRI, 5-min — [FireHub](https://beyond-eocenter.eu/firehub.html)). The consumer niche is open — but Greece is also where OroraTech just became the *national system* (§6.1), so the institutional layer is taken.
- Serbia (6.7M) and W. Balkans: pozari.org covers 6 countries with 10-min FIRMS but has no app, no push, and no Bulgaria — [pozari.org](https://www.pozari.org/). Partner-or-compete decision deferred to v2 (§10 Q9).
- North Macedonia (1.81M) and Turkish Thrace (~2.0M: Edirne, Kırklareli, Tekirdağ — [Wikipedia](https://en.wikipedia.org/wiki/Edirne_Province)) are natural map-coverage extensions (the satellite footprint is already there at near-zero marginal cost) but not GTM targets before Bulgaria is won.
- **Rule: expansion is a data-coverage feature in v1 (show fires across borders — smoke doesn't stop at Кулата), and a GTM motion only in v2** after the Bulgarian playbook is proven.

### 2.9 The "why now": BG-ALERT's documented failure record

BG-ALERT — the state's cell-broadcast warning system (built by МВР + Ministry of e-Government; activation by ministers, the 28 regional governors, and mayors; 266 officials trained by Aug 2025) — is fire-watch's institutional context and its strongest positioning argument:

- **Voden, Yambol province (Jul 2024):** ~35 homes destroyed with **no BG-ALERT sent**; officials blamed power/coverage loss — [Boulevard Bulgaria](https://boulevardbulgaria.bg/articles/sezonat-na-pozharite-bg-alert-ne-raboti-no-ne-samo-toy).
- **89 real activations in 2025**, of which 36 for fires and 13 for fire risk (regional-press summary of official data; original article now offline — *secondary source*).
- **68 municipalities (25.6%) could not operate the system independently** as of Oct 2025, prompting a prime-ministerial ultimatum — [Paragraf.bg](https://paragraf.bg/edna-chetvart-ot-obshtinite-v-balgariya-vse-oshte-ne-mogat-da-rabotyat-s-bg-alert/); **21 mayors refused to use it at all** — [Sega](https://www.segabg.com/hot/category-bulgaria/21-kmeta-ne-sa-pozhelali-da-polzvat-sistemata-bg-alert).
- National-press verdict: "more chaos and problems than solutions" — untrained senders, thin legal basis, panic-inducing tests — [Sega](https://www.segabg.com/hot/category-bulgaria/bg-alert-e-poveche-haos-i-problem-otkolkoto-reshenie-i-spasenie). During the 2025 coastal fires, residents reported late or missing alerts and the fire service had to explain publicly why some phones received nothing — [News.bg](https://news.bg/society/shefat-na-pozharnata-obyasni-zashto-nyakoi-hora-ne-sa-poluchili-saobshtenie-ot-bg-alert.html).

**Positioning consequence [MVP]:** fire-watch answers the question BG-ALERT structurally cannot — "what is actually burning near me, right now?" — without claiming life-safety status. Let journalists make the comparison (§7.2); fire-watch itself always frames as a *complement* to official channels, never a replacement.

### 2.10 What the market sizing implies for product scope

The commercial analysis feeds back into build priorities without touching engineering decisions:

- **Alerts, not the map, are the product.** The map is table stakes any clone can ship; alert trust (precision, latency, fail-closed) is what the north star measures and what B2B buys (§3.3). Every scope trade-off resolves in favour of the alert path.
- **Android + PWA first** matches both the BG device mix and the EU Fires gap (iOS-only) — the cheapest possible differentiation (§6.3).
- **Bulgarian-language depth** (ГДПБЗН bulletins, local place names, community reports) is the layer no international generalist replicates remotely — it is simultaneously product and moat.
- **Annual-only billing renewing in May** (§2.6) is a hard product decision, not a payments detail — monthly billing in a 3-month season guarantees churn theatre.
- **The embeddable widget and per-fire share pages** are growth infrastructure, not extras — they are the only acquisition channels the €0 marketing budget permits (§7.2).
- **The detection archive** (backfill week 1) compounds: QA ground truth now, B2B replay demos in autumn, and the only dataset nobody else in Bulgaria will have accumulated by the time competitors wake up.

---

## 3. B2B deep-dive — seven segments, ranked

### 3.0 The procurement unlock

Bulgaria's post-euro ЗОП direct-award thresholds (2026): **services/supplies ≤ €25,565**, construction ≤ €40,903, social services ≤ €51,129. A €200–500/month subscription (€2,400–6,000/yr) sits comfortably under the services ceiling — **public bodies can buy fire-watch with a direct award, no tender**. This single fact shapes the entire B2B motion: price every public-sector offer to stay under €25,565/yr.

### 3.1 Segment cards

**S1. Forestry — ИАГ + 6 state enterprises (ЮЗДП, ЮЦДП, СИДП, СЗДП, СЦДП, ЮИДП) and their ~165 ДГС/ДЛС units**
- *Pain (documented):* ИАГ's own plan calls for **267 automated observation stations; only 26 posts exist (25 towers), of which 13 function**; ЮЗДП's 9 towers are non-functional. 2025 damages: 17.5M BGN in one season (§2.2). Fires are detected by phone calls and luck.
- *Buyer:* enterprise director / deputy for protection; ИАГ centrally for standardization. *Budget reality (WWF 2026 analysis — [PDF](https://wwfeu.awsassets.panda.org/downloads/wwf_forest-fire-analysis-2026.pdf)):* the six enterprises spent only **20.7M BGN on fire protection across 2012–2024 combined (~1.6M BGN/yr, chronically underspent)**, and ЮЗДП is in financial distress (debts >€15M, falling timber revenue — [Blitz](https://blitz.bg/regioni/yudzp-e-v-finansov-kolaps-dalgovete-sa-nad-15-mln-evro_news1154340.html)). The realistic wallet is **EU project money**: ПРСР подмярка 8.3 (40M BGN; eligible costs explicitly included fire-monitoring and communication equipment) and its successor fire-prevention intervention in the CAP Strategic Plan 2023–27 ([sp2023.bg](https://www.sp2023.bg/index.php/bg/)) — structure the offer so a ДП/ДГС can fund it from those lines, not from own cash.
- *WTP estimate:* €200–500/mo per enterprise in season (satellite alerting for their whole territory costs less than staffing one tower). *Accounts:* 6 enterprises + ИАГ + ~165 units (upsell path).
- *Sales motion:* direct award; demo built on their 2024–2025 fires replayed from FIRMS archive ("we would have alerted you at T+18 min on Ilindentsi"). *Needs:* territory-boundary geofences, e-mail/Viber alerts to duty officers, seasonal reports for ИАГ compliance.
- *Risk:* state-budget politics; a national tower/camera procurement (or an OroraTech-style government deal, §6.1) could leapfrog; domestic integrators already own the camera niche — **Lirex claims tower/camera systems covering ~9% of Bulgarian forests** ([lirex.com](https://lirex.com/bg/news/sistema-za-ranno-otkrivane-na-gorski-pozhari/)), ITA Group installs thermal-camera detection ([itagroup.bg](https://www.itagroup.bg/предотвратяване-на-горски-пожари.html)). Position satellite geofence alerting as the cheap wide-area *now* layer that complements any camera network — and treat the integrators as potential channel partners rather than rivals.

**S2. Agriculture — large grain producers**
- *Structure:* 132,742 farms, but **7,629 farms ≥100 ha control 75% of the 4.56M ha** of utilized agricultural area (2020 census); the top tier is tiny — **359 grain holdings above 1,415 ha (avg 2,485 ha) manage 23% of cultivated area** ([agri.bg](https://agri.bg/novini/golemi-stopanstva)) — so the target list is short and organized (НАЗ, the grain producers' association).
- *Pain:* harvest-season combine and stubble fires — a weekly July news item, with authorities warning of up to 350 fires/day at the 2026 summer peak ([Flagman](https://www.flagman.bg/таг/пожар%20слънчев%20бряг)); spring burning that escapes; ИАГ data shows agricultural origin for a large share of forest fires. A paid-agtech habit exists among large arable holdings: NIK Group alone claims 2,500+ precision-agriculture clients ([bg.nik.group](https://bg.nik.group/)).
- *WTP estimate:* €50–150/season per holding for geofenced alerts on their parcels + neighbouring land. *Sales motion:* via НАЗ and agri-insurers as channels; seasonal product (May–September).
- *Why not beachhead:* individually small tickets, seasonal-only engagement, and the buyer must be educated that 3-h FIRMS latency still beats "the neighbour called".

**S3. Insurance — property & agri lines**
- *Market:* 4.69B BGN gross premium 2024 (+6.7%); non-life 3.91B BGN across 26 non-life insurers ([КФН](https://www.fsc.bg/rezultati-ot-dejnostta-na-mestnite-zastrahovateli-kam-kraya-na-2024-g/)); penetration only ~2.2–2.3% of GDP (*estimate*). Crop insurance is small and shrinking without subsidy — ДФЗ premium-subsidy uptake fell from 547 beneficiaries / 1.8M BGN (2022) to 246 / 883k BGN (2023) ([bgfermer](https://www.bgfermer.bg/Article/19885449)). **No parametric crop/wildfire product exists in Bulgaria** (verified absence across sources) — a genuine [v2] white space.
- *Use cases:* exposure monitoring during events, claims triage/verification against detection archive, eventually parametric triggers.
- *WTP estimate:* €500–2,000/yr pilots; real money only at [v2] data-quality maturity (audited archive, documented precision). *Sales cycle:* 12–18 months, needs an actuarial champion. OroraTech is entering insurance in the West — validation and eventual competition.
- *Verdict:* v2 segment. Collect the archive now (week-1 FIRMS backfill per review 00-summary T5) so the data asset exists when this door opens.

**S4. Energy — PV parks, wind, grid infrastructure**
- *Market:* **5.984 GW installed PV; PV = 36.6% of generation** at 2025 peaks; grass fires under panel rows and around substations are a known O&M hazard; ЕСО (TSO) already runs vegetation-clearing procurement around lines — fire risk is a budgeted category (one ЕСО corridor-clearing contract alone covered 68,555 dka — [openprocurements](https://bg.openprocurements.com/tender/2020-pochistvane-na-servituti-na-elektroprovodi-ot-prenosnata-mrezha-na-r-b-lgariia-obsluzhvani-ot-e/)). Honesty note: no major wildfire-caused PV-asset loss is documented in BG for 2024–25 — the sell is preventive/insurance-driven, like every fire product.
- *Validation:* Pano AI charges **~$50,000/station/year** for camera-based detection and utilities pay it ([Colorado Sun](https://coloradosun.com/2023/11/09/ai-wildfire-panos-colorado-xcel-energy/)); a satellite-based €100–500/mo portfolio-monitoring service is an easy comparative sell for assets that can't justify cameras.
- *Buyer:* O&M managers of PV portfolio operators (private — no ЗОП friction at all), ЕСО/ЕРП security departments (direct award).
- *Needs:* geofences around sites and line corridors, alert-to-Viber/e-mail for the 24/7 dispatch desk, monthly exposure reports. All exist in the [v1] alert stack — near-zero marginal product work.
- *WTP estimate:* €100–500/mo per portfolio; *accounts:* dozens of portfolio operators + 3 ЕРП + ЕСО.

**S5. Municipalities (265)**
- *Pain (documented):* 68 municipalities (25.6%) couldn't operate BG-ALERT independently as of Oct 2025; 21 mayors refused to use it; PM ultimatum followed — [Paragraf.bg](https://paragraf.bg/edna-chetvart-ot-obshtinite-v-balgariya-vse-oshte-ne-mogat-da-rabotyat-s-bg-alert/), [Sega](https://www.segabg.com/hot/category-bulgaria/21-kmeta-ne-sa-pozhelali-da-polzvat-sistemata-bg-alert). Mayors are legally responsible for disaster protection and politically exposed after Voden and Elenite (§2.9).
- *WTP:* €50–200/mo; ЗОП direct award makes the transaction trivial, but budgets are poor and the sale is 265 separate conversations. Channel: НСОРБ (which already co-ran the Esri situational map, §6.4).
- *Verdict:* fast-follow after beachheads — sell the *same* product with a municipal-boundary geofence; let the first viral fire generate inbound.

**S6. NGOs, hunting concessions, volunteer formations**
- WWF, НАДРБ, hunting estates (ДЛС already counted in S1). WTP €10–50/mo at best. **Treat as partnership/distribution (§4), not revenue.** НЛРС-СЛРБ unites ~150 hunting-fishing associations (~30k organized hunters — [slrb.bg](https://www.slrb.bg/chlenstvo/); membership figures circulate widely, treat as uncertain). Free accounts for registered volunteer formations are a GTM investment with outsized trust returns.

**S7. Real estate, tourism, campsites**
- Black Sea and mountain resorts (the Elenite fatality made this visceral), campsite operators, premium rural property managers. Seasonal, fragmented, low WTP (€10–50/mo), high PR value. v2 self-serve tier — never worth direct sales effort.

### 3.2 Ranking (revenue potential × ease of entry)

| Rank | Segment | Revenue potential | Ease | Why |
|---|---|---|---|---|
| **1** | **S4 Energy/PV & grid** | High (€10–60k ARR by yr 2) | High | Private buyers, budgeted risk category, Pano-anchored pricing, product already built by [v1] |
| **2** | **S1 Forestry ДП/ИАГ** | High (€15–40k ARR by yr 2) | Medium | Acute documented pain (13/267 towers), direct-award path, but state-budget variance |
| 3 | S5 Municipalities | Medium (long tail) | Medium | Trivial transaction, poor budgets, 265 sales |
| 4 | S3 Insurance | High later | Low now | 12–18 mo cycles; needs audited archive |
| 5 | S2 Agriculture | Medium | Medium | Short target list via НАЗ but small tickets |
| 6 | S7 Tourism/real estate | Low | Medium | Self-serve only |
| 7 | S6 NGO/hunting | ~Nil | High | Partnership channel, not revenue |

**Beachheads: S4 (energy/PV) and S1 (forestry).** Both buy the identical [v1] product (geofences + alert routing + reports); together they justify building it once. Target for M12: **two paid pilots or signed LOIs, one from each.** [v1]

### 3.3 The B2B product ladder [v1]

The crucial economy: B2B is *packaging*, not a second product. Every tier below runs on the same detection pipeline and alert engine as the free consumer map — marginal engineering is geofence management, recipient routing, and report generation.

| Tier | Contents | Price band | Target |
|---|---|---|---|
| **Pilot (one season)** | 5 geofences, e-mail + Viber alert routing, weekly PDF summary | €0–100/mo, capped at one season | First 3 logos in S4/S1 — reference value exceeds revenue |
| **Standard** | 25 geofences, multi-recipient routing, monthly exposure report, detection-archive access | €200–350/mo | PV portfolio operators, individual ДГС/ДЛС units |
| **Enterprise / authority** | Full-territory boundaries, API/GeoJSON export, processing-latency SLA, seasonal report in ИАГ-compatible format | €400–500/mo (≤€6k/yr — under the ЗОП direct-award ceiling by design) | ДП enterprises, ЕСО/ЕРП, municipalities |

Contract mechanics [v1]:
- **SLA wording discipline:** commit to *processing* latency (detection-received → alert-sent), never to satellite availability — upstream (NASA/EUMETSAT) is outside anyone's control, and review T-themes already mandate honesty about it.
- **Liability:** property-damage-only caps in B2B contracts (ЗЗП does not apply B2B — §5.5); no consequential-damages exposure.
- **Sales asset:** the replay demo — the prospect's own 2024–2025 fires re-run from the FIRMS archive with timestamps ("first detection over your territory at 14:42, your first phone call came at 16:10"). This is why the week-1 archive backfill is a *business* requirement, not a nice-to-have.
- **Conversion discipline:** pilot→paid target ≥50%; a pilot that will not convert is marketing spend, and the budget for that is zero — cap free pilots at three, ever.

---

## 4. Partnerships — the distribution stack

Ordered by (leverage × attainability) for a solo founder:

1. **WWF Bulgaria — the anchor NGO partner [MVP].** The most data-native NGO on this topic: publishes annual EFFIS-based fire analyses picked up by national media ([News.bg](https://news.bg/society/wwf-merkite-sreshtu-gorski-pozhari-v-balgariya-ne-sa-adekvatni-na-rastyashtiya-risk.html)), runs a public fire campaign and a donation drive equipping НАДРБ volunteers and Green Balkans ([dari.wwf.bg/pozhari](https://www.dari.wwf.bg/pozhari)), and *publicly demands* better fire monitoring — i.e., asks for roughly what fire-watch builds. Ask: co-branding/endorsement of the season-1 launch + data for their 2027 analysis. Cost: a meeting and a free forever tier.
2. **НАДРБ + volunteer formations — the seed user base [MVP].** Legal base: Disaster Protection Act + ПМС 123/2012; municipal mayors contract volunteers; MVR keeps a public register (updated 17 Jul 2026) — [mvr.bg](https://www.mvr.bg/gdpbzn/%D0%B4%D0%B8%D1%80%D0%B5%D0%BA%D1%86%D0%B8%D1%8F%D1%82%D0%B0/%D0%B4%D0%B5%D0%B9%D0%BD%D0%BE%D1%81%D1%82%D0%B8-%D0%BD%D0%B0-%D0%B3%D0%B4%D0%BF%D0%B1%D0%B7%D0%BD/dobrovolni_form), [navrb.bg](https://navrb.bg/vklyuchi-se-kato-dobrovolets/). Registry snapshot (09 Apr 2026, via the WWF 2026 analysis): **286 formations — 255 municipal with 3,647 volunteers covering 252 of 265 municipalities (95.1%), plus 31 corporate formations with 466 volunteers**. These are the Bulgarian analogue of Watch Duty's reporter culture: motivated, geographically distributed, phone-first. Free accounts + a "verified volunteer" report badge [v1].
3. **Meteo Balkans + regional media — the reach multiplier [MVP].** Meteo Balkans (~176k Facebook likes per public snapshot — [facebook.com/meteobalkans](https://www.facebook.com/meteobalkans/); true reach likely higher, *estimate*) already posts FIRMS screenshots as news but has no live product; their own weather app has negligible adoption. Offer: a co-branded live fire layer/embed — they supply audience, fire-watch supplies the map. Regional outlets (e-svilengrad.com, haskovo.info) cover fires near-weekly with zero maps ([tag page](https://e-svilengrad.com/tag/%D0%BF%D0%BE%D0%B6%D0%B0%D1%80/)); Dunavmost already embedded the Esri map once ([dunavmost.com](https://www.dunavmost.com/novini/karta-na-pozharite-v-balgariya)). Build the **embeddable widget, free with attribution** [v1] — it is the single highest-leverage distribution feature in the whole plan. Risk to manage: Meteo Balkans is also the fastest actor who could commission a competing layer (§6.4).
4. **Viber — the alert channel Bulgaria actually uses [v1].** >90% of Bulgarian smartphone users are on Viber ([Investor.bg](https://www.investor.bg/a/456-web/259338-viber-se-polzva-ot-nad-90-ot-balgarskite-potrebiteli-na-smartfoni)). A fire-watch Viber channel/bot beats Telegram for BG reach (no significant BG fire-alert Telegram channel exists — *search-verified absence*). Also the natural B2B alert delivery transport (§3.1 S4).
5. **ГДПБЗН — complement, never compete [v1 for formal contact].** Their National Operational Center already monitors EFFIS in real time (Interior Minister's parliamentary answer, Aug 2025 — [Focus News](https://www.focus-news.net/novini/Bylgaria/Bulgariya-izpolzva-sistemite-na-ES-za-borba-s-pozharite-u-nas-2663505)) — the data sources are institutionally pre-legitimized. Precedent for state–NGO map cooperation exists (ASDE/ReSAC FIRMS map lists ГДПБС-МВР and NASA as partners — [bsdi.asde-bg.org](https://bsdi.asde-bg.org/fires.php); "Защити гората" is co-branded by ИАГ — [app.gorata.bg](https://app.gorata.bg/about)). Approach *after* season-1 credibility, framed as "independent complement to BG-ALERT", never as replacement. БЧК: formal, slow, memorandum-driven — a v2 legitimacy partner.
6. **Google/Apple crisis layers — closed doors; plan accordingly.** Google's wildfire layer takes only official CAP feeds (Public Alerts), NIFC data, and its own satellite pipeline ([Google Maps help](https://support.google.com/maps/answer/9985621?hl=en), [developers.google.com/public-alerts](https://developers.google.com/public-alerts)); Bulgaria is not in the 15-country boundary coverage. Apple routes via Meteoalarm. **A solo third party cannot feed either.** The realistic play: advocate that МВР publish a CAP feed (v2 policy work), and meanwhile own the niche they leave empty.
7. **Infrastructure sponsorships — copy Fogos.pt [MVP].** Fogos.pt runs on sponsored services: Cloudflare Project Galileo (free DDoS protection for public-interest sites — [Cloudflare blog](https://blog.cloudflare.com/wildfire-fogos-pt-portugal-ddos-attack/)) and Mapbox sponsorship — [fogos.pt/en/sobre](https://fogos.pt/en/sobre). Apply for Project Galileo before launch; it directly mitigates the success-disaster risk (§9 R1).
8. **Playbook precedent — AirBG.info.** Код: България's air-quality network reached ~1,000 citizen stations in ~2 years via FB communities + earned media + credible independent voices ([yurukov.net](https://yurukov.net/blog/2019/airsofia-e-vajen/), [airbg.info](https://airbg.info/en/)). This is the closest Bulgarian mass-adoption template: civic framing, transparency, no ads, invite scrutiny.

### Outreach sequencing (who, when, the ask, what success looks like)

| # | Partner | When | The ask | Success = |
|---|---|---|---|---|
| 1 | Cloudflare Project Galileo + Mapbox community | Q4 2026 | Sponsored infrastructure (Fogos.pt precedent) | Approved before public launch |
| 2 | WWF Bulgaria | Q4 2026 – Q1 2027 | Endorsement + co-launch + data for their 2027 analysis | Joint announcement in the May 2027 launch |
| 3 | НАДРБ + volunteer formations | Q1 2027 | Beta cohort, feedback on alert workflow | 100+ volunteer accounts by Apr 2027 |
| 4 | Meteo Balkans | Q1 2027 | Co-branded live layer / embed | Embed live before the summer season |
| 5 | Regional outlets (Haskovo, Svilengrad, Burgas, Blagoevgrad) | Apr–May 2027 | Free widget with attribution | ≥3 embeds by Jun 2027 |
| 6 | ГДПБЗН | Q4 2027 | Working-level meeting, season-1 retrospective in hand | A named contact; no formal ask yet |
| 7 | БЧК | 2028 [v2] | Memorandum | Formal legitimacy for institutional sales |

The ordering is deliberate: infrastructure before credibility, credibility before reach, reach before the state. Approaching ГДПБЗН *before* having a season of accurate operation would spend the one first impression on an unproven product.

---

## 5. EU & space funding map 2026–2027

### 5.1 Ground truth first: what does NOT exist

- **There is no ESA BIC Bulgaria** ([ESA BIC list](https://commercialisation.esa.int/esa-business-incubation-centres/)). Bulgaria is an ESA **European Cooperating State (ECS/PECS) since 2015** ([ESA](https://www.esa.int/About_Us/Corporate_news/Bulgaria_becomes_tenth_ESA_European_Cooperating_State)), signed a Joint Declaration in Dec 2025 aiming at associate membership ([МИР](https://www.mig.government.bg/all-news/bulgaria-signs-a-joint-declaration-with-the-european-space-agency/?lang=en)) — but today: **no BIC, no InCubed eligibility** (22 subscribing states, BG absent — [InCubed](https://incubed.esa.int/national-delegations/)). ESA BIC Greece (€60k) requires Greek establishment. Any plan line reading "apply to ESA BIC" must be deleted.
- **Copernicus Masters / Accelerator are dead** — copernicus.eu is an archive; startup support was absorbed into CASSINI ([archived page](https://www.copernicus.eu/en/opportunities)). FPCUP is in transition/wind-down.

### 5.2 The 2026 calendar reality (as of 22 Jul 2026)

| Instrument | Status | Note |
|---|---|---|
| CASSINI Challenges 2026 (12 × €100k, TRL≥5) | **Closed 26 Mar 2026** | 2026 winners include **Pyri — wildfire detection** ([EUSPA](https://www.euspa.europa.eu/newsroom-events/news/meet-2026-cassini-challenges-winners)) — the theme demonstrably wins |
| CASSINI Accelerator Batch 7 | **Closed 6 Mar 2026** | Batch 8 expected ~Jan–Mar 2027 (*unverified*) |
| CASSINI Hackathon #11 | Held Apr 2026 (incl. Bulgarian venue) | #12 expected; €5k prizes + mentoring, zero bureaucracy |
| НИФ (National Innovation Fund) | New rules ПМС 132/22.07.2025; new session **not yet announced**; evaluators being recruited Jun 2026 | Session likely late 2026/2027 ([nif.government.bg](https://nif.government.bg/)) |
| **Eurostars-3 Session 11** | **OPEN: 9 Jul – 10 Sep 2026**; up to €100k per BG participant, 80% intensity | Requires a foreign SME partner ([МИР/НИФ](https://www.mig.government.bg/naczionalen-inovaczionen-fond/)) |
| EIC Accelerator | Full-proposal cut-offs 2 Sep / 4 Nov 2026 ([EIC](https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en)) | Single-SME eligible, but single-digit success rates; solo founder + free-data aggregator = weak hand today |
| Interreg GR–BG SPF calls 5–6 | Closed 22 Jun 2026 | Next call *unverified* |
| Interreg Danube 3rd call | Closed 15 Dec 2025 | Consortium-only anyway |
| Interreg BG–TR | Had a direct SME call (2023–24, climate resilience) — precedent; 2026 window *unverified* | Watch ipa-bgtr.mrrb.bg |
| EEA/Norway Grants BG 2021–2028 | MoU signed 18 Nov 2025, **€260M**, incl. "Green Business and Innovation" ([eeagrants.org](https://eeagrants.org/en/fmo/countries/bulgaria)) | Business calls realistically 2027; historically €200k–1M direct SME grants |
| ПКИП | BG16RFPR001-1.010 expected 2026; most procedures require closed financial years | Watch [МИР](https://www.mig.government.bg/programa-konkurentosposobnost-i-inovaczii-v-predpriyatiyata/proczeduri-po-pkip/) |
| Vitosha Ventures II (equity) | Active — €34M, tickets €100k–1M, first 10 investments Jul 2026 ([Capital](https://www.capital.bg/biznes/startup/2026/07/16/4935743_vitosha_nabira_visochina_s_purvi_deset_investicii/)) | ФнФ selecting managers for €75M more — new pre-seed funds coming 2026–27 |
| Horizon Europe CL3 2026–27 (DRS topics incl. wildfire; CL3-2027-01-DRS-03 "decision support systems") | Calls per WP ([WP PDF](https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/wp-call/2026-2027/wp-6-civil-security-for-society_horizon-2026-2027_en.pdf)) | Min. 3 entities / 3 countries + practitioner partners — not solo-viable as coordinator |

### 5.3 The solo-founder grant-time trap

Every consortium instrument (Horizon, Interreg, Danube) costs 100–300 hours to apply, months of partner coordination, and pays on reimbursement schedules that assume an admin team. For a solo founder, **one Horizon application ≈ one season of product work**. Rule: in year 1, apply only to instruments that are (a) single-applicant, (b) cash-prize or high-advance, (c) ≤40 hours of application effort. That whitelist is exactly: CASSINI Challenges, CASSINI Hackathon, НИФ, EEA Green Business (when open), and equity.

### 5.4 Recommended funding sequence

1. **Now → Dec 2026 [MVP]:** Bootstrap. Enroll in the free EUSPA Space Academy ([eu-space.europa.eu](https://eu-space.europa.eu/explore-eu-space/education-and-training/euspa-space-academy)). Eurostars S11 (deadline 10 Sep) **only if** a credible foreign SME partner (e.g., a Greek EO startup) materializes without courtship overhead — otherwise skip without guilt.
2. **Q1–Q2 2027 [v1]:** CASSINI Challenges 2027 (€100k, no consortium, wildfire precedent — the highest-fit instrument on the board) + CASSINI Accelerator Batch 8 + НИФ new session + CASSINI Hackathon #12 as a low-cost PR/recruiting event.
3. **2027+ [v1/v2]:** EEA/Norway "Green Business and Innovation" call when published; ПКИП innovation procedure if the company has a closed financial year by then; Vitosha II / new ФнФ pre-seed funds as the equity path if B2B traction (§3.2) is real and the founder *wants* to scale rather than run a lifestyle/civic hybrid.
4. **Never in year 1:** Horizon CL3 as coordinator; Interreg consortium projects; EIC Accelerator (revisit at [v2] with team + traction; CL3-2027-01-DRS-03 only as a small tech partner in someone else's consortium, e.g., via an academic/ГДПБЗН-adjacent group).

### 5.5 Legal vehicle, tax, VAT, and payment rails [MVP]

Business mechanics verified against 2026 (euro-era) Bulgarian law; the full legal treatment lives in review 09 — this is the commercial view.

- **VAT:** the mandatory-registration threshold from 1 Jan 2026 is **€51,130 calendar-year domestic turnover** (чл. 96 ЗДДС as amended ДВ 115/30.12.2025 — [lex.bg](https://lex.bg/laws/ldoc/2135533201)); a bill to raise it to €85,000 from 2027 is only a proposal ([vatupdate](https://www.vatupdate.com/2026/05/14/bulgaria-proposes-higher-vat-registration-threshold-for-small-businesses/)). The new **EU SME scheme** (Глава 21б ЗДДС, transposing Directive 2020/285) allows selling across the EU with **no foreign VAT registrations** while domestic turnover ≤ €51,130 *and* EU-wide turnover ≤ €100,000 ("EX" identification, quarterly turnover reports). Cross-border B2C above thresholds → OSS (€10k trigger — [EC OSS portal](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en)); B2B SaaS → reverse charge (invoice without VAT + VIES declaration). Practical read: every revenue scenario in §9.3 stays far below every threshold for at least two years — VAT is an administrative non-event if reviewed annually.
- **Entity and the hybrid question (feeds Q1/Q2):** ЕООД — 10% CIT, 5% dividend WHT to individuals; the discussed hike to 10% was **not adopted** as of Jul 2026 ([PwC](https://taxsummaries.pwc.com/bulgaria/corporate/withholding-taxes)). Association (ЮЛНЦ): genuine membership dues are VAT-exempt (чл. 44(1)(3) ЗДДС) and non-taxable — **but** НАП re-qualifies "membership" that is really paid access to services as commercial activity ([БЦНП Q&A](https://bcnl.org/uploadfiles/documents/analyses/qa12.pdf)); the supporter tier with premium unlocks (§2.7) almost certainly does *not* qualify as exempt dues. The standard structure for the civic-institution path is the **hybrid: сдружение (mission, grants, Interreg lead-partner eligibility) + ЕООД (B2B contracts; CASSINI/EIC eligibility)** — noting a dividend from the ЕООД to the association likely carries 5% WHT (*unverified — check чл. 194 ЗКПО*). Eligibility mapping: CASSINI Challenges accepts "economic operators (natural or legal persons)" including individuals ≥18 — applying even pre-incorporation is possible ([EUSPA rules](https://www.euspa.europa.eu/cassinichallenges)); EIC Accelerator requires a for-profit SME; Interreg Danube allows nonprofits as *lead* partner while for-profits may only be ordinary partners ([Interreg Danube FAQ](https://interreg-danube.eu/frequently-asked-questions)).
- **Payments [v1]:** for the €8–13/yr B2C supporter tier use a **merchant of record** — Paddle supports Bulgarian sellers (~5% + $0.50/txn — [Paddle](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle)) and absorbs all EU VAT/OSS administration; Lemon Squeezy is the MoR alternative. Stripe is *not* an MoR (Stripe Tax only calculates) — use Stripe or bank transfer for B2B reverse-charge invoices, where it is cheaper.
- **Name & trademark [v1]:** EUTM €850 for one class (+€50 second, +€150 each further; 10-year validity — [EUIPO fees](https://www.euipo.europa.eu/en/trade-marks/before-applying/fees-payments)); search eSearch plus + TMview before committing to the brand. Avoid anything implying official status — "национален", "държавен", "агенция", state symbols: чл. 7(2) ТЗ (misleading company names) plus ЗМГО чл. 11(1)(7)–(9) / Paris Convention 6ter block both the company name and the mark.
- **Liability boundary [MVP]:** under ЗЗП чл. 143(2)(1), a B2C clause excluding liability for **death or bodily injury is void** (unfair terms, nullity per чл. 146 — [lex.bg](https://lex.bg/laws/ldoc/2135513678)), and ЗЗД чл. 45 presumes fault in tort. Consequence: the visible, permanent disclaimer — "informational service; not a substitute for official warnings and 112" — is not boilerplate, it *is* the liability architecture (and it matches the trust positioning in §2.7 anyway). Property-damage limitation clauses belong in B2B contracts, where ЗЗП does not apply.

### 5.6 Funding action calendar (Q3 2026 → Q4 2027)

Condensing §5.2–5.4 into a founder's quarter-by-quarter checklist, with the honest hour cost attached to each action:

| Window | Action | Est. effort | Default |
|---|---|---|---|
| by 10 Sep 2026 | Eurostars-3 S11 — *only* if a foreign SME partner already exists (§10 Q7) | 60–100 h | **Skip** unless partner materializes |
| Q4 2026 | EUSPA Space Academy modules; Cloudflare Project Galileo + Mapbox community applications; subscribe to НИФ announcements | <10 h total | Do all three |
| Q1 2027 | CASSINI Accelerator Batch 8 application; CASSINI Challenges 2027 if the call opens | 20–40 h each | Do — highest-fit instruments |
| Q2 2027 | CASSINI Hackathon #12 (PR + recruiting value even without winning); НИФ session if opened under ПМС 132/2025 rules | 10 h / 40–80 h | Hackathon yes; НИФ yes if session confirmed |
| Q3–Q4 2027 | EEA/Norway "Green Business" call if published; ПКИП innovation-voucher check; Vitosha Ventures II conversation *only if* CP3 lands green | varies | Gate on CP3 |

Everything outside this table (Horizon Europe consortia, Interreg partnerships, LIFE) fails the §5.3 whitelist rule for year 1 and is deferred to [v2] regardless of how attractive an individual call looks.

### 5.7 Instrument fit scores (derived summary)

Scoring the instruments from §5.2 on product fit (does the call want *this* product?), solo-feasibility (can one person apply and execute?), and expected value (award size × realistic win probability ÷ effort):

| Instrument | Product fit | Solo-feasible | Expected value | Verdict |
|---|---|---|---|---|
| CASSINI Challenges 2027 | Excellent (EO downstream; 2026 wildfire winner Pyri is precedent) | Yes — accepts individuals ≥18 | High | **Primary target** |
| CASSINI Accelerator B8 | Good (services + visibility, smaller cash) | Yes | Medium–High | Apply |
| CASSINI Hackathon #12 | Indirect (PR, network, recruiting) | Yes | Medium (non-cash) | Attend |
| НИФ (new session, ~2027) | Good (national innovation, BG entity) | Yes, with accountant support | Medium (*rules unverified*) | Apply if session opens |
| EEA/Norway Green Business | Good (green/civic frame) | Yes | Medium (timing risk — likely 2027+) | Watch quarterly |
| Eurostars-3 S11 | Good on paper | **No** — requires foreign SME partner | Low without existing partner | Skip by default |
| EIC Accelerator | Weak at this stage (wants scale-ready SMEs) | Formally yes, practically no | Low | Defer to [v2] |
| Horizon Europe / Interreg / LIFE | Varies | **No** — consortium overhead 100–300 h | Negative at solo stage | Defer to [v2] |
| Vitosha Ventures II / ФнФ | N/A (equity, not grant) | Yes | Conditional | Only after CP3 green (§9.3 C) |

---

## 6. Competition — and "what if they wake up"

### 6.1 Well-funded B2G/B2B players (validation, not collision — yet)

- **OroraTech** (Munich, Series B extended to **€37M** — [tech.eu](https://tech.eu/2025/05/16/ororatech-extends-its-series-b-to-37m-to-scale-satellite-powered-wildfire-forecasting-tech/)): in May 2026 Greece became the first country with a national wildfire satellite system — €20M, 4 dedicated FOREST satellites, Athens operations hub, data straight to the Greek fire service ([GlobeNewswire](https://www.globenewswire.com/news-release/2026/05/04/3286797/0/en/Greece-Launches-World-s-First-National-Wildfire-Satellite-System-with-OroraTech.html)). **They are already in SEE at government level.** *If they wake up on Bulgaria:* they sell nation-scale systems to ministries, not consumer apps — a BG government deal after a bad season is plausible and would capture the institutional layer. *Defence:* stay the citizen/SMB layer; an OroraTech govt system would, if anything, legitimize satellite fire data and grow the audience fire-watch serves.
- **Pano AI** (Series B $44M; ~$50k/station/yr; Europe targeted for 2026 but no EU deployment announced as of Jul 2026 — [GlobeNewswire](https://www.globenewswire.com/news-release/2025/06/16/3099902/0/en/Wildfire-Tech-Comes-of-Age-Pano-AI-Raises-44M-Series-B-Led-by-Giant-Ventures-to-Scale-Early-Detection-Infrastructure.html)): premium hardware B2B; their price point is fire-watch's best sales slide for segment S4. Low collision risk.
- **Dryad Networks** (sensors ~€48, gateways €371–549; deployments in Greece/Spain/Portugal, none found in BG — [Lightreading](https://www.lightreading.com/iot/dryad-networks-connects-the-forests-for-early-wildfire-detection)): hardware-complementary; a future data partner (their sensors don't produce a public map) more than a competitor.
- **FireSat / Earth Fire Alliance + Google** (first 3 operational satellites launched 7 Jul 2026; Q4 2026 data to early-adopter agencies only — incl. Portugal, none Balkan; broad access ~2028; Google.org >$15M + Bezos Earth Fund $26M — [EFA](https://earthfirealliance.org/news-article/earth-fire-alliances-first-three-operational-firesats-reach-orbit/)): **the real long-term threat.** If 5×5 m detections flow free through Google Search/Maps push in 2027–28, raw detection is fully commoditized. *Defence:* fire-watch's moat was never the detection — it is Bulgarian-language curation, local institutional integration, community verification, and alert trust. Also an opportunity: FireSat may become a free upstream source exactly when fire-watch has the distribution to use it.

### 6.2 The free/expert layer (fire-watch's data commons, not competitors)

EFFIS (new mobile-friendly viewer 2.0, but an expert GIS tool, no app/push — [forest-fire.emergency.copernicus.eu](https://forest-fire.emergency.copernicus.eu/applications)); NOA FireHub (Balkans coverage, 5-min SEVIRI, expert-facing); Windy's free fires layer (day-old GFAS, coarse, explicitly "not for operational monitoring" — [Windy Community](https://community.windy.com/topic/10126/new-map-on-windy-active-fires)); Ventusky added fire monitoring May 2026 but official-incident data covers US/CA/AU only ([Meteorological Technology Intl](https://www.meteorologicaltechnologyinternational.com/news/data/ventusky-adds-fire-monitoring-to-its-weather-maps.html)). None ships alerts for Bulgaria.

### 6.3 Direct consumer analogues

- **EU Fires** (indie dev Walter Tengler; free + ads; FIRMS + EFFIS + fogos.pt + Open-Meteo; push at 5–200 km radius; 13 languages **without Bulgarian**; **iOS-only** — [App Store](https://apps.apple.com/ch/app/eu-fires/id6758920580)). **The closest functional analogue in the EU and the fastest to "wake up": adding Bulgarian is a week of work for him.** *Defence:* Android+PWA coverage (BG is Android-dominant), Bulgarian sources beyond FIRMS pins (ГДПБЗН bulletins, community reports), verification layer, local partnerships — depth an international generalist can't replicate remotely.
- **pozari.org** (Serbian NGO iRevolucija: 6 W-Balkan countries, 10-min FIRMS, FWI, spread projections; no BG, no app, no push — [pozari.org](https://www.pozari.org/)). Proof a small team can run this model; extension into BG would make them a direct competitor — or the natural pan-Balkan partner (§10 Q9).
- **Watch Duty**: no international plans announced; their human-reporter model transfers only with a local volunteer network — which is precisely the asset fire-watch should build first (§4.2).

### 6.4 Bulgarian incumbents (all partial)

НСОРБ/Esri "Ситуационна карта" (ArcGIS dashboard, Jul 2024: no app, no push, low public awareness — [namrb.org](https://www.namrb.org/bg/aktualno/situatsionna-karta-na-pozharite)); ASDE/ReSAC MODIS map (4×/day, technologically stale — [bsdi.asde-bg.org](https://bsdi.asde-bg.org/fires.php)); Meteo Balkans (audience without product — §4.3; also the fastest domestic actor who could commission one — the single best argument for partnering early); НИМХ fire index (static); BG-ALERT (cell broadcast, §2.9 failures); FireScope AI/INSAIT (risk forecasting research, not detection — potential partner — [insait.ai/firescope](https://insait.ai/firescope/)); camera-tower integrators Lirex (~9% of BG forests claimed) and ITA Group (hardware B2B, no consumer product — §3.1 S1).

### 6.5 Net competitive read

As of July 2026, **nobody serves the Bulgarian citizen with a live fire map + alerts.** The window is real but not permanent: the cheap entrants (EU Fires localization, pozari.org extension, a Meteo Balkans-commissioned layer) could close the *consumer* gap within months of deciding to; the expensive entrants (Google/FireSat, OroraTech B2G) will commoditize *detection* on a 2027–28 horizon. Strategy: win distribution + trust in season 2027, convert institutional depth (B2B, partnerships) into the moat before either happens.

### 6.6 Wake-up triggers and pre-planned responses

Rather than monitoring competitors diffusely, watch six specific triggers quarterly; each has a decided-in-advance response so no season is lost to deliberation:

| Trigger | What it means | Pre-planned response |
|---|---|---|
| EU Fires ships Bulgarian and/or Android | The consumer clone is live | Accelerate press + partnership calendar; message on verification, BG sources, and community — never price-fight a free ad-supported app |
| pozari.org announces BG coverage | NGO competitor at the door | Open the partnership conversation the same week (§10 Q9) — alliance beats collision for both sides |
| Meteo Balkans launches its own fire map | Biggest distribution channel became a competitor | Fall back to regional-media widget network + Viber; compete on alert reliability and QA, which an audience-first actor will not match |
| Government signs an OroraTech-style national deal | Institutional layer captured | Publicly welcome it; reposition as the citizen layer on top; request a data-access agreement |
| FireSat public API / Google push arrives in BG | Raw detection fully commoditized | Integrate FireSat as an upstream source; double down on curation + community; re-price the supporter value proposition |
| Watch Duty announces European expansion | Big-brand entry (lowest probability) | Approach as the Bulgarian partner/affiliate before competing — their model needs exactly the local network fire-watch will have built |

---

## 7. GTM sequencing & launch playbook

### 7.1 Timing against the fire calendar [MVP]

Bulgaria's season is bimodal (§2.2): spring burning peak (Mar–Apr) and summer peak (Jul–Sep). The GTM calendar writes itself:

- **Build through winter 2026–27**; run the pipeline in shadow mode against the remaining 2026 season for ground truth (QA gates need real fires).
- **Soft-launch/beta during the spring 2027 peak** — real fires, lower stakes, media not yet saturated; recruit volunteer formations and fix alert precision in the wild.
- **Public launch May 2027**, before the summer peak — never *during* a mega-fire (launching into your own scaling failure while lives are at stake is the reputational kill scenario, §8 R4).

### 7.2 The first-viral-fire press kit [v1 — prepared before launch]

The growth event is not the launch; it is the first mega-fire after launch. Prepare in advance:
- A pre-written explainer ("How satellite fire detection works, what 3-hour latency means, what this map is and is not") in Bulgarian, journalist-proof;
- Screenshots/GIF templates and an auto-generated per-fire share page (OG image with map extent, detection times, source credits);
- The **embeddable widget** (§4.3) with one-line iframe instructions — regional outlets will embed a live map the day a fire is national news; that embed is a permanent acquisition channel;
- A contact list warmed *before* the season: Meteo Balkans, Dnevnik, OFFNews, bTV/Nova online desks, Dunavmost, the Haskovo/Svilengrad regional sites (all precedented to cover fire maps — §4.3);
- A hard rule for interviews: fire-watch **complements** ГДПБЗН and BG-ALERT; it never claims official-warning status. The BG-ALERT criticism narrative is potent (§2.9) — let journalists write it; never say it yourself.

### 7.3 Community seeding order [MVP→v1]

1. Volunteer formations via НАДРБ + municipal registers (free accounts, direct onboarding);
2. WWF volunteer/donor base via the partnership (§4.1);
3. Hiking/hunting/rural Facebook groups and the Viber channel (§4.4);
4. Regional media embeds (§7.2);
5. Paid acquisition: **none.** At these LTVs (§2.4) any paid CAC is underwater; every euro goes to product and partnerships.

Seeding targets, so "community" stays measurable: 100+ volunteer accounts by Apr 2027; Viber channel ≥1,000 subscribers by Jun 2027; ≥3 media embeds by Jun 2027; ≥2,000 alert-armed users by Sep 2027 (feeding CP3, §9.2).

### 7.4 North-star metric and KPI set [MVP]

Optimizing MAU would reward smoke-chasing virality and punish the off-season — wrong incentives for a trust product. Instead:

- **North star: alert-armed weekly-returning users** — accounts with ≥1 saved location, alerts enabled, active in the last 7 days. This is the number that measures "people who trust fire-watch to watch their home".
- KPI 1: **Alert precision ≥85%** (per QA gate; user-facing false-alarm complaints as proxy) — trust.
- KPI 2: **p95 detection→alert ≤15 min** (per QA gate) — the latency promise.
- KPI 3: **D30 retention of alert-armed users ≥40%** in-season — product-market fit.
- KPI 4: **Media embeds + press citations** (count/quarter) — distribution flywheel.
- KPI 5: **B2B pipeline: qualified conversations → pilots → paid** (S4+S1) — the revenue path.
- Anti-KPI: raw MAU is reported but never targeted; a spike without KPI-3 follow-through is noise.

### 7.5 Message house [MVP]

One sentence per audience, fixed early — every partnership pitch, press quote, and store listing derives from these, and nothing off-list is ever said:

- **Citizens:** "See every satellite-detected fire in Bulgaria on one live map — and get an alert when one appears near a place you care about."
- **Institutions (ГДПБЗН, municipalities):** "An independent public window onto the same European satellite data your operations already use — we extend your reach; we never replace your authority."
- **B2B buyers:** "Satellite fire monitoring over your territory, for less per year than one day of a burned asset."
- **The negative list (as binding as the positive):** never "early-warning system", never "life-safety", never "guaranteed", never "replaces 112/BG-ALERT". The negative list is simultaneously the liability architecture (§5.5) and the R4 mitigation (§8) — one discipline, three payoffs.

---

## 8. Risk register (business)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Success-disaster:** viral fire drives 100k+ concurrent users onto €6–21/mo infra; map dies during the one event that matters | High (eventually certain) | Critical | Own tiles + CDN snapshot-first path (per reviews 01/04); Cloudflare Project Galileo application pre-launch (§4.7); static-fallback page; load-test at 50x baseline before May 2027 |
| R2 | **Key-person/seasonality collision:** solo founder; the season is also the only vacation window; alert ops are 24/7 exactly when burnout peaks | High | High | Alerts fail closed + degraded-mode automation (no manual curation dependency in MVP); document runbooks; recruit 1–2 volunteer moderators from the НАДРБ cohort by [v1]; explicitly budget founder recovery in Oct–Nov |
| R3 | **Seasonal cash flow:** ~90% of revenue potential lands Jun–Sep; costs are flat year-round | High | Medium | Annual-only supporter billing renewing in May (§2.6); B2B annual contracts; keep fixed costs ≤€25/mo until grant/pilot cash exists |
| R4 | **Reputational miss:** one missed mega-fire or one false alert driving panic near an evacuation destroys trust permanently | Medium | Critical | Published accuracy/latency expectations ("satellite detection, not official warning") on every alert; alerts fail closed; post-incident public retrospectives (Watch Duty culture); never overclaim in press; the disclaimer doubles as the ЗЗП liability shield (§5.5) |
| R5 | **Free-data dependency:** FIRMS/EUMETSAT policy or funding changes upstream | Low–Medium | High | Multi-source by design (FIRMS + MTG FCI already); monitor FireSat access (may become a *third* source ~2027-28); archive everything locally from day 1 |
| R6 | **Cheap-entrant preemption:** EU Fires adds Bulgarian / pozari.org adds BG / Meteo Balkans commissions a layer before season 2027 | Medium | High | Speed to spring-2027 beta; lock the Meteo Balkans partnership early (turns the biggest domestic risk into the biggest channel); depth features (BG sources, verification) that pins-on-a-map clones lack |
| R7 | **Detection commoditization 2027–28:** FireSat-via-Google free push closes the raw-data gap | Medium | High | Moat = local curation, institutions, community, B2B integrations — none of which Google ships for a 6.4M-person market; revisit strategy at each FireSat access milestone |
| R8 | **Platform risk:** iOS PWA push limitations / store gatekeeping if a wrapped app ships | Medium | Medium | PWA-first (per frontend review); Viber channel as push-independent fallback channel (§4.4); Android priority matches BG device mix |
| R9 | **Grant-time trap:** founder burns product months on consortium applications | Medium | High | §5.3 whitelist rule enforced in the plan; any application >40 h effort requires a written go decision against opportunity cost |
| R10 | **B2G/tender capture:** government buys a national system (OroraTech-style) and declares the problem "solved" | Low–Medium | Medium | Position as citizen/SMB complement (§6.1); institutional systems historically don't ship consumer UX — BG-ALERT itself is the proof |

### 8.1 The three risks that deserve prose

- **R2 × R3 (seasonality × solo founder) is the structural risk.** Everything peaks together: revenue potential, user attention, operational load, and heat — in the same 10 weeks, on one person, in the only period a person with a day job could otherwise rest. The mitigation is not heroism but architecture: the MVP must run alert operations with *zero* manual curation dependency (fail-closed automation), and the October–November recovery block in §9.1 is a plan line, not a hope. A solo operator who enters season 2 already burned out is the most likely quiet failure mode of this project.
- **R4 (reputational miss) is the kill scenario.** The trust asymmetry is brutal: a thousand correct alerts are forgotten in a week; one missed fire near an evacuation, or one panic-inducing false alarm, is remembered for years and will be quoted in every future ГДПБЗН meeting. This is why the engineering QA gates (alert precision ≥85%, fail-closed) are treated throughout this review as *business* requirements — they price the difference between "useful civic tool" and "that app that got it wrong in Voden".
- **R1 (success-disaster) is the paradox to plan for.** The single moment of maximum opportunity — the first viral mega-fire — is also the moment of maximum fragility on a €6–21/mo stack. The press kit (§7.2) and the load-tested snapshot-first architecture must be ready *before* that day, because it cannot be scheduled and will not repeat.

---

## 9. 12-month plan (Aug 2026 → Jul 2027) and three scenarios

### 9.1 Timeline

| Period | Product | Business/GTM | Funding |
|---|---|---|---|
| **Aug–Oct 2026** | MVP build per reviews 00–06; shadow-mode ingestion against live 2026 season; FIRMS 2020–2025 backfill (week 1) | Draft WWF + Meteo Balkans outreach; register company if/when first invoice or grant requires it | Eurostars S11 (by 10 Sep) *only if* partner exists; EUSPA Space Academy; Project Galileo application |
| **Nov 2026–Feb 2027** | Tiles, alert stack, geofences, widget; QA gates against backfill + shadow data | Partnership meetings (WWF, НАДРБ, Meteo Balkans); press-kit build; B2B demo decks from 2024–25 fire replays (Ilindentsi, Sakar) | CASSINI Accelerator Batch 8 + Challenges 2027 applications when windows open; НИФ session watch |
| **Mar–Apr 2027** | **Beta launch** in spring burn season; alert precision tuning in the wild | Volunteer-formation onboarding; first regional-media embeds; B2B outreach: 5 PV operators + 2 forestry enterprises with replay demos | CASSINI Hackathon #12 (PR + recruiting) |
| **May 2027** | **Public launch** (pre-season); load test 50x | Press push via warmed contacts; Viber channel live; supporter tier *soft* launch (annual, €8–13) if trust KPIs green | — |
| **Jun–Sep 2027** | Season 1 ops; fail-closed discipline; weekly public changelog | First-viral-fire playbook execution; convert B2B conversations → 2 pilots/LOIs (1× S4, 1× S1) | EEA Green Business call if published; НИФ if open |
| **Oct 2027 (M12+)** | Season retrospective (public) | **Go/no-go review** (below) | 2027 grant decisions land |

### 9.2 Checkpoints (go/no-go)

- **CP1 — end Oct 2026:** shadow pipeline meets QA gates on live-season data (PCR ≥95%, p95 ≤15 min). Miss → engineering problem, business plan pauses, no spend beyond infra.
- **CP2 — end Apr 2027:** beta live; ≥1 signed partnership (WWF or Meteo Balkans); ≥1 funding application submitted; ≥500 alert-armed users. Miss on all three → launch anyway but freeze any paid-tier work.
- **CP3 — end Oct 2027 (M12):** North star ≥2,000 alert-armed weekly users in season; ≥3 media embeds; ≥2 B2B pilots/LOIs; ≥1 funding result pending or won. **Hit ≥3 of 4 → invest in v1 paid tiers and B2B productization. Hit ≤1 → fire-watch continues as a donation-funded civic project (a fine outcome) or sunsets gracefully with data archived and published.**

### 9.3 Three scenarios (12–18 month revenue view)

**A. Bootstrap (base case — plan cash on this).** No external money. Costs: infra €72–252/yr + founder time. Revenue: supporter tier €500–3,000 + donations €0–1,000. Outcome target: distribution, trust, 2 B2B LOIs. Founder keeps primary income throughout. Viability: fine — the cost base is deliberately survivable at €0 revenue.

**B. +1 grant (upside case).** CASSINI Challenges 2027 (€100k) *or* НИФ (historically up to ~500k BGN, new-rules limits *unverified*) *or* EEA Green Business 2027. Effect: founder goes near-full-time for 12–18 months; v1 alert stack + B2B productization accelerate by ~2 quarters; revenue itself unchanged near-term (€2–8k) — the grant buys *time*, which is the actual scarce resource. Probability estimate: 25–40% across 3–4 applications from the §5.3 whitelist.

**C. +B2B traction (build case).** 2 beachhead pilots convert by early 2028 at €200–500/mo seasonal-weighted → **€5–15k ARR year 1**, with a visible path to €30–80k ARR in year 2–3 (6 ДП + ИАГ + 10–20 PV portfolios + municipal long tail + first insurer pilot). At that point — and only then — the Vitosha II / ФнФ equity conversation (§5.4) becomes rational, if the founder wants a company rather than a civic institution. Both are legitimate endgames; decide at CP3, not before.

### 9.4 Scenario budgets in numbers

**A. Bootstrap — year-1 cash view (€):**

| Line | Out | In |
|---|---|---|
| Infrastructure (€6–21/mo) | 72–252 | — |
| Domain + misc SaaS | ~50 | — |
| EUTM registration | deferred to [v1] (€850 when B2B revenue justifies it) | — |
| Company registration + accounting (if/when ЕООД — §5.5) | 300–900 | — |
| Paddle MoR fees (~5% + $0.50/txn on supporter revenue) | 25–250 | — |
| Marketing | 0 (earned media only) | — |
| Supporter tier + donations | — | 500–4,000 |
| **Total** | **< €1,500** | **€500–4,000** |

The design goal is visible in the table: the project is cash-positive or trivially cash-negative even in the worst commercial case, so no revenue scenario can force a shutdown — only founder time can.

**B. +1 grant** adds on top of A: a €100k-class award funds 12–18 months of founder salary at BG cost of living, a design/QA contractor for the v1 alert stack, and a ~€5k pre-season 2028 PR budget. Revenue lines are unchanged near-term — the grant buys *time*, the actual scarce resource.

**C. +B2B traction** adds: €5–15k ARR in, plus ~€1k/yr accounting/invoicing overhead and an SLA-driven infra upgrade (~€50–100/mo) — B2B gross margin stays above 80% because the product is packaging on the existing pipeline (§3.3).

### 9.5 The first 90 days (Aug–Oct 2026) — concrete checklist

Everything in this review reduces, for the next quarter, to eleven actions:

1. Ship the shadow-mode ingestion pipeline against the live 2026 season (the CP1 gate depends on real-fire data that only exists until ~October).
2. Run the FIRMS 2020–2025 backfill in week 1 — it feeds the QA gates *and* the B2B replay demos (§3.3).
3. Decide Eurostars by 1 Sep: if no foreign SME partner exists today, write the formal "skip" and move on (§10 Q7).
4. Submit Cloudflare Project Galileo and Mapbox community applications (<4 h total, must precede launch — §4.7).
5. Book the 1-hour accountant consult: чл. 194 ЗКПО dividend treatment + ЕООД vs hybrid timing (§5.5, §10 Q2).
6. Draft (do not yet send) the WWF and Meteo Balkans outreach notes; send after shadow-mode screenshots exist to show.
7. Enroll in EUSPA Space Academy modules; subscribe to НИФ and EEA Green Business announcement channels (§5.6).
8. Run 3–5 interviews with volunteer-formation duty officers on alert-delivery workflow (§10 Q4) — before designing [v1] routing.
9. Reserve the brand: eSearch plus/TMview clearance check against the §5.5 naming constraints (EUTM filing itself deferred).
10. Write the public freemium-boundary statement (§2.7) — it must exist before the first press mention, not after.
11. Pass CP1 (end Oct): QA gates green on live-season data, or pause all business workstreams until they are.

---

## 10. Open questions for the founder

1. **Identity decision (the most important one):** is fire-watch ultimately a *civic institution* (Watch Duty/Fogos.pt path: nonprofit framing, donations+grants+B2B services) or a *company* (equity path)? The staged model defers this, but branding, legal form, and the WWF/ГДПБЗН partnerships will force it around CP3. The Watch Duty evidence favours the civic frame for the consumer face with a commercial arm for B2B.
2. **Legal vehicle & timing:** ЕООД from day 1, or the hybrid сдружение+ЕООД (§5.5)? The facts are now on the table — CASSINI accepts even individuals; EIC needs a for-profit SME; Interreg lead-partner status needs the nonprofit; НИФ/ПКИП eligibility depends on entity history, so incorporating *earlier* may unlock 2027 procedures requiring a closed financial year. Remaining unknowns: чл. 194 ЗКПО treatment of ЕООД→сдружение dividends; a 1-hour accountant consult closes this.
3. **Founder bandwidth:** what is the honest weekly hour budget through winter 2026–27, and does the CP1 shadow-season plan fit it? Every scenario above assumes the MVP ships by spring 2027.
4. **Volunteer-formation engagement:** the counts are now verified (3,647 municipal + 466 corporate volunteers across 286 formations — §4 item 2); the open question is *engagement* — who inside НАДРБ and the larger formations is the champion, and what alert-delivery workflow do duty officers actually want? Run 3–5 interviews before building [v1] alert routing.
5. **Fire-risk targeting geography:** official risk classification turns out to be at *oblast* level (2016 ИАГ methodology, 3 grades — [methodology PDF](https://www.iag.bg/data/docs/Ocenka_i_kartografirane_na_risk_ot_gorski_pozhari.pdf)); no official municipal-level high-risk list exists. Decide fire-watch's own municipal prioritization (burned-area history × WUI population) and publish it — the absence of an official list is a content-marketing opportunity.
6. **Interreg BG–RS / BG–TR 2026–27 call windows** (*unverified*): the BG–TR programme has a direct-SME precedent; worth a quarterly check of ipa-bgtr.mrrb.bg despite the §5.3 whitelist rule.
7. **Eurostars partner:** does any Greek/Portuguese EO or fire-tech SME contact exist *today* for the 10 Sep 2026 deadline? If not, drop it — do not manufacture a partnership for a deadline.
8. **Meteo Balkans terms:** partnership (co-branded layer, attribution, data credit) vs. the risk they commission a competitor — open a conversation before the 2027 season; what exclusivity, if any, is acceptable?
9. **pozari.org:** partner (pan-Balkan alliance, shared stack, they keep W. Balkans / fire-watch takes BG+GR consumer) or ignore until v2? A conversation costs nothing and closes a competitive flank.
10. **FireSat access:** track EFA's 2027 expansion criteria — "emerging commercial applications" cohort could give fire-watch 5×5 m data before broad release; who applies, and under what entity?
11. **Supporter-tier price test:** €8 vs €13/yr (15 vs 25 BGN) — plan a simple A/B at soft launch; no research exists on BG safety-app WTP (§2.3), so generate the data.
12. **ГДПБЗН approach timing:** after season-1 credibility (this review's recommendation) or before launch to pre-empt friction? Reasonable people can disagree; decide together with the WWF conversation.
13. **CAP-compatible output:** Google/Apple crisis layers ingest *government* CAP feeds only (§4.6) — but should fire-watch publish its detections in a CAP-compatible format anyway, so any future institutional or platform integration is a config change rather than a project?
14. **Widget licensing terms:** free-with-attribution is the recommendation (§4.3); decide before launch whether commercial broadcast re-use (TV overlays of the map) stays free as PR or needs a nominal licence — Watch Duty's press-use posture is the template to study.

---

## 11. Key sources (appendix)

Full citations are inline throughout; this appendix lists the load-bearing primary sources for quick re-verification.

**Market & fires**
- NSI population and demographics 2025 — https://www.nsi.bg/en/press-release/population-and-demographic-processes-9002
- DataReportal Digital 2026: Bulgaria — https://datareportal.com/reports/digital-2026-bulgaria
- JRC: 2025 EU wildfire season (record 1.034M ha; BG 32,752 ha) — https://joint-research-centre.ec.europa.eu/jrc-news-and-updates/2025-was-eus-most-destructive-wildfire-season-record-2026-03-31_en
- WWF Bulgaria forest-fire analysis 2026 (ИАГ series 2011–2025, tower gap, volunteer registry, enterprise spending) — https://wwfeu.awsassets.panda.org/downloads/wwf_forest-fire-analysis-2026.pdf
- Eurostat: streaming subscriptions / e-commerce by country — https://ec.europa.eu/eurostat/statistics-explained/index.php?title=E-commerce_statistics_for_individuals

**Benchmarks**
- Watch Duty 2025 Annual Report (users, members, conversion, revenue) — https://www.watchduty.org/blog/2025-annual-report
- RevenueCat State of Subscription Apps (conversion & churn benchmarks) — https://www.revenuecat.com/state-of-subscription-apps-2025

**B2B**
- КФН insurance market 2024 — https://www.fsc.bg/rezultati-ot-dejnostta-na-mestnite-zastrahovateli-kam-kraya-na-2024-g/
- ЗОП direct-award thresholds 2026 — https://www.topzop.bg/blog/chlen-20-al-4-ot-zop
- Pano AI utility pricing precedent — https://coloradosun.com/2023/11/09/ai-wildfire-panos-colorado-xcel-energy/

**Partnerships & positioning**
- BG-ALERT operability gaps (68 municipalities) — https://paragraf.bg/edna-chetvart-ot-obshtinite-v-balgariya-vse-oshte-ne-mogat-da-rabotyat-s-bg-alert/
- ГДПБЗН uses EFFIS (parliamentary answer, Aug 2025) — https://www.focus-news.net/novini/Bylgaria/Bulgariya-izpolzva-sistemite-na-ES-za-borba-s-pozharite-u-nas-2663505
- Fogos.pt sponsored-infrastructure model — https://fogos.pt/en/sobre

**Funding & legal**
- CASSINI Challenges (rules, 2026 winners incl. Pyri) — https://www.euspa.europa.eu/newsroom-events/news/meet-2026-cassini-challenges-winners
- ESA BIC network (no Bulgaria) — https://commercialisation.esa.int/esa-business-incubation-centres/
- EEA/Norway Grants Bulgaria 2021–2028 (€260M MoU) — https://eeagrants.org/en/fmo/countries/bulgaria
- ЗДДС consolidated text (VAT threshold, SME scheme, чл. 44) — https://lex.bg/laws/ldoc/2135533201
- ЗЗП consolidated text (unfair terms, чл. 143/146) — https://lex.bg/laws/ldoc/2135513678

**Competition**
- OroraTech–Greece national system — https://www.globenewswire.com/news-release/2026/05/04/3286797/0/en/Greece-Launches-World-s-First-National-Wildfire-Satellite-System-with-OroraTech.html
- Earth Fire Alliance FireSat status — https://earthfirealliance.org/news-article/earth-fire-alliances-first-three-operational-firesats-reach-orbit/
- EU Fires app (closest functional analogue) — https://apps.apple.com/ch/app/eu-fires/id6758920580
- pozari.org (W. Balkans) — https://www.pozari.org/

### Abbreviations used in this review

Bulgarian institutions and legal acts (kept in Cyrillic throughout, as they appear in sources):

- **ГДПБЗН** — General Directorate "Fire Safety and Civil Protection" (national fire service, МВР)
- **ИАГ** — Executive Forest Agency; **ДП / ДГС / ДЛС** — state forestry enterprises and their district forestry/hunting units; **ЮЗДП** — the Southwestern state enterprise
- **НАДРБ** — National Association of Volunteer Formations; **НСОРБ** — National Association of Municipalities; **БЧК** — Bulgarian Red Cross; **НИМХ** — National Institute of Meteorology and Hydrology
- **НАП** — National Revenue Agency; **КФН** — Financial Supervision Commission; **ДФЗ** — State Fund Agriculture; **ЕСО** — Electricity System Operator; **ЕРП** — electricity distribution companies
- **НИФ** — National Innovation Fund; **ПКИП** — Competitiveness and Innovation Programme; **ПРСР** — Rural Development Programme; **ФнФ** — Fund of Funds; **ПМС** — Council of Ministers decree
- **ЗОП** — Public Procurement Act; **ЗЗП** — Consumer Protection Act; **ЗДДС** — VAT Act; **ЗКПО** — Corporate Income Tax Act; **ЗЗД** — Obligations and Contracts Act; **ЗМГО** — Trademarks Act; **ТЗ** — Commerce Act
- **ЕООД** — single-owner limited liability company; **ЮЛНЦ / сдружение** — nonprofit legal entity / association

Technical and market terms: **FIRMS** (NASA Fire Information for Resource Management System), **MTG FCI** (Meteosat Third Generation Flexible Combined Imager), **EFFIS** (European Forest Fire Information System), **PCR** (pipeline completeness ratio, QA gate), **WUI** (wildland-urban interface), **WTP** (willingness to pay), **LOI** (letter of intent), **MoR** (merchant of record), **OSS** (VAT One-Stop-Shop), **EUTM** (EU trade mark), **CAP** (Common Agricultural Policy / Common Alerting Protocol, per context).

---

*Review 10 of the fire-watch pre-code review series. Written 2026-07-22. All monetary figures in EUR unless marked BGN (fixed rate 1.95583). Facts not verifiable within this session's research budget are explicitly marked unverified/estimate; nothing unmarked is speculative.*
