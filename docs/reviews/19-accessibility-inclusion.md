# Review 19 — Accessibility & language inclusion

*Reviewer role: senior accessibility engineer / inclusive-design lead. Date: 2026-08-25. Status: complete.*
*Inputs reviewed: `docs/IMPLEMENTATION-PLAN.md` WP4 and WP7, `docs/GATES.md` §1 (CI-13–CI-15) and §3,
`docs/GLOSSARY.md` §5.2, `README.md` invariants, `reviews/06-qa.md` §5.4, `reviews/07-product-ux.md` §5.3/§5.8,
`reviews/08-frontend.md` §5.3/§5.8, `reviews/09-legal-licensing.md` §4.3, `reviews/10-business-gtm.md` §4,
`reviews/14-corner-cases.md`, `reviews/16-editorial.md` §5.7, `reviews/18-support-continuity.md` §5.6.
Project is in implementation (WP0–WP1); the frontend is not yet written, which is the reason this review is
worth writing now rather than in March 2027.*

---

## 1. Summary verdict

**CONDITIONAL GO — the corpus has better accessibility *fragments* than most funded
products and no accessibility *position*, and the one surface where the gap is
safety-critical is the alert path, which has no accessibility requirement of any kind.**

The fragments are genuinely good and they were not written by an accessibility specialist,
which says something about the corpus: hue never alone with a CI lint behind it (CI-14),
the list view as a peer surface rather than a fallback, the WebGL canvas exempted with the
DOM named as its accessible twin, `aria-live` for SSE updates, axe-core in the smoke run,
44 px targets, a 16 px type floor, 200 % font-scale reflow, `prefers-reduced-motion`, a
system font stack chosen partly for Cyrillic rendering on cheap Androids, and plain-language
Bulgarian with the jargon pushed behind `[?]`. Very little of that needs to be argued for.

What is missing is everything that turns fragments into a property: a **named conformance
target**, a **scope statement**, a **verification plan beyond the automated third**, an
**owner**, and a **gate**. Accessibility that is a preference gets cut in March 2027, which
is exactly where the plan schedules it — in the "trust/a11y tail" immediately before the
first season, next to the L-11 drill, in the busiest month the calendar has.

Five structural findings:

1. **The alert path — the only safety-critical surface — has no accessibility requirement
   at all.** Every a11y sentence in the corpus is about the map screen. Push notification
   text, the email template, the announcement policy for a burst of new events, and the
   *arming* flow (radius, place, quiet hours) are unaddressed. An alert that cannot be
   perceived is an alert that was not delivered, and unlike a map, there is no second
   surface to fall back to (§5.3, R-1).
2. **"The DOM list is the accessible twin" is asserted in three documents and tested by
   none.** It is the right architecture. It is also an unverified claim about information
   parity, and the first fact to fall out of the twin will be a degradation banner drawn
   over the canvas — which makes invariant 3's honest clock silently dishonest for a
   screen-reader user (§5.4, R-3).
3. **There is no conformance target, and the one recommendation in the corpus names the
   wrong version.** 09 §4.3 recommends WCAG **2.1** AA as product policy. WCAG **2.2** has
   been the W3C Recommendation since October 2023 and its new criteria — dragging
   movements, focus not obscured, target size, accessible authentication — land almost
   exactly on this product's interaction model. **This review disagrees with 09 §4.3 on the
   version and on the framing, states the disagreement openly rather than applying it
   silently, and escalates it as Q1 with a named decider** (§5.1, §5.2, R-2, R-5).
4. **Motion carries information, and the reduced-motion setting deletes it.** The pulsing
   halo *is* the "new event" signal (08 §5.3, 07 §5.3.4), and `prefers-reduced-motion`
   turns it off. That is the hue-never-alone problem in a second dimension, and it deserves
   the same treatment: a rule, then a lint (§5.6, R-9).
5. **The language question has never been asked.** Roughly 8–9 % of Bulgaria's population
   speaks Turkish as a mother tongue, concentrated in exactly the south-eastern and
   north-eastern regions the fire model cares about, and skewed toward the older rural
   demographic that 07 §5.8.2 already names as the primary at-risk user. The map already
   renders Turkish and Greek toponyms near the border (14 §5). No document asks whether the
   *alert* should exist in Turkish. The i18n architecture is already built for it at
   near-zero marginal cost; the real cost is safety-translation review, which is a decision,
   not an engineering problem (§5.7, R-6).

There is also a strategic argument that the legal review's exemption analysis misses
entirely, and it is the one that would persuade a sceptical founder: **the embed path pushes
our accessibility into someone else's compliance perimeter.** CP3 counts media embeds as a
success criterion and the GTM plan targets municipalities — public-sector bodies with their
own Web Accessibility Directive obligations. An inaccessible embeddable map is a product a
municipality's legal officer can be forced to remove (§5.10.2).

