# Fire Watch editorial standard (DRAFT)

> **Status: implementer draft for founder sign-off.** This file states the rules the WP6
> admin form and the staff curation routes enforce today (TASKS L15, GATES.md §3 L-15). It
> follows review 16 §5.2–§5.5 and §5.10. Each `[FOUNDER SIGN-OFF]` marker is a sentence or
> rule the founder has to word or decide before the standard is published. Until they are
> resolved, this document is **not public** and no curated statement ships.

## 1. What this standard covers

Fire Watch publishes in its own voice only what its pipeline measures. The machine never
says what an authority decided. Some facts must still be said, such as a fire being
officially declared contained, and those reach the public record only as a **curated
statement**. A named staff member writes it, a second staff member approves it, and it
cites its sources.

A curated statement is one of three types, and there are no others. The form offers no
free-text state.

| Type | Meaning | Public label |
|---|---|---|
| `officially_contained` | An authority declared the spread stopped (*локализиран*) | [FOUNDER SIGN-OFF] normative Bulgarian label |
| `officially_extinguished` | An authority declared the fire finished (*ликвидиран*) | [FOUNDER SIGN-OFF] normative Bulgarian label |
| `curated_correction` | Our correction of our own earlier curated statement (§6) | [FOUNDER SIGN-OFF] |

The staff form shows the two official types as "Official milestone 1" and "Official
milestone 2". The never-send lint keeps the plain words out of the web catalogs. Those
staff labels are themselves pending founder review (`PENDING_FOUNDER_REVIEW`,
`staffCuration.*`).

## 2. The source ladder

Every cited source has a tier. The tier belongs to the **statement**, not the outlet:
БТА quoting a named ГДПБЗН officer verbatim is a T2 statement carried by a T3 outlet.

| Tier | Examples | May support |
|---|---|---|
| **T1** official, durable | ГДПБЗН/МВР bulletins, municipal announcements on a municipal domain, ДВ | An official state, alone (exception 3.1) |
| **T2** official, ephemeral | An official social-media post; an official quoted verbatim in a wire item | An official state together with a second independent source |
| **T3** journalistic | БТА, national broadcasters, established regional outlets | Never an official state in our voice. May be cited by a correction |
| **T4** unverified | Posts by non-officials, user reports, forums | **Nothing.** The form and the server both refuse it |

[FOUNDER SIGN-OFF] Review 16 §5.2 lets a T2 source stand alone for a de-escalating fact,
but §5.3 asks for two sources unless an exception applies. The code applies the stricter
§5.3 reading: T2 alone is refused (`second_source_required`). The founder decides which
reading is the standard.

## 3. The two-source rule

A curated statement needs **two independent sources, at least one of them T1 or T2**.
Two sources are *independent* only if neither republishes the other. Two outlets running
the same wire item are one source. The form refuses a second source that points at the
same document as the first (`second_source_not_independent`). Whether two different
documents are really independent is the reviewer's judgement, and the form cannot check it.

There are three named exceptions. Choosing one is recorded on the statement.

1. **`t1_de_escalation`.** A T1 bulletin declaring one of the two official states may be
   published alone. It applies only to a T1 primary source and only to an official state.
2. **`life_safety_relay`.** [FOUNDER SIGN-OFF] This covers relaying an official evacuation
   instruction from a single source, as a quoted, linked item that is shown, never pushed.
   Whether it can ever carry a curated *state* is open (review 16 §6 Q2, tied to the 12 Q2
   legal question). Until that is decided, the form refuses it as `exception_not_applicable`.
3. **`own_correction`.** A correction of our own statement never waits for a second source.
   It applies only to `curated_correction`.

## 4. Never publishable, at any tier

These rules cover the curated layer as well as alerts (review 16 §5.3). The form does not
read free text for meaning, so these rules are the reviewer's to apply:

- a claim in our own voice that a fire is out, safe or no longer a threat;
- any prediction of fire behaviour;
- any statement about cause or a responsible party;
- casualty or damage counts before an official figure exists;
- any instruction to act in our own voice. Only quoted official instructions are allowed.

[FOUNDER SIGN-OFF] the final Bulgarian wording of this list for the public page.

## 5. What every statement carries (the WP6 form)

