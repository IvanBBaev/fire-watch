-- Migration 007 — accounts that can sign in, and zones that do not say where anyone lives
-- (TASKS I1, I2; 05 §5.3.2, §5.4.1; ADR-004 D8, A1.10).
--
-- Two halves, one migration, because they share a table and a reason: `accounts` and
-- `watch_zones` have existed since 001 as a frozen contract with nothing writing to them,
-- and the first writer needs both.
--
-- ── zones (I2) ─────────────────────────────────────────────────────────────────────
-- 001 stored a zone as `area geography` in clear. 05 §5.3.2 asks for the centre to be
-- encrypted with a service-held key and matched through a coarse plaintext index, so a SQL
-- injection, a leaked backup or a replica in the wrong hands yields ~5 km cells, not homes.
-- This migration adds that shape beside the old one:
--
--   `centre_ciphertext`, `centre_key_id` — AES-256-GCM of the *stored* centre (already
--                   ~1 km coarsened when the user left coarsening on, which is the
--                   default), sealed in the application; the key never reaches this
--                   database. Layout and associated data: `adapters/crypto/
--                   aes-gcm-zone-cipher.ts`. 44 bytes exactly, so a truncated write fails
--                   here rather than at the next alert.
--   `centre_coarsened` — whether the stored centre is the snapped one. Kept because the
--                   toggle is the user's (07 §5.5.1) and a settings screen that cannot say
--                   which it is would have to decrypt to guess.
--   `grid_version`, `grid_cell` — the clear candidate index: `zone_grid_v1`'s 0.05° cell
--                   (`core/zones/zone-geometry.ts`). Versioned, so a refit re-indexes rather
--                   than silently mixing two grids in one column.
--
-- A sealed row carries **no** `area`: the constraint below makes a sealed zone with a
-- plaintext geometry unrepresentable, which is the property I2's "done when" asks to be
-- verifiable. `area` itself is made nullable rather than dropped, because the integration
-- suites of H3–H6 still insert plaintext test zones through it, and whether plaintext rows
-- are forbidden outright — a follow-up that drops `area` and `watch_zones_area_gist` — is
-- left to the moment a zone matcher reads the sealed centre (see the I2 report). Until then
-- nothing in production reads `area` at all.
--
-- ── accounts and sessions (I1) ─────────────────────────────────────────────────────
-- 05 §5.4.1: cookie sessions, not JWTs; server-side session rows (id, user, created,
-- last_seen, UA family) so that takeover response is "revoke row"; magic links bound to a
-- server-side pending-auth record, not a self-contained token.
--
--   `accounts.email`, `email_verified_at` — §5.3.3's account record. The address is stored
--                   normalized (trimmed, lower-cased), and is unique among live accounts.
--                   Name and locale, also on §5.3.3's list, are not added: nothing reads
--                   them yet and the locale set is a product decision.
--   `auth_link_requests` — the pending-auth record behind a magic link. The link carries a
--                   random token; the row carries only its SHA-256, so a read of this table
--                   cannot be replayed into a sign-in. No foreign key to `accounts`: the
--                   first link to an address is how the account comes to exist.
--   `account_sessions` — one row per signed-in browser. Again only the token's SHA-256;
--                   the cookie is the only place the token itself exists.
--
-- Backup class: every new table is `personal` — an email address, a session, a UA family.
-- Grants: the runtime role reads and writes all of them, and deletes both auth tables —
-- expiry housekeeping and "log out everywhere" are deletes. No identity columns, so no
-- sequence grant.

-- migrate:up