## 2. Strengths (sound as proposed)

- **CI-14 is the single best accessibility decision in the corpus** and it was made by the
  QA seat, not this one. Rule first, check second; the check passes on *colour-or-shape* and
  never requires colour alone to carry the fact. That is precisely how a colour-vision
  criterion should be automated, and the same pattern generalises to motion (§5.6).
- **The canvas exemption with a named alternative** is the correct architecture. Attempting
  to make a WebGL fire map screen-reader-navigable is a well-known way to spend six weeks
  producing something worse than a list. 06 §5.4 states it plainly: "its information must be
  reachable through the DOM panel — that duplication is the accessibility strategy."
- **The list view was justified three times independently** — accessibility, panic
  ergonomics, weak devices (07 P10) — which is why it survived into WP4's DoD. Features
  with three unrelated justifications do not get cut; this one should not be.
- **The type and target floors are already above the bar.** 16 px body, 44 px targets and
  200 % reflow exceed WCAG 2.2 AA's target-size minimum (24 × 24 px) and match its
  AAA-level target guidance. The corpus does not need to raise its floors — it needs to say
  which bar it is clearing.
- **08's i18n architecture is locale-ready without any i18n project**: typed message
  modules with dynamic import, `Intl` for dates and numbers, `<html lang>` kept in sync for
  screen readers and hyphenation, `?hl=` for shareable links, and the service worker
  importing the same modules for push text. A third locale is a content decision, not a
  rewrite (§5.7.3).
- **GLOSSARY §5.2's never-send lint is already locale-parameterised** — "each lifecycle
  state × each locale × the truncated push variant". Whoever wrote that anticipated a
  language the product does not yet have. It means the hardest part of adding a safety
  locale (proving the new language cannot emit a banned claim) is already mechanised.
- **Panic ergonomics as design policy** (07 §5.8.3: max five facts, one action verb, no
  confirmation dialogs on read paths, 112 always in the same place) is cognitive
  accessibility written by someone who did not call it that. It should be named as such so
  it is defended as such.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | **Critical** | The alert path — push text, email, announcement policy, and the arming flow — has no accessibility requirement; it is the one surface with no visual fallback | §5.3 |
| R-2 | **High** | No named conformance target, no scope statement, no owner and no gate: accessibility is a preference, and preferences get cut in the pre-season crunch | §5.2 |
| R-3 | **High** | Information parity between canvas and DOM is asserted but never defined or tested; the T1/T2 degradation banner is the first fact that will fall out of the twin | §5.4 |
| R-4 | **High** | A11y is scheduled as a Mar–Apr 2027 tail, colliding with the L-11 drill and season start — the classic retrofit position, and the most expensive one | §5.9.4 |
| R-5 | **Medium-High** | The recommended target is WCAG 2.1; 2.2's new criteria (dragging movements, focus not obscured, target size, accessible authentication) map directly onto a drag-driven map with an account | §5.1, §5.5 |
| R-6 | **Medium-High** | Turkish-language reach unexamined, in the regions with the highest fire exposure and the demographic least served by Bulgarian-only safety text | §5.7 |
| R-7 | **Medium** | No keyboard story: focus order, canvas escape, skip-to-list, and visible focus are unspecified; bottom-anchored one-hand controls conflict with focus-not-obscured | §5.5 |
| R-8 | **Medium** | Verification is automated-only; axe-core plus the CVD lint reach roughly a third of real failures and nothing schedules a manual assistive-technology pass | §5.9 |
| R-9 | **Medium** | Motion carries the "new event" fact, and `prefers-reduced-motion` deletes it with no defined static substitute | §5.6 |
| R-10 | **Medium** | Contrast floors are specified for themes, not for the environment the product is actually used in — daylight on a cheap phone at low brightness, next to smoke | §5.8.2 |
| R-11 | **Low-Medium** | No accessibility statement, no feedback route, and the microenterprise exemption is claimed nowhere a user or a partner can see it | §5.10 |

## 4. Detailed recommendations

Tags: **[MVP]** = before the public beta serves real users; **[v1]** = before the 2027
season; **[v2]** = later.

- **A1 [MVP] (R-1): make the alert path a first-class accessibility surface.** Push title
  carries the fact; email has a real plain-text alternative; no critical fact in an image;
  the announcement policy coalesces bursts instead of firing one `aria-live` per event —
  §5.3.
- **A2 [MVP] (R-1, R-5): the arming flow must be operable without dragging.** A radius set
  by dragging a circle on a canvas is unusable by keyboard, by screen reader, and by anyone
  with a tremor. A numeric/stepper equivalent is the whole fix and it is cheaper before the
  map exists than after — §5.3.5.
