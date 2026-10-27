/**
 * The signed-in account's synced preferences — `GET|PUT /api/v1/account/preferences`
 * (TASKS V2-C5, cross-device sync).
 *
 * One small JSON document per account, written by the web client and stored verbatim by
 * the server, so that a reader who chose a theme or switched a layer on on one device
 * finds it so on the next. The server validates the shape and the size and never reads a
 * member's meaning; the web client owns what each value does.
 *
 * **What is in it, and what is not.** Only what the web app already keeps in this
 * browser's storage as a reader's standing choice: the opt-in overlays, the static-source
 * and protected-site layers, the theme, the language, the time window and the new-signal
 * sound. What is deliberately device-local stays out — the camera, whether the Layers
 * panel is open, which signals this device has seen, onboarding. The source, region and
 * sensitivity filters are not persisted even locally (a filter re-applied silently on a
 * later visit hides fires the reader no longer knows are filtered out), so they are not
 * synced either.
 *
 * **Every member is optional.** Absent means "never chosen on any synced device", which
 * is different from a chosen default: the merge on the web side needs to tell the two
 * apart.
 *
 * **Versioned.** `schema` names this shape. A member added later gets a new schema name
 * (and the server accepts both) rather than silently changing what v1 means; an unknown
 * member is refused, so the size cap and the list above are the whole contract.
 *
 * **Bounded.** {@link ACCOUNT_PREFERENCES_MAX_BYTES} caps the serialised document. Every
 * string the document can hold is ASCII by construction (enumerations and the token
 * pattern below), so its JSON length is its UTF-8 size.
 */

export const ACCOUNT_PREFERENCES_SCHEMA = 'account_preferences_v1';

/**
 * The cap on `JSON.stringify(document)`. **Not a design number**: a full v1 document is
 * under 300 bytes, and 4 KiB leaves room for later members while keeping a row, a request
 * and an export entry trivially small.
 */
export const ACCOUNT_PREFERENCES_MAX_BYTES = 4096;

export const ACCOUNT_PREFERENCE_THEMES = ['auto', 'light', 'dark'] as const;
export type AccountPreferenceTheme = (typeof ACCOUNT_PREFERENCE_THEMES)[number];

export const ACCOUNT_PREFERENCE_LOCALES = ['bg', 'en'] as const;
export type AccountPreferenceLocale = (typeof ACCOUNT_PREFERENCE_LOCALES)[number];

/** At most this many overlay ids. The web app has six. */
export const ACCOUNT_PREFERENCE_OVERLAYS_MAX = 32;

/**
 * An overlay id or a time-window id: lower-case ASCII letters, digits and hyphens, short.
 * The server does not know the web app's lists, and does not need to — the client drops
 * an id it does not recognise, as it does for a link's `ov=`.
 */
export const ACCOUNT_PREFERENCE_TOKEN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface AccountPreferences {
  /** The opt-in overlays switched on, in any order; no duplicates. */
  readonly overlays?: readonly string[];
  /** The static hot-source layer (F16). */
  readonly static_sources?: boolean;
  /** The protected-sites layer (V2-F1). */
  readonly protected_sites?: boolean;
  readonly theme?: AccountPreferenceTheme;
  readonly locale?: AccountPreferenceLocale;
  /** The list and map time window. */
  readonly age_window?: string;
  /** The audible cue for new signals. */
  readonly new_signal_sound?: boolean;
}

export type AccountPreferenceField = keyof AccountPreferences;

/** Every member of {@link AccountPreferences}, in a fixed order. */
export const ACCOUNT_PREFERENCE_FIELDS: readonly AccountPreferenceField[] = [
  'overlays',
  'static_sources',
  'protected_sites',
  'theme',
  'locale',
  'age_window',
  'new_signal_sound',
];

export interface AccountPreferencesDocument {
  readonly schema: typeof ACCOUNT_PREFERENCES_SCHEMA;
  readonly preferences: AccountPreferences;
}

