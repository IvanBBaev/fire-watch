-- Migration 029 — staff sessions, the ceremony challenge they carry, and credential removal
-- (TASKS I1; 05 C3, §5.4.3).
--
-- 05 asks for a separate session namespace for the staff plane: a staff member is not an
-- account (026), so their sessions are not `account_sessions` rows either.
--
--   `staff_sessions` — one row per signed-in staff browser. Like `account_sessions` (007)
--                      it keeps only the SHA-256 of the cookie's token. What differs:
--     * two expiries: `idle_expires_at` slides (bounded by the absolute one) and
--       `absolute_expires_at` never moves, so a staff session ends however busy it is.
--       The windows are `STAFF_SESSION_POLICY` (core/staff/staff-session-policy.ts).
--     * the second factor: `second_factor_at` is NULL until the session passes WebAuthn,
--       TOTP or a recovery code; until then the session has no powers (`staffMay`). The
--       method is kept, and for WebAuthn the credential, so removing a credential can end
--       the sessions it let in.
--     * the ceremony challenge: a WebAuthn challenge lives on the session that asked for
--       it — at most one pending per session, with its purpose and expiry, and the store
--       takes it with a single UPDATE that clears it, so a challenge is answered once.
--
-- Passing the second factor also replaces `token_hash` (a fresh cookie), so a token seen
-- before the elevation is worthless after it.
--
-- Credential removal: 027 left `staff_webauthn_credentials` without DELETE until a removal
-- path existed; this migration grants it, and adds `staff.second_factor_removed` to the
-- audit trail's actions (the CHECK is `STAFF_AUDIT_ACTIONS`, pinned by a test).
--
-- Backup class `personal`. Grants: the runtime role reads and writes sessions and may
-- delete them (expiry housekeeping, as with 007).

-- migrate:up

CREATE TABLE staff_sessions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the cookie's token. The token itself is never stored.
  token_hash                   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  staff_id                     uuid NOT NULL REFERENCES staff_members (id),
  ua_family                    text NOT NULL CHECK (ua_family <> '' AND length(ua_family) <= 64),
  created_at                   timestamptz NOT NULL,
  last_seen_at                 timestamptz NOT NULL,
  idle_expires_at              timestamptz NOT NULL,
  absolute_expires_at          timestamptz NOT NULL,
  second_factor_method         text CHECK (second_factor_method IN ('webauthn', 'totp', 'recovery_code')),
  second_factor_credential_id  bytea,
  second_factor_at             timestamptz,
  challenge                    bytea CHECK (octet_length(challenge) BETWEEN 16 AND 64),
  challenge_purpose            text CHECK (challenge_purpose IN ('webauthn.register', 'webauthn.authenticate')),
  challenge_expires_at         timestamptz,
  revoked_at                   timestamptz,
  CONSTRAINT staff_sessions_seen_after_created CHECK (last_seen_at >= created_at),
  CONSTRAINT staff_sessions_idle_within_absolute CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT staff_sessions_absolute_after_created CHECK (absolute_expires_at > created_at),
  CONSTRAINT staff_sessions_second_factor_paired
    CHECK ((second_factor_method IS NULL) = (second_factor_at IS NULL)),
  CONSTRAINT staff_sessions_credential_is_webauthn
    CHECK (second_factor_credential_id IS NULL OR second_factor_method = 'webauthn'),
  CONSTRAINT staff_sessions_challenge_complete
    CHECK ((challenge IS NULL) = (challenge_purpose IS NULL)
       AND (challenge IS NULL) = (challenge_expires_at IS NULL))
);

-- Disabling a member ends their sessions; removing a credential ends the ones it let in.
CREATE INDEX staff_sessions_by_staff ON staff_sessions (staff_id) WHERE revoked_at IS NULL;

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('staff_sessions', 'personal', 'keyed by staff member; token hashes only');

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_sessions TO fire_watch_app;

-- A credential is removed by its member or an admin (core/staff/staff-session-policy.ts).
GRANT DELETE ON staff_webauthn_credentials TO fire_watch_app;

ALTER TABLE staff_audit_log DROP CONSTRAINT staff_audit_log_action_check;
ALTER TABLE staff_audit_log ADD CONSTRAINT staff_audit_log_action_check CHECK (action IN (
  'incident.draft',
  'incident.review',
  'incident.publish',
  'notification.approve',
  'report.moderate',
  'staff.manage',
  'config.edit',
  'audit.read',
  'staff.sign_in',
  'staff.sign_out',
  'staff.second_factor_enrolled',
  'staff.second_factor_removed',
  'staff.recovery_code_used',
  'incident.edit',
  'incident.submit',
  'incident.reject'
));

-- migrate:down

-- Refuses (the CHECK fails) while the trail holds a removal; the trail is evidence and a
-- rollback does not rewrite it.
ALTER TABLE staff_audit_log DROP CONSTRAINT staff_audit_log_action_check;
ALTER TABLE staff_audit_log ADD CONSTRAINT staff_audit_log_action_check CHECK (action IN (
  'incident.draft',
  'incident.review',
  'incident.publish',
  'notification.approve',
  'report.moderate',
  'staff.manage',
  'config.edit',
  'audit.read',
  'staff.sign_in',
  'staff.sign_out',
  'staff.second_factor_enrolled',
  'staff.recovery_code_used',
  'incident.edit',
  'incident.submit',
  'incident.reject'
));
REVOKE DELETE ON staff_webauthn_credentials FROM fire_watch_app;
DELETE FROM table_backup_class WHERE table_name = 'staff_sessions';
DROP TABLE IF EXISTS staff_sessions;