- **A3 [MVP] (R-3): define information parity and test it.** A fixed fact list, asserted
  against the DOM from the same fixture the map renders — proposed **CI-16**, §5.4.3.
- **A4 [MVP] (R-3): the degradation banner and the freshness clock live in the DOM**, in an
  `aria-live` region, never only as a canvas overlay. Invariant 3 is only honest if it is
  perceivable — §5.4.4.
- **A5 [v1] (R-2): name the target and gate it** — WCAG 2.2 level AA, scoped per Appendix A,
  with **L-16** as the gate. §5.2.
- **A6 [v1] (R-9): "no fact carried by motion alone"**, as a rule with a lint, extending
  CI-14's shape to the reduced-motion variant — §5.6.
- **A7 [v1] (R-7): the keyboard contract** — skip-to-list, no canvas focus trap, visible
  focus, and a resolution of the bottom-bar vs. focus-not-obscured conflict — §5.5.
- **A8 [v1] (R-8): one manual assistive-technology pass per season**, TalkBack on a real
  cheap Android, against the fixed script in Appendix B. It is half a day and it finds what
  axe-core structurally cannot.
- **A9 [v1] (R-11): publish an accessibility statement** — target, known gaps, the canvas
  alternative, the exemption claimed honestly, a contact route (18 §5.3), a date — §5.10.
- **A10 [v2] (R-6): decide the Turkish alert locale at CP2**, scoped to alert templates,
  list view and safety copy only; architect for it now, because 08 already did — §5.7.

## 5. Accessibility & inclusion deep dive

### 5.1 The legal position, and where this review disagrees with it (R-5)

#### 5.1.1 What 09 §4.3 gets right

The analysis is correct and unusually well sourced. The European Accessibility Act's
Art. 4(5) microenterprise exemption is real, the Bulgarian transposition is cited with its
ДВ reference and the exempting article, and the conclusion — claim the exemption, build it
anyway — is the right *disposition*. Nothing below disputes the law.

#### 5.1.2 Disagreement 1: the version

09 §4.3 recommends **WCAG 2.1 AA**. WCAG **2.2** has been the W3C Recommendation since
October 2023 and is a strict superset — everything in 2.1 AA is still there. Choosing 2.1
in 2026 is choosing to omit exactly the criteria that describe this product:

| WCAG 2.2 addition (AA) | Why it lands on this product specifically |
|---|---|
| **2.5.7 Dragging Movements** | Radius selection, map pan, and any draw-an-area interaction are drags; each needs a non-drag path |
| **2.4.11 Focus Not Obscured (Minimum)** | Bottom-anchored one-hand controls (07 §5.8.2) are precisely the thing that covers a focused element on a 360 × 640 viewport |
| **2.5.8 Target Size (Minimum)** | 24 × 24 px — the corpus already commits to 44 px and clears it comfortably; the value of naming it is that the floor becomes non-negotiable |
| **3.3.8 Accessible Authentication (Minimum)** | Relevant the moment accounts exist; also a direct input into the identity decision still open as 10 Q1 |
| **3.2.6 Consistent Help** | The 112 affordance "always in the same place" (07 §5.8.3) is already this criterion, unnamed |

Four of those five are already the corpus's own design intent. Adopting 2.2 mostly
*ratifies* decisions other reviews made, and adds one genuine new requirement (2.5.7),
which is cheap now and expensive after the map is built.

#### 5.1.3 Disagreement 2: the framing

"Exempt, build it anyway" makes accessibility a **virtue**, and virtues are the first line
item cut when March 2027 collides with the L-11 drill, CP2 and the season. The same
sentence written as a scoped target with a gate makes it a **requirement**, and requirements
survive crunch. The difference is not moral, it is scheduling — and this project's own
history shows that everything with a gate has held and everything with only a recommendation
has drifted.

There is also a substantive point the exemption framing hides: the exemption is from
*e-commerce service* obligations. It says nothing about whether the alert reaches a blind
user, which is a product-quality question that no directive was ever going to answer.

#### 5.1.4 Two facts to verify, not to assert

Per house discipline, marked rather than claimed:

- **UNVERIFIED:** the current harmonised-standard position — whether **EN 301 549**'s
  in-force version already references WCAG 2.2. It affects nothing today (we are exempt) but
  it determines what "compliant" means the day the exemption lapses. One check, owned by 09.
- **UNVERIFIED:** whether a public-sector body embedding our map pulls that map into its own
  **Web Accessibility Directive (2016/2102)** perimeter, given the directive's carve-out for
  third-party content not funded, developed or controlled by the body. A municipality that
  *chooses* to embed is arguably exercising control. This is the strategic argument in
  §5.10.2 and it needs 09's answer, not this seat's guess.

