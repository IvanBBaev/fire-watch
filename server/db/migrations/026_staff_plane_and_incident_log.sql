-- Migration 026 — the staff plane's storage and the incident log (TASKS I1; 05 C3, C4,
-- §5.4.3, T2/T7; A3).
--
-- The pure rules landed first (`core/staff/`, `adapters/crypto/totp.ts`); this migration is
-- where they are kept. Two halves:
--
-- ── staff (personal) ───────────────────────────────────────────────────────────────
--   `staff_members`        — one row per human on the staff plane. Never deleted: the audit
--                            trail references it, so a departure is `disabled_at`.
--   `staff_role_grants`    — the §5.4.3 roles, one row per (member, role). The CHECK is
--                            `STAFF_ROLES` (core/staff/staff-policy.ts), pinned by a test.
--   `staff_totp_factors`   — the TOTP fallback. The secret is sealed in the application
--                            (the key never reaches this database, like a zone centre), and
--                            `last_used_step` is the RFC 6238 §5.2 replay guard: the store
--                            advances it with a compare-and-set, so two concurrent uses of
--                            one code cannot both win.
--   `staff_recovery_codes` — SHA-256 of each recovery code, never the code. Used once.
--   `staff_audit_log`      — §5.4.3's append-only table: actor, action, entity, before/after
--                            hash, IP, time. The CHECK on `action` is `STAFF_AUDIT_ACTIONS`
--                            (core/staff/staff-audit.ts), pinned by a test.
--
-- The staff session table and its cookie belong with the staff subdomain and are not here;
-- nor is WebAuthn. A staff member is not an account: no table here references `accounts`,
-- so account erasure (010) never reaches the staff plane and the staff plane never reaches
-- a member of the public.
--
-- ── incident log (main + one personal table) ───────────────────────────────────────
--   `incident_log_entries`  — the entry's identity.
--   `incident_log_versions` — C4's versions. A version moves draft → in_review → published;
--                             a published version is frozen (a trigger refuses any change
--                             to it), and at most one unpublished version exists per entry,
--                             so a revision is always "the next draft", never a fork.
--   `incident_log_version_contributors` — who wrote each version, which is what the
--                             reviewer rule reads (no contributor reviews their own words).
--
-- **Backup classes.** The incident log is public content and must survive a main-only
-- restore (OPERATIONS §6.2 rule 8), so entries and versions are `main`. Who wrote them is
-- staff personal data, so contributors live in their own `personal` table, which points
-- personal → main and personal → personal only. All staff tables are `personal`.
--
-- **Retention.** 05's register keeps the editorial/admin audit log 24 months. Removal goes
-- through `purge_staff_audit_log`, a SECURITY DEFINER function that refuses a missing or
-- future cutoff; nothing arms it yet (the same shape as 014's decision-log purge).
--
-- Grants: the audit log is SELECT, INSERT only. Versions are SELECT, INSERT, UPDATE (an
-- unpublished version changes status and text; the trigger freezes published ones), no
-- DELETE. Contributors are SELECT, INSERT. Members get no DELETE — a member is disabled.
-- DELETE exists only where a row is replaced rather than evidence: a role grant (revoking
-- it) and the recovery-code set (re-enrolling replaces it).

-- migrate:up

-- ── staff ────────────────────────────────────────────────────────────────────────
CREATE TABLE staff_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '_%@_%'),
  display_name  text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 120),
  created_at    timestamptz NOT NULL,
  disabled_at   timestamptz,
  CONSTRAINT staff_members_disabled_after_created
    CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);

CREATE TABLE staff_role_grants (
  staff_id    uuid NOT NULL REFERENCES staff_members (id),
  role        text NOT NULL CHECK (role IN ('editor', 'alert-operator', 'moderator', 'admin')),
  granted_at  timestamptz NOT NULL,
  PRIMARY KEY (staff_id, role)
);

CREATE TABLE staff_totp_factors (
  staff_id           uuid PRIMARY KEY REFERENCES staff_members (id),
  -- Sealed in the application; this database never sees the secret or its key.
  secret_ciphertext  bytea NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 16 AND 256),
  secret_key_id      text NOT NULL CHECK (secret_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  algorithm          text NOT NULL CHECK (algorithm IN ('sha1', 'sha256', 'sha512')),
  enrolled_at        timestamptz NOT NULL,
  -- The highest RFC 6238 step accepted; NULL before the first use.
  last_used_step     bigint CHECK (last_used_step >= 0)
);

CREATE TABLE staff_recovery_codes (
  staff_id    uuid NOT NULL REFERENCES staff_members (id),
  code_hash   bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  issued_at   timestamptz NOT NULL,
  used_at     timestamptz,
  PRIMARY KEY (staff_id, code_hash),
  CONSTRAINT staff_recovery_codes_used_after_issue CHECK (used_at IS NULL OR used_at >= issued_at)
);

CREATE TABLE staff_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     uuid NOT NULL REFERENCES staff_members (id),
  action       text NOT NULL CHECK (action IN (
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
               )),
  entity_kind  text NOT NULL CHECK (entity_kind ~ '^[a-z][a-z_]{0,63}$'),
  entity_id    text NOT NULL CHECK (entity_id <> '' AND length(entity_id) <= 128),
  -- Lower-case hex SHA-256 of the state's canonical JSON (ADR-002 D7); NULL for a
  -- creation (before) or a deletion (after).
  before_hash  text CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash   text CHECK (after_hash ~ '^[0-9a-f]{64}$'),
  ip           inet,
  at           timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- One entity's history, and one member's actions, newest last.
