# 06 — Staff off-boarding and a compromised staff account

> **PRE-SEASON DRAFT (2026-10-22).** Not yet exercised. There is no staff plane on any
> host: the staff HTTP routes, the staff subdomain and the admin UI are
> `NOT YET BUILT (L-15)`, and primary staff sign-in waits on the mail sender (I1,
> founder). What exists is the storage and the core flows, proven against Postgres in
> `server/src/adapters/db/pg-staff-totp-offboarding.integration.test.ts`. Revise after
> season 1 and at every pre-season drill (see [README](README.md)).

**Class.** A staff member (editor, moderator, alert-operator, admin; 05 §5.4.3) leaves,
changes duties, loses a device, or their account is suspected to be in someone else's
hands. The staff plane can publish incident-log entries and approve notifications, so
an account that outlives its owner's role is a standing broadcast risk.

**Sources.**
- 05 C3 and §5.4.3 (staff roles, second factor required), A3 (two-person approval).
- OPERATIONS §8.2 rule 7: contributor off-boarding is a secret-rotation trigger.
- Migrations 026 (staff tables, audit log), 029 (sessions, credential removal), 030
  (TOTP removal, the wrong-code cap, off-boarding).
- Code: `server/src/core/staff/staff-session.ts` (`offboardStaffMember`,
  `disableStaffMember`, `removeStaffTotpFactor`, `removeWebAuthnCredential`,
  `setStaffRoles`), `server/src/adapters/db/pg-staff-store.ts`.

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| A person leaves or changes role | founder / HR side | Planned off-boarding or a role change (§3.1, §3.2). |
| A lost or stolen phone or security key | the member reports it | Remove that factor (§3.3). |
| `staff.sign_out` audit rows on pending sessions of one member, in bursts | `staff_audit_log` | Wrong TOTP or recovery codes hit the cap of `STAFF_SESSION_POLICY.maxSecondFactorFailures` (5) and the session was ended. One burst is a fat finger; repeated bursts mean someone holds the member's primary sign-in and is guessing the second factor (§3.4). |
| `staff.recovery_code_used` the member did not do | `staff_audit_log` | Treat as compromised (§3.4). |

`NOT YET BUILT (C5/J1)`: nothing pages on staff audit rows. They are read by hand.

## 2. What each operation does

All of them are audited in the same transaction as the change, with the acting admin
as `actor_id`. The audit trail stores SHA-256 hashes of the before/after state, never a
key, a secret or a code.

| Operation | Who | Effect | Audit |
|---|---|---|---|
| **Off-board** (`offboardStaffMember`) | `staff.manage`, never on oneself | Disables the member, ends every session, deletes every WebAuthn credential, the TOTP factor, the recovery codes and every role grant. Works on an already disabled member too, so a member disabled in a hurry can be cleaned out later. A repeat on a clean member is `already_offboarded` and writes nothing. | `staff.manage` on `staff_member/<id>`; before = counts and role names, after = `{disabled, offboarded, sessionsRevoked}` |
| **Disable** (`disableStaffMember`) | `staff.manage`, never on oneself | Disables and ends every session; credentials and roles stay. The fast first move when in doubt. | `staff.manage` |
| **Remove a TOTP factor** (`removeStaffTotpFactor`) | the member, or `staff.manage` | Deletes the factor and ends the sessions it signed in. Refused when it is the member's last second factor. Recovery codes stay. | `staff.second_factor_removed` |
| **Remove a key** (`removeWebAuthnCredential`) | the member, or `staff.manage` | Same, for one WebAuthn credential. | `staff.second_factor_removed` |
| **Re-admit** (`readmitStaffMember`) | `staff.manage`, never on oneself | Re-enables a fully off-boarded member and grants the given roles. Refused as `already_live` for a live member and `not_offboarded` for a disabled one that still holds a credential, a TOTP factor, recovery codes, a role or an open session — off-board first, so no old factor comes back. The member enrolls a fresh second factor. | `staff.manage`; before = `{disabled, roles: []}`, after = `{disabled: false, readmitted, roles}` |
| **Change roles** (`setStaffRoles`) | `staff.manage`, never on oneself | Replaces the role set; audited only when it changes. | `staff.manage` |