#### 5.1.5 The escalation, stated plainly

**This review does not silently override 09 §4.3.** The disagreement is Q1 in §6, the
decider is named there, and until it is decided the corpus holds two positions: 09's
"WCAG 2.1 AA as product policy" and this review's "WCAG 2.2 AA as a scoped, gated target".
Whichever wins, it should be written into one place and the other document updated to point
at it — two live accessibility targets is worse than either one.

### 5.2 The conformance target, scoped (R-2, A5)

A target without a scope is unachievable by construction, because it implicitly includes
the WebGL canvas, which cannot conform. The scope statement is what makes the target real.

**Proposed target: WCAG 2.2, level AA, on the surfaces in Appendix A.**

Three scope classes:

1. **In conformance scope** — everything in the DOM: the list view, the event panel, the
   filter and time controls, settings and the alert-arming flow, alert emails, the static
   pages (about, transparency, credits, accessibility statement), and error states.
2. **Exempt with a documented alternative** — the WebGL map canvas. The exemption is
   conditional on the alternative actually carrying the information (§5.4), and that
   condition is testable, which is the difference between an exemption and an excuse.
3. **Out of scope, for now** — the admin plane (05 §5.4), on the grounds that it has exactly
   one user. **This expires the moment volunteer moderators arrive** (18 §5.6): a triage
   tool used by recruited volunteers is a tool whose users we did not select, and one of
   them may need it accessible. Q3 in §6.

**Proposed gate L-16** — the wording review 15 §6 asked for:

> **L-16 — Accessibility target declared and verified.** A named conformance target (WCAG
> 2.2 AA) with a published scope statement covering every surface in three classes: in
> scope, exempt-with-alternative, out of scope. **Pass:** WP4's three layout criteria pass;
> the parity test (CI-16) is green; axe-core reports zero serious/critical on in-scope DOM
> surfaces; the seasonal manual pass (Appendix B) has been executed and dated with its
> findings triaged; the accessibility statement is published with the legal position stated;
> and the alert path items in §5.3 are implemented. Any red item blocks season start.

The legal position is part of the gate deliberately: claiming an exemption in public, in
writing, alongside a voluntary commitment, is what a good actor does — and it is a sentence,
not a project.

### 5.3 The alert path (R-1, A1, A2)

This is the section the corpus does not have, and it is the one that matters most, because
the alert is the product. Everything else is a map.

#### 5.3.1 Why it is different from the map screen

The map has a built-in accessible alternative — the list. **The alert has none.** If the
push notification is unreadable, unhearable or ambiguous, there is no second surface;
the user simply does not learn about the fire. Every other accessibility failure in this
product degrades the experience. This one changes the outcome.

#### 5.3.2 Push notification

- **The title carries the fact.** Not the app name, not "New alert" — the fact:
  *"Пожар на 8 км от Харманли — засечен в 14:32"*. Screen readers on both platforms read
  the title first and truncate aggressively; the fact must survive being the only thing
  heard. GLOSSARY §5.2's truncated-push variant already exists as a lint target, so this is
  a constraint the machinery can hold.
- **No fact in the icon, the colour or the badge.** A notification whose severity is
  conveyed by a red icon conveys nothing to a blind user and little to a colour-blind one.
- **Use the platform notification API properly** rather than any custom presentation. This
  is the single highest-leverage accessibility decision in the alert path: the OS already
  routes to vibration for deaf users, to the screen reader for blind users, to
  large-text settings, and to the user's own critical-alert configuration. A custom
  presentation throws all of that away and then has to rebuild it badly.
- **Language follows the user, not the device**, once a second locale exists (§5.7).

#### 5.3.3 Email

The lower-status channel in every product and the higher-status one for exactly the
demographic this product serves — older rural users who read email on a phone with the text
size turned up.

- Semantic HTML with real headings, a genuine plain-text alternative that is not a degraded
  citizen, and no critical fact carried by an image (images are commonly blocked by default).
- Link text that means something out of context: *"Отвори страницата на пожара при Харманли"*,
  never "виж тук".
- No fixed-width layout below the phone viewport, 14 px minimum, and a colour scheme that
  survives a client's forced dark mode — where hard-coded dark text on an unspecified
  background becomes invisible. This is the most common real-world email accessibility
  failure and it is a one-line fix at template time.

#### 5.3.4 The announcement policy — the finding that only shows up under load

06 §5.4 specifies a polite `aria-live` region announcing SSE updates. Correct, and
incomplete in a way that only appears on the worst day: during a major fire, a screen-reader
user receives a *stream* of announcements. Three rules:

