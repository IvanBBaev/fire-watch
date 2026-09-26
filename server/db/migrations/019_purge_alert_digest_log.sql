-- Migration 019 — a watermark-preserving retention purge for the digest log (TASKS I4,
-- H3/D9; migration 018's open item; 2026-09-26).
--
-- `alert_digest_log` (018) is both a decision record and the digest watermark: an
-- account's last given window is the newest `send`/`suppress` window over every zone it
-- has ever had, dated by the earliest `decided_at` logged for that window
-- (`adapters/db/pg-alert-digest-store.ts`). A plain age cutoff — the shape of
-- `purge_alert_decision_log` (014) — would delete that row once it aged past the
-- retention, the watermark would reset to "never", and the pass would owe the account
-- yesterday's window again. So 018 left the table out of the purge.
--
-- This function deletes a row only when **both** hold:
--
--   - its `decided_at` is before the cutoff (the retention), and
--   - its `window_start` is strictly before its account's newest spent window.
--
-- Every row of the newest spent window is kept whatever its age (so both halves of the
-- watermark — the window and its earliest `decided_at` — read back unchanged), and so is
-- every row of a later window (a `hold` on a window not yet spent). An account with no
-- spent window at all keeps everything: the comparison with NULL is never true.
--
-- The account is reached through `watch_zones.account_id`, soft-deleted zones included,
-- exactly as the watermark read reaches it. A concurrent digest pass can only *add* a
-- newer spent window, which moves the protected window forward and never backward, so a
-- purge racing a pass can never delete a row the pass reads back.
--
-- SECURITY DEFINER because the runtime role has no DELETE on the table (018: the log is
-- evidence and the watermark). The guards are 014's: a cutoff in the past, a positive
-- row cap. The retention itself is unarmed in `core/erasure/purge-plan.ts` until ratified.

-- migrate:up

CREATE FUNCTION purge_alert_digest_log(cutoff timestamptz, max_rows integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  purged integer;
BEGIN
  IF cutoff IS NULL OR cutoff > now() THEN
    RAISE EXCEPTION 'alert digest log purge needs a cutoff in the past'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'max_rows must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.alert_digest_log
  WHERE id IN (
    SELECT l.id
    FROM public.alert_digest_log l
    JOIN public.watch_zones z ON z.id = l.watch_zone_id
    WHERE l.decided_at < cutoff
      AND l.window_start < (
        SELECT max(s.window_start)
        FROM public.alert_digest_log s
        JOIN public.watch_zones sz ON sz.id = s.watch_zone_id
        WHERE sz.account_id = z.account_id
          AND s.outcome IN ('send', 'suppress')
      )
    ORDER BY l.decided_at
    LIMIT max_rows
  );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

REVOKE ALL ON FUNCTION purge_alert_digest_log(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_alert_digest_log(timestamptz, integer) TO fire_watch_app;

-- migrate:down

DROP FUNCTION IF EXISTS purge_alert_digest_log(timestamptz, integer);