| Field | Rule (refusal code) |
|---|---|
| Event | Required, an event id (`event_id_invalid`) |
| Statement type | One of the three types in §1 (`statement_type_invalid`) |
| Source tier | T1–T3. **T4 is refused** (`source_unverified`). T3 cannot carry a state (`journalistic_source_for_state`) |
| Source link | An http(s) URL (`source_url_invalid`) |
| Capture | **Required**; a statement without evidence is refused (`capture_missing`) |
| Stated at | The authority's own timestamp, not ours. It cannot lie in the future (`stated_at_invalid`, `stated_at_in_future`) |
| Curator | The signed-in staff member, taken from the session and never typed |
| Second source | Required unless an exception holds (`second_source_required`, `official_source_missing`, `second_source_*`) |
| Exception | Optional, one of §3 (`exception_invalid`, `exception_not_applicable`) |
| Justification | One line, up to 280 characters (`justification_missing`, `justification_not_one_line`) |
| Correction text | A correction only: what is now known, up to 500 characters (`correction_text_*`) |

The rules live once, in `packages/contracts/src/curated-statement.ts`. The form checks them
before it sends, and the server checks them again because the form is not trusted. The
server names a refusal by its problem code (`statement_source_unverified`,
`statement_capture_missing`, `statement_invalid`) and never echoes the draft back.

**The capture is evidence, not publication.** It is kept for review and audit and is never
served (`publicViewOf` drops it). [FOUNDER SIGN-OFF] Where the capture is stored (an object
key in the R2 bucket, or an archive URL) and how long it is kept.

**Quotation.** Until the lawyer session (review 09 §10) answers the licensing question, a
statement quotes one or two sentences at most and links the source. [FOUNDER SIGN-OFF]

## 6. Two-person approval and the record

- A statement moves **draft → in review → published**. Only a published version is ever
  public.
- **Nobody who wrote a version may approve it** (`statement_self_review`). The rule compares
  people, not roles. The form hides "approve" from a contributor, and the server refuses
  it anyway.
- An edit made during review withdraws the version from review. A stale approval, decided
  from an older edit, is refused (`statement_conflict`).
- **A published version is frozen.** Postgres refuses any change to it with a trigger. The
  only way to change what was said is a correction.
- Every action writes an append-only audit row with the actor, the action, the version and
  the time.
- Every route needs a staff session that has passed the second factor (`not_signed_in`,
  `staff_forbidden`), from an allowed Origin (`origin_refused`).

## 7. Corrections

A correction is a new version (N+1) of the same entry. It goes through the same draft,
review and approval, and records which version it corrects. **Nothing is deleted.** The
original stays visible, marked as withdrawn, below the correction, and both timestamps are
shown.

Public copy shape (English seed; [FOUNDER SIGN-OFF] the Bulgarian is normative and belongs
in GLOSSARY):

> Correction, \<date\>: we previously reported that \<authority\> declared this fire
> \<state\> on \<date\>. That was incorrect: \<what is now known\>. Source: \<link\>.

[FOUNDER SIGN-OFF] Not built yet:

- how the corrected statement renders on the public event page;
- reverting the event's machine state (it must not create a `new_fire`);
- whether a curated state change ever triggers a push. Review 16 §5.5.3 recommends never
  in v1.

## 8. The rehearsal

`pnpm curation-rehearsal` runs the correction path end to end over the in-memory store
and exits 0 only when every step behaves as described above. It covers:

1. A curator drafts an official state.
2. The curator submits it, and the curator's own approval is refused.
3. A second staff member approves it, and the statement is published.
4. A silent edit of the published version is refused.
5. A correction (version 2) is drafted.
6. A second person approves the correction.
7. The audit trail is printed.

The same script runs against Postgres 16 in `pg-staff-plane.integration.test.ts`.

Not yet rehearsed: the GATES L-15 requirement for a rehearsal on staging with two real
people. That needs:

- the staff host and its cookie;
- the mail sender for primary staff sign-in;
- the L-17 rehearsal profile.

## 9. Open for the founder

1. The normative Bulgarian labels for the three statement types and for the correction copy.
2. T2 alone: §5.2 or the stricter §5.3 (§2 above).
3. `life_safety_relay` and pushes of curated states (review 16 §6 Q1–Q2).
4. Capture storage and retention.
5. Who the named news-log curator is, and the second reviewer: GATES L-15 passes only when
   the curator is not the sole reviewer.
6. Quotation length and licensing (review 09 §10).
7. The staff host, the cookie and the mail sender. The routes
   (`server/src/adapters/http/staff-curation-route.ts`) are built and tested, but they are
   not registered in `api.ts` until these exist.
8. The public rendering of curated statements and corrections, and the machine-state
   reversion.