1. **Never `assertive`.** Assertive interrupts whatever the user is currently reading. A
   burst of assertive announcements during a fire is a denial of service against precisely
   the user who most needs to finish reading the sentence they are on.
2. **Coalesce.** A window (say 30 s) that emits *"3 нови пожара в близост"* rather than
   three separate announcements. The same debounce the UI already wants for visual churn.
3. **Announce state changes, not refreshes.** A snapshot poll that changes nothing must
   announce nothing. Otherwise the region becomes noise and users switch it off — which is
   the accessibility equivalent of alert fatigue, already the corpus's central concern
   elsewhere.

#### 5.3.5 Arming an alert (A2)

The alert is only accessible if the *setting up* of it is. This flow needs:

- **A non-drag path to the radius.** If the interaction is "drag a circle on the map", it is
  unusable by keyboard, by screen reader, by a user with a tremor, and by a gloved hand —
  and WCAG 2.2's 2.5.7 names it directly. A numeric stepper or a small set of named radii
  (5 / 10 / 25 km) alongside the drag costs almost nothing at design time.
- **A non-map path to the place.** Search by settlement name, and "use my location" — which
  already exists and which, given the privacy rule that coordinates never leave the device,
  is also the most private path.
- **Labelled, keyboard-operable quiet hours and thresholds**, with the current state
  readable as text rather than inferable from a toggle's colour.
- **A confirmation the user can verify later**: "you will be alerted about fires within
  10 km of Харманли" as a sentence, not as a rendered circle. A user who cannot see the
  circle currently has no way to check what they armed.

### 5.4 Proving the accessible twin (R-3, A3, A4)

#### 5.4.1 The claim, and its status

"The DOM list is the accessible twin of the canvas" appears in 06 §5.4, in 07 §5.8.2, and
in WP4's definition of done. It is the correct strategy and it is currently a promise. The
failure mode is not that someone abandons it; it is **drift** — a fact gets added to the map
(a new badge, a banner, a filter state) and not to the list, one commit at a time, until the
twin is a sibling.

#### 5.4.2 Parity, defined

Parity is not "the list exists". It is: **every fact a sighted user can obtain from the map
without clicking is obtainable from the DOM without seeing the canvas.**

Per event: identity and place name; distance and direction from the reference point;
lifecycle state in words; confidence in words; observed-at as both absolute and relative
time; the source; and the link to the permalink. Globally: the freshness clock; the
degradation state (T0/T1/T2); the count of matching events; the active filter and time-window
state; and the empty state ("no fires match" is a fact, and a silent empty map is not).

#### 5.4.3 The test (proposed CI-16)

This is cheap because the data already exists in one place. The feed model that the map
renders is the same model the list renders; a unit test over the fixture snapshot can assert
that for every event in the model, each required fact appears in the rendered DOM, and that
the global facts appear too. It runs in the existing vitest project, needs no browser, and
it fails on exactly the drift described above.

> **CI-16 — Canvas/DOM information parity.** For the fixture snapshot, every fact in the
> event model and every global state fact renders into the DOM surfaces. A fact added to the
> map without a DOM representation fails CI. *[GATE-MVP]*

#### 5.4.4 The degradation banner is the sharp case (A4)

Invariant 3 is the honest clock: the product must always say how fresh it is, and must say
plainly when it is degraded. If T1/T2 degradation is communicated by a banner drawn over the
map canvas, then for a screen-reader user the product silently claims freshness it does not
have. That is not an accessibility bug at the level of inconvenience — it is invariant 3
being false for a class of users.

Therefore: the freshness clock and the degradation state are **DOM elements, always**, in
a polite live region, announced when the state changes and readable at any time on demand.
The canvas may also draw them. It may never be the only place they exist.

The same argument applies to every honest-limitation message the product makes — the cloud
gap, the "no detection ≠ no fire" line, the confidence tier. The corpus's entire honesty
posture is transmitted visually today.

### 5.5 Keyboard and pointer (R-7, A7)

- **Escape from the canvas.** A focusable canvas that swallows arrow keys is a trap. Either
  the canvas is not in the tab order at all (with a "skip to the list" link immediately
  before it — the simplest correct answer for MVP), or it is focusable with documented key
  handling and a guaranteed exit.
- **Skip to list** as the first focusable element on the page. One anchor, and it converts
  the whole keyboard experience from hostile to workable.
- **Visible focus on everything**, including custom controls and the bottom bar. Default
  focus rings removed for aesthetics and not replaced is the most common single failure in
  hand-built UI, and this project will hand-build its controls.
- **The bottom-bar conflict, named.** 07 §5.8.2 anchors primary actions to the bottom for
  one-hand reach — correct for the panicking user — and a fixed bottom bar is the classic
  way to obscure a focused element on a short viewport (WCAG 2.2 2.4.11). Resolution:
  scroll-padding sized to the bar, verified once at 360 × 640 with the keyboard, in the
  same viewport matrix 06 already runs. Naming the conflict now costs a line; discovering it
  in an audit costs a layout refactor.
