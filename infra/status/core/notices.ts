/**
 * Founder-written notices: incidents, planned maintenance, postmortem links (OPERATIONS
 * §10.3–§10.4).
 *
 * The probe can say *that* something is wrong; only a person can say what, and §10.4
 * makes the founder the one who writes it. Rather than a hosted editor, the notices live
 * in `infra/status/notices.json` in the repository, so every sentence the status page
 * publishes in a human voice arrives through a reviewed pull request and is linted against
 * the never-send list by `notices.test.ts` — the same list the alert templates obey. An
 * urgent notice during an incident is a one-file commit on `main`; the next probe run
 * publishes it.
 *
 * This module only validates. Shape errors are collected, not thrown on the first one, so
 * a founder editing under pressure sees every mistake in one run.
 */

export const NOTICE_KINDS = ['incident', 'maintenance'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export interface Notice {
  /** Stable, unique, lower-case slug — e.g. `2026-10-02-map-delay`. */
  readonly id: string;
  readonly kind: NoticeKind;
  /** ISO-8601 with an explicit offset: the incident start or the maintenance start. */
  readonly startedAt: string;
  /** ISO-8601, or `null` while it is ongoing. */
  readonly resolvedAt: string | null;
  readonly en: string;
  readonly bg: string;
  /** Optional postmortem link (§10.3: "postmortems (§8.5)"); `https:` only. */
  readonly postmortemUrl: string | null;
}

export type NoticesResult =
  | { readonly ok: true; readonly notices: readonly Notice[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Resolved notices older than this (relative to the page's own time) drop off the page. */
export const RESOLVED_NOTICE_WINDOW_DAYS = 14;

/** Long enough for two short paragraphs; short enough that nobody pastes a log in here. */
export const NOTICE_TEXT_MAX_LENGTH = 600;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// An explicit offset is required: a bare local time would be read as UTC by one reader and
// as Sofia time by the founder who wrote it.
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' && INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function checkText(where: string, value: unknown, errors: string[]): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${where}: must be a non-empty string`);
    return false;
  }
  if (value.length > NOTICE_TEXT_MAX_LENGTH) {
    errors.push(`${where}: longer than ${String(NOTICE_TEXT_MAX_LENGTH)} characters`);
    return false;
  }
  if (/[<>]/.test(value)) {
    // The renderer escapes everything anyway; this catches someone expecting markup to work.
    errors.push(`${where}: plain text only — no markup`);
    return false;
  }
  return true;
}

export function parseNotices(value: unknown): NoticesResult {
  const errors: string[] = [];
  if (!isRecord(value) || !Array.isArray(value['notices'])) {
    return { ok: false, errors: ['root: expected { "notices": [ ... ] }'] };
  }
  const notices: Notice[] = [];
  const seen = new Set<string>();
  (value['notices'] as unknown[]).forEach((raw, index) => {
    const at = `notices[${String(index)}]`;
    if (!isRecord(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const before = errors.length;
    const { id, kind, startedAt, resolvedAt, en, bg, postmortemUrl } = raw;
    const known = new Set(['id', 'kind', 'startedAt', 'resolvedAt', 'en', 'bg', 'postmortemUrl']);
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) errors.push(`${at}: unknown field "${key}"`);
    }
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(`${at}.id: lower-case slug of letters, digits and hyphens`);
    } else if (seen.has(id)) {
      errors.push(`${at}.id: duplicate "${id}"`);
    } else {
      seen.add(id);
    }
    if (typeof kind !== 'string' || !(NOTICE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${at}.kind: one of ${NOTICE_KINDS.join(', ')}`);
    }
    if (!isInstant(startedAt)) {
      errors.push(`${at}.startedAt: ISO-8601 with an offset, e.g. 2026-10-02T14:05:00Z`);
    }
    const resolved = resolvedAt ?? null;
    if (resolved !== null && !isInstant(resolved)) {
      errors.push(`${at}.resolvedAt: null or ISO-8601 with an offset`);
    } else if (
      resolved !== null &&
      isInstant(startedAt) &&
      Date.parse(resolved) < Date.parse(startedAt)
    ) {
      errors.push(`${at}.resolvedAt: earlier than startedAt`);
    }
    checkText(`${at}.en`, en, errors);
    checkText(`${at}.bg`, bg, errors);
    const postmortem = postmortemUrl ?? null;
    if (postmortem !== null && (typeof postmortem !== 'string' || !isHttpsUrl(postmortem))) {
      errors.push(`${at}.postmortemUrl: null or an https: URL`);
    }
    if (errors.length === before) {
      notices.push({
        id: id as string,
        kind: kind as NoticeKind,
        startedAt: startedAt as string,
        resolvedAt: resolved as string | null,
        en: en as string,
        bg: bg as string,
        postmortemUrl: postmortem as string | null,
      });
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, notices };
}

/**
 * What the page shows: every ongoing notice, plus resolved ones inside the window, newest
 * first. Maintenance announced for the future is ongoing by this definition — which is
 * what an announcement is for.
 */
export function visibleNotices(notices: readonly Notice[], nowMs: number): readonly Notice[] {
  const windowMs = RESOLVED_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return notices
    .filter((n) => n.resolvedAt === null || nowMs - Date.parse(n.resolvedAt) <= windowMs)
    .slice()
    .sort((a, b) => {
      const ongoing = Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null);
      return ongoing !== 0 ? ongoing : Date.parse(b.startedAt) - Date.parse(a.startedAt);
    });
}
