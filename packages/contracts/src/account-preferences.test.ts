import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_PREFERENCES_MAX_BYTES,
  ACCOUNT_PREFERENCES_SCHEMA,
  ACCOUNT_PREFERENCE_FIELDS,
  ACCOUNT_PREFERENCE_OVERLAYS_MAX,
  EMPTY_ACCOUNT_PREFERENCES,
  accountPreferencesSize,
  parseAccountPreferencesDocument,
  parsePreferencesEtag,
  preferencesEtag,
} from './account-preferences.js';

const FULL = {
  schema: ACCOUNT_PREFERENCES_SCHEMA,
  preferences: {
    overlays: ['fwi', 'wind', 'lightning'],
    static_sources: true,
    protected_sites: false,
    theme: 'dark',
    locale: 'en',
    age_window: '6h',
    new_signal_sound: true,
  },
};

describe('parseAccountPreferencesDocument', () => {
  it('accepts a full v1 document and the empty one', () => {
    expect(parseAccountPreferencesDocument(FULL)).toEqual({ ok: true, document: FULL });
    expect(parseAccountPreferencesDocument(EMPTY_ACCOUNT_PREFERENCES)).toEqual({
      ok: true,
      document: EMPTY_ACCOUNT_PREFERENCES,
    });
  });

  it('keeps a full document far below the cap', () => {
    expect(accountPreferencesSize(FULL as never)).toBeLessThan(300);
  });

  it('lists every member once', () => {
    expect(new Set(ACCOUNT_PREFERENCE_FIELDS).size).toBe(ACCOUNT_PREFERENCE_FIELDS.length);
    expect([...ACCOUNT_PREFERENCE_FIELDS].sort()).toEqual(Object.keys(FULL.preferences).sort());
  });

  it.each([
    ['null', null, 'not_object'],
    ['an array', [], 'not_object'],
    ['a string', 'x', 'not_object'],
    ['no schema', { preferences: {} }, 'wrong_schema'],
    ['another schema', { schema: 'account_preferences_v2', preferences: {} }, 'wrong_schema'],
    ['no preferences', { schema: ACCOUNT_PREFERENCES_SCHEMA }, 'invalid_member'],
    ['an extra top-level member', { ...FULL, extra: 1 }, 'unknown_member'],
  ])('refuses %s', (_label, value, issue) => {
    const parsed = parseAccountPreferencesDocument(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issue).toBe(issue);
  });

  it.each([
    ['overlays', 'fwi'],
    ['overlays', ['FWI']],
    ['overlays', ['fwi', 'fwi']],
    ['overlays', [1]],
    ['overlays', Array.from({ length: ACCOUNT_PREFERENCE_OVERLAYS_MAX + 1 }, (_, i) => `o${i}`)],
    ['static_sources', 'on'],
    ['protected_sites', 1],
    ['theme', 'sepia'],
    ['locale', 'de'],
    ['age_window', 'a'.repeat(33)],
    ['age_window', '6 h'],
    ['new_signal_sound', null],
  ])('refuses %s = %j', (member, value) => {
    const parsed = parseAccountPreferencesDocument({
      schema: ACCOUNT_PREFERENCES_SCHEMA,
      preferences: { [member]: value },
    });
    expect(parsed).toEqual({ ok: false, issue: 'invalid_member', member });
  });

  it('refuses an unknown preference rather than dropping it', () => {
    expect(
      parseAccountPreferencesDocument({
        schema: ACCOUNT_PREFERENCES_SCHEMA,
        preferences: { camera: [25, 42, 7] },
      }),
    ).toEqual({ ok: false, issue: 'unknown_member', member: 'camera' });
  });

  it('rebuilds the document, so no foreign key or shared array survives', () => {
    const overlays = ['fwi'];
    const parsed = parseAccountPreferencesDocument({
      schema: ACCOUNT_PREFERENCES_SCHEMA,
      preferences: { overlays },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.preferences.overlays).toEqual(['fwi']);
      expect(parsed.document.preferences.overlays).not.toBe(overlays);
    }
  });

  it('holds the cap as a number the size check reads', () => {
    expect(ACCOUNT_PREFERENCES_MAX_BYTES).toBe(4096);
  });
});

describe('the revision validator', () => {
  it('round-trips', () => {
    for (const revision of [0, 1, 42, 999_999_999]) {
      expect(parsePreferencesEtag(preferencesEtag(revision))).toBe(revision);
    }
  });

  it.each([undefined, '', '*', '3', 'W/"3"', '"-1"', '"01"', '"1.5"', '"3", "4"'])(
    'reads %j as no revision',
    (value) => {
      expect(parsePreferencesEtag(value)).toBeNull();
    },
  );
});