- **Target size** is already resolved by the 44 px floor; it needs only to be stated as
  clearing 2.5.8.

### 5.6 Motion, and the reduced-motion trap (R-9, A6)

The corpus makes two decisions that are individually right and jointly wrong:

- The **pulsing halo carries the "new event" fact** (08 §5.3, 07 §5.3.4) — chosen precisely
  *because* it is a redundant non-hue channel, which was good CVD thinking.
- `prefers-reduced-motion` **disables pulsing** — chosen because animation harms users with
  vestibular disorders, which is also right.

Composed: a user with reduced motion enabled loses the "new" signal entirely, and that user
population overlaps with older users, with migraine and vestibular conditions, and with
anyone whose phone has battery saver on.

**The rule, in CI-14's shape:** *no fact is carried by motion alone.* Every class
distinguished by animation must also be distinguished by a static property — a second ring,
a distinct radius, a symbol — that survives with animation disabled. And the list view, which
is the accessible twin, carries "new" as a word or chip regardless.

**The lint:** CI-14 already parses the style JSON and reasons about per-class properties.
Extending it to assert that the `new` class differs from `active` by at least one *static*
property is the same script with a second assertion. Run the reduced-motion variant through
the existing visual-regression matrix and the check is complete.

### 5.7 Language reach (R-6, A10)

#### 5.7.1 The population, honestly

Bulgaria's Turkish-speaking population is roughly **8–9 %** by mother tongue at the last
census — *approximate, and the precise census figure should be cited properly by whoever
takes the decision, not estimated here.* What matters for this product is not the national
percentage but the **geography and the demography**:

- Concentration in Kardzhali, Razgrad, Targovishte, Silistra, Shumen and Haskovo.
- The south-eastern group (Haskovo, Kardzhali, and the Sakar–Strandzha belt) sits inside the
  region this product's own risk model treats as the highest-exposure part of the country.
- Within that population, limited-Bulgarian literacy skews **older and more rural** — the
  same person 07 §5.8.2 already designed for: "a 60-year-old in a Sakar village on a
  mid-range Android".

In other words, the demographic the product has explicitly optimised for and the demographic
most likely not to read Bulgarian safety text fluently are substantially the same people.

#### 5.7.2 What is already true

- The **map already renders Turkish and Greek toponyms** near the border (14 §5) — the tile
  data is multilingual; only the *interface and the alert* are not.
- 10 §4 treats Turkish Thrace as a natural map-coverage extension at near-zero marginal cost.
- English exists and carries more weight than it looks: border traffic, foreign residents
  in the Strandzha/Black Sea belt, and the media-embed audience.

#### 5.7.3 What it would cost

Engineering: close to nothing. 08's i18n is typed message modules with dynamic import, a
`?hl=` parameter, `<html lang>` synchronisation, and the service worker importing the same
modules for push text. Adding a locale is adding a file.

The real cost is **safety translation**: an alert string is not marketing copy, and a
mistranslated lifecycle state is exactly the R4 kill scenario in another language. It needs a
native reviewer with the same never-send discipline, and GLOSSARY §5.2's lint — already
written as "each lifecycle state × each locale" — is the mechanism that enforces it. The
budget is a person, not a sprint.

#### 5.7.4 Scope, if it is done

Narrow, deliberately: **alert templates, the list view, the safety copy, the 112 line, and
the settings needed to arm an alert.** Not the blog, not the transparency page, not the
admin plane, not the FAQ initially. A partially-translated product that translates the parts
that save lives is honest; one that translates the marketing and not the alert is the
opposite.

And one hard rule inherited from 16 §5.7: **never publish a translated operational state.**
An official Bulgarian authority statement stays in Bulgarian, quoted verbatim, with the
translated *frame* around it — "Официално съобщение (на български):". Translating "овладян"
into another language in our own voice is us making the claim, and we do not make that claim
in any language.

#### 5.7.5 What this review does not recommend

Romani-language text. The honest position: there is no single standardised written
orthography in general use in Bulgaria, and written-literacy patterns in the relevant
communities make a text translation the wrong intervention rather than a difficult one. The
interventions that actually reach that population are the ones already in the plan for other
reasons — symbol and shape redundancy, the list view, plain language, and the 112 affordance
in a fixed place. Saying this plainly is better than adding a locale nobody would use in
order to look inclusive.

#### 5.7.6 When to decide

**At CP2 (April 2027), not now.** By then there is reach data: where the alert-armed users
actually are. Architect for it now — which 08 already did — and let the decision be made with
numbers. If the user distribution shows meaningful uptake in Kardzhali or Razgrad, the
decision makes itself.