-- ── watch_zones ──────────────────────────────────────────────────────────────────
ALTER TABLE watch_zones
  ALTER COLUMN area DROP NOT NULL,
  ADD COLUMN centre_ciphertext bytea,
  ADD COLUMN centre_key_id     text,
  ADD COLUMN centre_coarsened  boolean,
  ADD COLUMN grid_version      text CHECK (grid_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  ADD COLUMN grid_cell         text CHECK (grid_cell ~ '^-?[0-9]+:-?[0-9]+$'),
  -- Every zone has a geometry: a plaintext legacy one, or a sealed centre.
  ADD CONSTRAINT watch_zones_has_geometry
    CHECK (area IS NOT NULL OR centre_ciphertext IS NOT NULL),
  ADD CONSTRAINT watch_zones_centre_key_paired
    CHECK ((centre_ciphertext IS NULL) = (centre_key_id IS NULL)),
  -- A sealed zone is a circle with an index cell and no plaintext geometry, ever.
  ADD CONSTRAINT watch_zones_sealed_shape
    CHECK (
      centre_ciphertext IS NULL
      OR (
        area IS NULL
        AND octet_length(centre_ciphertext) = 44
        AND centre_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'
        AND centre_coarsened IS NOT NULL
        AND radius_m IS NOT NULL
        AND grid_version IS NOT NULL
        AND grid_cell IS NOT NULL
      )
    );

-- The candidate lookup: "which live zones sit in these cells?"
CREATE INDEX watch_zones_grid_cell ON watch_zones (grid_version, grid_cell)
  WHERE deleted_at IS NULL AND grid_cell IS NOT NULL;

-- ── accounts ─────────────────────────────────────────────────────────────────────
ALTER TABLE accounts
  ADD COLUMN email             text CHECK (email = lower(btrim(email)) AND email LIKE '_%@_%'),
  ADD COLUMN email_verified_at timestamptz;

CREATE UNIQUE INDEX accounts_email_live ON accounts (email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;

-- ── magic-link pending-auth records ──────────────────────────────────────────────
CREATE TABLE auth_link_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '_%@_%'),
  -- SHA-256 of the link token. The token itself is never stored.
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  -- The requesting browser's UA family; the link is only honoured by the same family (C2).
  ua_family     text NOT NULL CHECK (ua_family <> ''),
  requested_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  -- Single use: set once, by the "Continue" click, never by the prefetch of the GET.
  consumed_at   timestamptz,
  -- Invalidated by a newer issuance to the same address (05 §5.4.1).
  superseded_at timestamptz,
  CONSTRAINT auth_link_requests_expiry_after_request CHECK (expires_at > requested_at),
  CONSTRAINT auth_link_requests_one_ending CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);

-- The 3-per-address-per-hour count and the supersede sweep both read by address and time.
CREATE INDEX auth_link_requests_by_email ON auth_link_requests (email, requested_at);

-- ── sessions ─────────────────────────────────────────────────────────────────────
CREATE TABLE account_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the cookie's token. The token itself is never stored.
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  ua_family     text NOT NULL CHECK (ua_family <> ''),
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  -- Sliding: moved to last_seen_at + 30 days on every authenticated request (§5.4.1).
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  CONSTRAINT account_sessions_seen_after_created CHECK (last_seen_at >= created_at),
  CONSTRAINT account_sessions_expiry_after_seen CHECK (expires_at > last_seen_at)
);

-- "Log out everywhere" and the account screen's session list.
CREATE INDEX account_sessions_by_account ON account_sessions (account_id)
  WHERE revoked_at IS NULL;

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('auth_link_requests', 'personal', 'email address; token hashes only'),
  ('account_sessions',   'personal', 'keyed by account; token hashes only');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- `accounts` and `watch_zones` already carry SELECT, INSERT, UPDATE, DELETE from 001, and
-- a new column inherits a table-level grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_link_requests, account_sessions TO fire_watch_app;

-- migrate:down

-- Refuses rather than deletes: a rollback that quietly dropped every sealed zone would be
-- an erasure nobody asked for. Remove or re-plaintext those rows deliberately first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM watch_zones WHERE area IS NULL) THEN
    RAISE EXCEPTION 'watch_zones holds sealed zones with no plaintext area; '
      'migration 007 cannot be rolled back over them';
  END IF;
END
$$;

DELETE FROM table_backup_class WHERE table_name IN ('auth_link_requests', 'account_sessions');

DROP TABLE IF EXISTS account_sessions;
DROP TABLE IF EXISTS auth_link_requests;

DROP INDEX IF EXISTS accounts_email_live;
ALTER TABLE accounts
  DROP COLUMN IF EXISTS email_verified_at,
  DROP COLUMN IF EXISTS email;

DROP INDEX IF EXISTS watch_zones_grid_cell;
ALTER TABLE watch_zones
  DROP CONSTRAINT IF EXISTS watch_zones_sealed_shape,
  DROP CONSTRAINT IF EXISTS watch_zones_centre_key_paired,
  DROP CONSTRAINT IF EXISTS watch_zones_has_geometry,
  DROP COLUMN IF EXISTS grid_cell,
  DROP COLUMN IF EXISTS grid_version,
  DROP COLUMN IF EXISTS centre_coarsened,
  DROP COLUMN IF EXISTS centre_key_id,
  DROP COLUMN IF EXISTS centre_ciphertext,
  ALTER COLUMN area SET NOT NULL;
