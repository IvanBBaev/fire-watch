-- Migration 030 — TOTP factor removal, a second-factor attempt cap, and off-boarding
-- (TASKS I1; 05 C3, §5.4.3).
--
-- 026 left `staff_totp_factors` without DELETE until a removal path existed. Two paths now
-- exist, both in `pg-staff-store.ts`, both audited in the same transaction:
--
--   * removing a member's TOTP factor (by the member or an admin), refused when it is
--     their last second factor, ending the sessions the factor let in;
--   * off-boarding a member: disable, end every session, delete every credential, the TOTP
--     factor, the recovery codes and the role grants (docs/runbooks/06-staff-offboarding.md).
--
--   `staff_sessions.second_factor_failures` — wrong TOTP or recovery codes typed on a
--     pending session. A six-digit code is guessable given enough tries, so the session is
--     revoked once the count reaches `STAFF_SESSION_POLICY.maxSecondFactorFailures`
--     (core/staff/staff-session-policy.ts); the member signs in again from the start.
--
-- No new audit action: removal is `staff.second_factor_removed` (029), off-boarding is
-- `staff.manage`, a lockout is `staff.sign_out` with its reason.

-- migrate:up

GRANT DELETE ON staff_totp_factors TO fire_watch_app;

ALTER TABLE staff_sessions
  ADD COLUMN second_factor_failures integer NOT NULL DEFAULT 0
    CONSTRAINT staff_sessions_second_factor_failures_non_negative
    CHECK (second_factor_failures >= 0);

-- migrate:down

ALTER TABLE staff_sessions DROP COLUMN IF EXISTS second_factor_failures;
REVOKE DELETE ON staff_totp_factors FROM fire_watch_app;