### 5.8 The rest of the people this product serves

#### 5.8.1 Older rural users

07 §5.8.2 covers this well. Two additions:

- **OS font scale is not browser zoom.** Android OEM skins go beyond 200 % and reflow
  differently from a desktop zoom; the 200 % criterion must be tested on a real device, not
  in devtools. The one line that must never be clipped is the freshness line, and it is the
  line most likely to be clipped, because it is the longest.
- **The 16 px floor is a floor, not a target.** For the two facts that carry the decision —
  distance and freshness — display size is the right call, and 07 already says so.

#### 5.8.2 Low vision, outdoors, in the situation the product is for (R-10)

The corpus specifies contrast per theme. The product is used **outdoors, in daylight, on a
cheap phone, possibly with smoke haze and possibly with the brightness turned down to save a
dying battery**. A 4.5 : 1 that passes in a lab fails in that environment.

Recommendation: exceed AA on the two facts that must never be unreadable — the freshness
line and the distance figure — targeting the AAA 7 : 1 ratio for those specific elements.
Two elements, not a redesign. 07 already names the night-time variant of this scenario
("20 % brightness with 200 % font scale is a scenario, not a theme"); the daytime variant is
the fire variant.

#### 5.8.3 Cognitive accessibility, named

Panic ergonomics *is* cognitive accessibility: bounded facts, one verb per element, no
confirmation dialogs on read paths, consistent placement of help (WCAG 2.2 3.2.6). Naming it
protects it — an unnamed design preference loses an argument with a feature request; a named
accessibility property does not.

One addition: **name a plain-language target for safety copy** — short sentences, common
words, the action first. The corpus already bans FRP, NRT, VIIRS and FWI from consumer
strings, which is the hard half. The easy half is a sentence-length discipline in the same
lint that already checks the never-send list.

#### 5.8.4 Situational disability — the volunteer at the fire

The НАДРБ volunteer using this product is one-handed, gloved, in poor light, possibly with
hearing protection on, on a phone with a cracked screen. Every fix for permanent disability
serves them: large targets, bottom anchoring, high contrast, text over colour, redundancy
over elegance. This is worth stating because it converts accessibility from a minority
concern into the *primary* use case's requirement — and that is the argument that wins
prioritisation debates.

### 5.9 Verification (R-8, A8)

#### 5.9.1 What automation reaches

axe-core is excellent and it catches on the order of a third of real WCAG failures —
*approximate, an industry figure, not a measurement.* It reliably finds missing labels,
contrast on static text, ARIA misuse, heading structure, and landmark problems. It
structurally cannot find: whether the announcement policy is usable during a burst, whether
the twin actually carries the facts, whether the focus order makes sense, whether the copy
is comprehensible, or whether a user can arm an alert without seeing the map.

#### 5.9.2 The four automated checks

1. **axe-core** on the DOM surfaces in the smoke run (06 already plans this) — zero
   serious/critical as the bar.
2. **CI-14** for colour, extended to motion (§5.6).
3. **CI-16** for parity (§5.4.3).
4. **The reduced-motion variant** in the existing visual-regression matrix.

All four are cheap and all four are the kind of check that holds a line for years without
anyone thinking about it.

#### 5.9.3 The manual pass (A8, Appendix B)

Half a day, once per season, before season start. **TalkBack on a real mid-range Android**,
because that is the primary device; VoiceOver secondary; a desktop screen reader only if the
B2B surface exists. Against a fixed script, so the result is comparable across years.

The strongest version of this is not a self-audit: it is **one session with an actual
screen-reader user**. Thirty minutes with someone who uses TalkBack daily will find more than
a day of self-testing, and 18 §5.8's community relationships are a plausible route to
finding that person. Worth asking for, worth paying for if necessary.

#### 5.9.4 The schedule problem (R-4)

WP4 places the "trust/a11y tail" in Mar–Apr 2027 — the same window as the L-11 pre-season
drill, CP2, and the beta launch. That is the most contended month in the entire plan, and
accessibility placed there is accessibility placed last.

The fix does not require moving work; it requires moving *decisions*. The target, the scope
statement, the parity fact list, the alert-path requirements and the non-drag arming path
are all **specification**, and specification written before the frontend exists costs
nothing and makes the March work mechanical. What must stay in March is the verification —
the manual pass and the statement. Decide in December, verify in April.

### 5.10 The statement, and the argument that actually persuades (R-11, A9)

#### 5.10.1 The accessibility statement

