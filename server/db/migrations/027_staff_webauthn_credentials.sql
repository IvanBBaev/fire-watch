-- Migration 027 — WebAuthn credentials for the staff plane's second factor (TASKS I1;
-- 05 C3, §5.4.3).
--
-- 05 makes 2FA mandatory for staff, **WebAuthn/passkey preferred**, TOTP the fallback (026).
-- The verification is `adapters/crypto/webauthn.ts`; this table is what it needs kept:
--
--   `staff_webauthn_credentials` — one row per registered authenticator. A member may hold
--                                  several (a phone passkey and a spare security key).
--     * `credential_id`   — the authenticator's handle, at most 1023 bytes (WebAuthn §6.1).
--                           Unique across the plane: two members cannot claim one key.
--     * `public_key_cose` — the COSE_Key exactly as the authenticator encoded it. A public
--                           key, so it is stored as is (nothing to seal).
--     * `algorithm`       — the COSE algorithm, one of the three the verifier accepts
--                           (ES256 −7, EdDSA −8, RS256 −257), pinned by a unit test.
--     * `sign_count`      — §6.1.1's signature counter. The store advances it with a
--                           compare-and-set (`sign_count < new`, or both 0 for a synced
--                           passkey), so two racing assertions cannot both win and a cloned
--                           authenticator shows up as a counter that did not move forward.
--     * `backup_eligible` — BE at registration: a synced passkey rather than a device-bound
--                           key. Kept so an admin can see which members rely on a cloud
--                           account; nothing gates on it yet.
--
-- Challenges are not here: a ceremony's challenge lives in the staff session that started
-- it, which arrives with the staff subdomain. Removing a credential is a later admin route;
-- until then a lost key is handled by disabling the member (026), so there is no DELETE.
-- Enrolling a credential is audited as `staff.second_factor_enrolled` (026's CHECK).

-- migrate:up

CREATE TABLE staff_webauthn_credentials (
  credential_id    bytea PRIMARY KEY CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
  staff_id         uuid NOT NULL REFERENCES staff_members (id),
  public_key_cose  bytea NOT NULL CHECK (octet_length(public_key_cose) BETWEEN 32 AND 2048),
  algorithm        integer NOT NULL CHECK (algorithm IN (-7, -8, -257)),
  sign_count       bigint NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  backup_eligible  boolean NOT NULL,
  -- The member's own name for the key ("work YubiKey"), shown when choosing one.
  label            text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 64),
  enrolled_at      timestamptz NOT NULL,
  last_used_at     timestamptz,
  CONSTRAINT staff_webauthn_credentials_used_after_enrolled
    CHECK (last_used_at IS NULL OR last_used_at >= enrolled_at)
);

-- A member's keys, for the assertion's allow-list.
CREATE INDEX staff_webauthn_credentials_by_staff ON staff_webauthn_credentials (staff_id);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('staff_webauthn_credentials', 'personal', 'staff authenticator public keys');

-- No DELETE: a credential is retired by disabling its member until a removal route exists.
GRANT SELECT, INSERT, UPDATE ON staff_webauthn_credentials TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'staff_webauthn_credentials';
DROP TABLE IF EXISTS staff_webauthn_credentials;
