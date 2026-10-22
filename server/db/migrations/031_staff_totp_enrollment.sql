-- Migration 031 — a pending TOTP enrollment rides in the session's challenge slot
-- (TASKS I1; 05 C3, §5.4.3).
--
-- Enrolling TOTP is two steps: the member is shown a new secret, then types a code their
-- app made from it. Between the two the secret has to live somewhere, and nowhere in the
-- clear. It lives where a WebAuthn challenge lives (029): on the session that asked, for
-- the challenge's five minutes, taken by the single UPDATE that clears it — sealed under
-- the staff TOTP key exactly as `staff_totp_factors.secret_ciphertext` is (026), so the
-- confirmation moves the same bytes into the factor row.
--
--   `challenge_purpose` gains `totp.enroll`.
--   `challenge_key_id` — the sealing key's id, set exactly when the purpose is
--     `totp.enroll`; it names the key, never holds it.
--
-- A 20-byte secret seals to 48 bytes (iv 12 ‖ ct 20 ‖ tag 16), inside the slot's 16–64.

-- migrate:up

ALTER TABLE staff_sessions
  DROP CONSTRAINT staff_sessions_challenge_purpose_check,
  ADD CONSTRAINT staff_sessions_challenge_purpose_check
    CHECK (challenge_purpose IN ('webauthn.register', 'webauthn.authenticate', 'totp.enroll')),
  ADD COLUMN challenge_key_id text
    CONSTRAINT staff_sessions_challenge_key_id_shape
    CHECK (challenge_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  ADD CONSTRAINT staff_sessions_challenge_key_id_iff_totp
    CHECK ((challenge_key_id IS NOT NULL) = (challenge_purpose IS NOT DISTINCT FROM 'totp.enroll'));

-- migrate:down

UPDATE staff_sessions
SET challenge = NULL, challenge_purpose = NULL, challenge_expires_at = NULL,
    challenge_key_id = NULL
WHERE challenge_purpose = 'totp.enroll';

ALTER TABLE staff_sessions
  DROP CONSTRAINT IF EXISTS staff_sessions_challenge_key_id_iff_totp,
  DROP COLUMN IF EXISTS challenge_key_id,
  DROP CONSTRAINT staff_sessions_challenge_purpose_check,
  ADD CONSTRAINT staff_sessions_challenge_purpose_check
    CHECK (challenge_purpose IN ('webauthn.register', 'webauthn.authenticate'));