One page: the target and its scope, the known gaps stated honestly (the canvas, and whatever
the manual pass found and has not fixed), the alternative that carries the information, the
legal position — exemption claimed, voluntary commitment made — a contact route pointing at
18 §5.3's inbox, and a date. An hour of writing. It is also the artifact that makes the whole
thing checkable by an outsider, which is the same logic as the transparency page the product
already commits to.

#### 5.10.2 The embed argument (the one missing from 09)

CP3 counts **media embeds** as one of four success criteria and the GTM plan targets
municipalities and NGOs. A municipality is a **public-sector body** with its own obligations
under the Web Accessibility Directive and its Bulgarian transposition. If our embeddable map
is inaccessible, a municipality that embeds it acquires a problem — and the resolution of
that problem is removing the embed, not fixing our product.

Whether the directive's third-party-content carve-out applies is a real legal question
(§5.1.4, routed to 09). But the *commercial* asymmetry does not depend on the answer: an
accessible embed is a thing a public body can adopt without asking its legal officer, and an
inaccessible one is a thing that has to survive a review. For a product whose growth plan is
embeds, that is a distribution question wearing an accessibility costume — which is the
argument most likely to move this up the priority list, and it is entirely absent from the
corpus today.

## 6. Open questions for the team

1. **WCAG 2.1 or 2.2?** This review recommends 2.2 AA scoped per Appendix A; 09 §4.3
   recommends 2.1 AA as product policy. **Decider: the founder as product owner, with the
   legal seat consulted.** The disagreement is stated openly here and must be resolved into
   *one* documented target — two live targets is worse than either.
2. **Does the Turkish alert locale ship, and who reviews the safety translation?** Decide at
   CP2 with reach data (§5.7.6). The translation reviewer is the binding constraint, not the
   engineering.
3. **Does the admin plane enter conformance scope when volunteer moderators arrive?**
   (18 §5.6.) It is out of scope only while it has exactly one user we selected.
4. **Who performs the manual pass, and can we find a screen-reader user to sit with?**
   (§5.9.3.) This connects to 18's community work and to its second-person question.
5. **Does the embed path pull our accessibility into a public body's compliance perimeter?**
   (§5.1.4, §5.10.2.) Routed to 09 as one verification, with a commercial consequence
   regardless of the legal answer.

## Appendix A — Conformance scope

| Surface | Class | Mechanism | Verified by |
|---|---|---|---|
| List view ("Fires near me") | In scope | Semantic DOM, the accessible twin | axe-core, CI-16, manual |
| Event panel / event page | In scope | Semantic DOM | axe-core, CI-16, manual |
| Filters, time window, search | In scope | Labelled controls, keyboard-operable | axe-core, manual |
| Alert arming & settings | In scope | Non-drag paths (§5.3.5), text confirmation | axe-core, manual |
| Push notifications | In scope | Platform API, fact in the title | GLOSSARY §5.2 lint, manual |
| Alert email | In scope | Semantic HTML + real plain-text part | Template review, manual |
| Freshness clock & degradation banner | In scope | DOM + polite live region (§5.4.4) | CI-16, manual |
| Static pages (about, transparency, credits, a11y statement) | In scope | Semantic DOM | axe-core |
| WebGL map canvas | **Exempt with alternative** | Information duplicated in the DOM twin | CI-16 (parity is the condition of the exemption) |
| Admin plane | **Out of scope, conditionally** | Single selected user | Re-scope when moderators arrive (§6 Q3) |

## Appendix B — The seasonal manual pass

Half a day, before season start, TalkBack on a mid-range Android, screen off where possible.
Record pass/fail and time-to-complete per task; compare year over year.

1. **Orient.** Land on the site cold. Within 60 seconds, determine: is there a fire near me,
   and how fresh is this information?
2. **Find.** Reach the nearest event and obtain all seven per-event facts (§5.4.2) without
   touching the canvas.
3. **Degrade.** With the fixture forced into T2, determine that the data is degraded and how
   stale it is.
4. **Arm.** Set an alert for a named settlement at a chosen radius, without dragging, and
   read back what was armed.
5. **Receive.** Trigger a test alert; confirm the fact is comprehensible from the
   notification alone, without opening the app.
6. **Burst.** Inject ten new events in 30 seconds; confirm the announcements are coalesced,
   polite, and do not prevent reading.
7. **Scale.** Repeat tasks 1 and 2 at 200 % OS font scale on a 360 × 640 viewport; confirm
   the freshness line is never clipped.
8. **Keyboard.** On desktop, complete tasks 1–4 using only the keyboard; confirm skip-to-list,
   visible focus, no canvas trap, and no control obscured by the bottom bar.
9. **Motion.** With reduced motion enabled, confirm that new events are still distinguishable
   from active ones, on the map and in the list.
10. **Email.** Open an alert email with images blocked and forced dark mode on; confirm every
    fact survives.