The member row itself is kept: `staff_audit_log.actor_id` references it, and the audit
trail outlives the person. Staff rows are outside account erasure
(`ERASURE_OUT_OF_SCOPE`); how long an off-boarded member's email and name are kept is a
founder decision (I6 retention schedule).

## 3. Procedures

**Operator entry point.** `NOT YET BUILT (L-15)`: the admin UI and its staff routes.
Until they exist there is no supported way to run these operations on a host, and
there is nothing on a host to protect. Do **not** substitute hand-written SQL: a direct
`UPDATE`/`DELETE` skips the audit row and the last-factor rule. When L-15 lands it
updates this section with the screen or route that calls each operation.

### 3.1 Planned departure

1. A second admin (never the leaving member; the rule refuses self-changes) runs
   **off-board** on the member, on or before their last day.
2. Check the result counts: `sessionsRevoked`, `webauthnRemoved`, `totpRemoved`,
   `recoveryCodesRemoved`, `rolesRemoved`. A second run must answer
   `already_offboarded`.
3. Rotate what the person could reach outside the app (OPERATIONS §8.2 rule 7):
   provider-account seats (GitHub, Cloudflare, Hetzner, AWS, …), any shared secret in
   §8.1 they could read, the fw-alerts Telegram chat membership. Each §8.1 row's
   one-line rotation procedure is still owed (OPERATIONS §8.2 rule 6).
4. If they were one of only two people able to approve broadcasts (A3), say so to the
   founder the same day: two-person approval needs two live members with
   `notification.approve`.

### 3.2 Change of duties

Change roles; do not off-board. Sessions keep running, but every request re-reads the
live role set, so a dropped role stops working on the next request.

### 3.3 Lost or stolen device

1. The member signs in with a remaining factor or a recovery code and removes the lost
   factor themselves; or an admin removes it. Its sessions end with it.
2. If the lost device was the **last** factor, removal is refused by design. The
   member signs in with a recovery code, enrolls a new factor, then removes the old
   one. Without a recovery code: **off-board**, then **re-admit** (§2) with the
   member's roles. They come back with no second factor; their next primary sign-in
   opens a pending session from which they enroll a fresh one, as a new member would.
   The member row and email stay the same, so the trail stays theirs.

### 3.4 Suspected compromise

1. **Disable first** (seconds, keeps evidence), then **off-board**.
2. Read what the account did, from the earliest suspicious time:
   ```sql
   SELECT at, action, entity_kind, entity_id, host(ip) AS ip
   FROM staff_audit_log
   WHERE actor_id = '<staff id>' AND at >= '<since>'
   ORDER BY at;
   ```
   and what was done to it (`entity_id = '<staff id>'` or one of its session ids).
3. Every `incident.publish` and `notification.approve` by that actor is suspect: re-read
   the published incident-log versions and, if one is wrong, publish a correction (C4
   revision N+1). A notification already sent cannot be recalled; follow
   [03](03-alert-dispatch-misfire.md) for a public correction.
4. Rotate secrets as in §3.1 step 3, and treat it as a personal-data incident if the
   account could read personal data (`NOT YET BUILT (I-track)`: the breach runbook).

## 4. Known gaps

- `NOT YET BUILT (L-15)`: the operator entry point for every operation above.
- The TOTP sealing key (`FIRE_WATCH_STAFF_TOTP_KEY_ID` / `_KEY`, read by
  `loadStaffTotpConfig`) is not in any host's secret store yet (owner). Until it is, no
  member can hold a TOTP factor on a host.
- No paging on staff audit rows (§1).

## 5. Post-incident

Record: who was off-boarded, by whom, when, the counts returned, which external seats
and secrets were rotated, and — for a compromise — every suspect action and what was
done about it. Update this runbook with any step that did not match.