/**
 * The wire body of a GET and of a PUT's answer: the stored document and its revision.
 * Revision `0` means nothing is stored yet; the document is then empty. The same revision
 * rides in the `ETag` header.
 */
export interface AccountPreferencesState {
  readonly revision: number;
  readonly document: AccountPreferencesDocument;
}

export const EMPTY_ACCOUNT_PREFERENCES: AccountPreferencesDocument = {
  schema: ACCOUNT_PREFERENCES_SCHEMA,
  preferences: {},
};

export type AccountPreferencesIssue =
  'not_object' | 'wrong_schema' | 'unknown_member' | 'invalid_member' | 'too_large';

export type AccountPreferencesParse =
  | { readonly ok: true; readonly document: AccountPreferencesDocument }
  | {
      readonly ok: false;
      readonly issue: AccountPreferencesIssue;
      /** The member at fault, when there is one. */
      readonly member?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_PREFERENCE_TOKEN.test(value);
}

function validMember(field: AccountPreferenceField, value: unknown): boolean {
  switch (field) {
    case 'overlays':
      return (
        Array.isArray(value) &&
        value.length <= ACCOUNT_PREFERENCE_OVERLAYS_MAX &&
        value.every(isToken) &&
        new Set(value).size === value.length
      );
    case 'static_sources':
    case 'protected_sites':
    case 'new_signal_sound':
      return typeof value === 'boolean';
    case 'theme':
      return isOneOf(ACCOUNT_PREFERENCE_THEMES, value);
    case 'locale':
      return isOneOf(ACCOUNT_PREFERENCE_LOCALES, value);
    case 'age_window':
      return isToken(value);
  }
}

/** The serialised size the cap is checked against. */
export function accountPreferencesSize(document: AccountPreferencesDocument): number {
  return JSON.stringify(document).length;
}

/**
 * Validate an untrusted value as a v1 document. Strict: an unknown top-level or
 * preference member, a wrong type, a duplicate overlay or an oversized document is
 * refused, never trimmed — the server stores what it was sent or nothing. The document
 * returned is rebuilt member by member, so it carries no prototype or extra key.
 */
export function parseAccountPreferencesDocument(value: unknown): AccountPreferencesParse {
  if (!isRecord(value)) return { ok: false, issue: 'not_object' };
  for (const key of Object.keys(value)) {
    if (key !== 'schema' && key !== 'preferences') {
      return { ok: false, issue: 'unknown_member', member: key };
    }
  }
  if (value['schema'] !== ACCOUNT_PREFERENCES_SCHEMA) return { ok: false, issue: 'wrong_schema' };
  const raw = value['preferences'];
  if (!isRecord(raw)) return { ok: false, issue: 'invalid_member', member: 'preferences' };

  const known = new Set<string>(ACCOUNT_PREFERENCE_FIELDS);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { ok: false, issue: 'unknown_member', member: key };
  }
  const preferences: Record<string, unknown> = {};
  for (const field of ACCOUNT_PREFERENCE_FIELDS) {
    if (!(field in raw)) continue;
    const member = raw[field];
    if (!validMember(field, member)) return { ok: false, issue: 'invalid_member', member: field };
    preferences[field] = Array.isArray(member) ? [...(member as string[])] : member;
  }
  const document: AccountPreferencesDocument = {
    schema: ACCOUNT_PREFERENCES_SCHEMA,
    preferences,
  };
  if (accountPreferencesSize(document) > ACCOUNT_PREFERENCES_MAX_BYTES) {
    return { ok: false, issue: 'too_large' };
  }
  return { ok: true, document };
}

/**
 * The `ETag` of a revision: a strong validator, the decimal revision quoted. A PUT names
 * the revision it was based on in `If-Match`, `"0"` when it expects nothing stored yet.
 */
export function preferencesEtag(revision: number): string {
  return `"${String(revision)}"`;
}

/** The revision an `If-Match` value names, or `null` for anything but one quoted integer. */
export function parsePreferencesEtag(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*"(0|[1-9][0-9]{0,14})"\s*$/.exec(value);
  if (match === null) return null;
  return Number(match[1]);
}
