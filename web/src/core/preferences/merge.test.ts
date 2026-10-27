import type { AccountPreferences } from '@fire-watch/contracts';
import {
  ACCOUNT_PREFERENCE_FIELDS,
  ACCOUNT_PREFERENCES_SCHEMA,
  parseAccountPreferencesDocument,
} from '@fire-watch/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { changedFields, mergePreferences, samePreferences } from './merge.js';

const preferences: fc.Arbitrary<AccountPreferences> = fc.record(
  {
    overlays: fc.uniqueArray(fc.constantFrom('fwi', 'ba', 'wind', 'swaths', 'lightning'), {
      maxLength: 5,
    }),
    static_sources: fc.boolean(),
    protected_sites: fc.boolean(),
    theme: fc.constantFrom('auto' as const, 'light' as const, 'dark' as const),
    locale: fc.constantFrom('bg' as const, 'en' as const),
    age_window: fc.constantFrom('1h', '6h', '24h', 'all'),
    new_signal_sound: fc.boolean(),
  },
  { requiredKeys: [] },
);
const base = fc.option(preferences, { nil: null });

describe('mergePreferences — examples', () => {
  it('first sync: the account wins where it has a value, this browser fills the rest', () => {
    expect(
      mergePreferences(
        { theme: 'light', age_window: '6h' },
        { theme: 'dark', overlays: ['wind'] },
        null,
      ),
    ).toEqual({ theme: 'dark', overlays: ['wind'], age_window: '6h' });
  });

  it('a field changed here since the last sync keeps the local value', () => {
    expect(mergePreferences({ theme: 'light' }, { theme: 'dark' }, { theme: 'auto' })).toEqual({
      theme: 'light',
    });
  });

  it('a field unchanged here takes the other device`s newer value', () => {
    expect(mergePreferences({ theme: 'auto' }, { theme: 'dark' }, { theme: 'auto' })).toEqual({
      theme: 'dark',
    });
  });

  it('two devices changing different fields both keep their change', () => {
    const last = { theme: 'auto' as const, new_signal_sound: false };
    expect(
      mergePreferences(
        { theme: 'dark', new_signal_sound: false },
        { theme: 'auto', new_signal_sound: true },
        last,
      ),
    ).toEqual({ theme: 'dark', new_signal_sound: true });
  });

  it('a choice made here for the first time since the last sync survives', () => {
    expect(mergePreferences({ static_sources: true }, {}, {})).toEqual({ static_sources: true });
  });

  it('compares overlays as sets', () => {
    expect(
      mergePreferences(
        { overlays: ['ba', 'fwi'] },
        { overlays: ['wind'] },
        { overlays: ['fwi', 'ba'] },
      ),
    ).toEqual({ overlays: ['wind'] });
  });

  it('copies arrays rather than sharing them', () => {
    const remote = { overlays: ['wind'] };
    const merged = mergePreferences({}, remote, null);
    expect(merged.overlays).not.toBe(remote.overlays);
  });
});

describe('mergePreferences — properties', () => {
  it('every merged value comes from local or remote, and nothing absent from both appears', () => {
    fc.assert(
      fc.property(preferences, preferences, base, (local, remote, last) => {
        const merged = mergePreferences(local, remote, last);
        for (const field of ACCOUNT_PREFERENCE_FIELDS) {
          const value = merged[field];
          if (value === undefined) {
            expect(local[field] ?? remote[field]).toBeUndefined();
          } else {
            expect(
              samePreferences({ [field]: value }, { [field]: local[field] }) ||
                samePreferences({ [field]: value }, { [field]: remote[field] }),
            ).toBe(true);
          }
        }
      }),
    );
  });

  it('agreeing copies merge to themselves, whatever the base', () => {
    fc.assert(
      fc.property(preferences, base, (both, last) => {
        expect(samePreferences(mergePreferences(both, both, last), both)).toBe(true);
      }),
    );
  });

  it('nothing changed here since the last sync: the account copy wins where it has values', () => {
    fc.assert(
      fc.property(preferences, preferences, (local, remote) => {
        const merged = mergePreferences(local, remote, local);
        for (const field of ACCOUNT_PREFERENCE_FIELDS) {
          if (remote[field] !== undefined) {
            expect(samePreferences({ [field]: merged[field] }, { [field]: remote[field] })).toBe(
              true,
            );
          }
        }
      }),
    );
  });

  it('nothing changed elsewhere since the last sync: this browser`s copy is kept whole', () => {
    fc.assert(
      fc.property(preferences, preferences, (local, last) => {
        // The server still holds what this browser last agreed on.
        expect(samePreferences(mergePreferences(local, last, last), { ...last, ...local })).toBe(
          true,
        );
      }),
    );
  });

  it('is stable: merging the result again changes nothing', () => {
    fc.assert(
      fc.property(preferences, preferences, base, (local, remote, last) => {
        const merged = mergePreferences(local, remote, last);
        expect(samePreferences(mergePreferences(merged, merged, merged), merged)).toBe(true);
        // After a sync the base is the merge, so a later sync with no local change is the
        // remote laid over it.
        expect(
          samePreferences(mergePreferences(merged, remote, merged), { ...merged, ...remote }),
        ).toBe(true);
      }),
    );
  });

  it('always yields a document the server accepts', () => {
    fc.assert(
      fc.property(preferences, preferences, base, (local, remote, last) => {
        const parsed = parseAccountPreferencesDocument({
          schema: ACCOUNT_PREFERENCES_SCHEMA,
          preferences: mergePreferences(local, remote, last),
        });
        expect(parsed.ok).toBe(true);
      }),
    );
  });
});

describe('mergePreferences — absent local values', () => {
  it('never drops a value the account holds because this browser lacks it', () => {
    expect(mergePreferences({}, { new_signal_sound: false }, { new_signal_sound: false })).toEqual({
      new_signal_sound: false,
    });
  });
});

describe('changedFields', () => {
  it('lists the fields that differ, overlays as sets', () => {
    expect(
      changedFields(
        { theme: 'dark', overlays: ['wind', 'fwi'] },
        { theme: 'light', overlays: ['fwi', 'wind'], locale: 'en' },
      ),
    ).toEqual(['theme', 'locale']);
  });
});