CREATE INDEX staff_audit_log_by_entity ON staff_audit_log (entity_kind, entity_id, at);
CREATE INDEX staff_audit_log_by_actor ON staff_audit_log (actor_id, at);
-- The retention purge walks the oldest rows first.
CREATE INDEX staff_audit_log_by_at ON staff_audit_log (at);

-- ── incident log ─────────────────────────────────────────────────────────────────
CREATE TABLE incident_log_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL
);

CREATE TABLE incident_log_versions (
  entry_id               uuid NOT NULL REFERENCES incident_log_entries (id),
  version                integer NOT NULL CHECK (version >= 1),
  status                 text NOT NULL CHECK (status IN ('draft', 'in_review', 'published')),
  triggers_notifications boolean NOT NULL,
  major                  boolean NOT NULL,
  -- The entry's text. Its shape is the editor's and the public page's to agree on; the
  -- schema only insists it is an object.
  content                jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  published_at           timestamptz,
  PRIMARY KEY (entry_id, version),
  CONSTRAINT incident_log_versions_published_has_time
    CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT incident_log_versions_updated_after_created CHECK (updated_at >= created_at)
);

-- At most one version per entry is still being written or reviewed.
CREATE UNIQUE INDEX incident_log_versions_one_open
  ON incident_log_versions (entry_id) WHERE status <> 'published';
-- The public page's history: published versions in order.
CREATE INDEX incident_log_versions_published
  ON incident_log_versions (entry_id, published_at) WHERE status = 'published';

-- A published version is the public record; a revision is version N+1, never an edit.
CREATE FUNCTION incident_log_versions_freeze_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'incident log version %/% is published and cannot change',
      OLD.entry_id, OLD.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER incident_log_versions_freeze_published
  BEFORE UPDATE ON incident_log_versions
  FOR EACH ROW EXECUTE FUNCTION incident_log_versions_freeze_published();

CREATE TABLE incident_log_version_contributors (
  entry_id  uuid NOT NULL,
  version   integer NOT NULL,
  staff_id  uuid NOT NULL REFERENCES staff_members (id),
  -- First-touch order, which `IncidentEntryVersion.contributorIds` preserves.
  position  integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, version, staff_id),
  CONSTRAINT incident_log_version_contributors_position_unique UNIQUE (entry_id, version, position),
  FOREIGN KEY (entry_id, version) REFERENCES incident_log_versions (entry_id, version)
);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('staff_members',                    'personal', 'staff email and name'),
  ('staff_role_grants',                'personal', 'keyed by staff member'),
  ('staff_totp_factors',               'personal', 'sealed secret; key outside the database'),
  ('staff_recovery_codes',             'personal', 'code hashes only'),
  ('staff_audit_log',                  'personal', 'staff actions and client addresses'),
  ('incident_log_entries',             'main',     'public incident log'),
  ('incident_log_versions',            'main',     'public incident log text'),
  ('incident_log_version_contributors', 'personal', 'which staff member wrote a version');

CREATE FUNCTION purge_staff_audit_log(cutoff timestamptz, max_rows integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  purged integer;
BEGIN
  IF cutoff IS NULL OR cutoff > now() THEN
    RAISE EXCEPTION 'staff audit log purge needs a cutoff in the past'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'max_rows must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.staff_audit_log
  WHERE id IN (
    SELECT id FROM public.staff_audit_log
    WHERE at < cutoff
    ORDER BY at
    LIMIT max_rows
  );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

REVOKE ALL ON FUNCTION purge_staff_audit_log(timestamptz, integer) FROM PUBLIC;

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON staff_members, staff_totp_factors TO fire_watch_app;
-- Re-enrolling replaces the whole recovery-code set, and revoking a role deletes its grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_recovery_codes TO fire_watch_app;
GRANT SELECT, INSERT, DELETE ON staff_role_grants TO fire_watch_app;
-- No UPDATE, no DELETE: the audit trail is evidence about staff (T2, T7).
GRANT SELECT, INSERT ON staff_audit_log TO fire_watch_app;
GRANT USAGE ON SEQUENCE staff_audit_log_id_seq TO fire_watch_app;
GRANT EXECUTE ON FUNCTION purge_staff_audit_log(timestamptz, integer) TO fire_watch_app;
GRANT SELECT, INSERT ON incident_log_entries TO fire_watch_app;
GRANT SELECT, INSERT, UPDATE ON incident_log_versions TO fire_watch_app;
-- Contributors only accumulate: an edit adds a name, nothing removes one.
GRANT SELECT, INSERT ON incident_log_version_contributors TO fire_watch_app;

-- migrate:down

DROP FUNCTION IF EXISTS purge_staff_audit_log(timestamptz, integer);
DELETE FROM table_backup_class WHERE table_name IN (
  'staff_members', 'staff_role_grants', 'staff_totp_factors', 'staff_recovery_codes',
  'staff_audit_log', 'incident_log_entries', 'incident_log_versions',
  'incident_log_version_contributors'
);
DROP TABLE IF EXISTS incident_log_version_contributors;
DROP TABLE IF EXISTS incident_log_versions;
DROP FUNCTION IF EXISTS incident_log_versions_freeze_published();
DROP TABLE IF EXISTS incident_log_entries;
DROP TABLE IF EXISTS staff_audit_log;
DROP TABLE IF EXISTS staff_recovery_codes;
DROP TABLE IF EXISTS staff_totp_factors;
DROP TABLE IF EXISTS staff_role_grants;
DROP TABLE IF EXISTS staff_members;
