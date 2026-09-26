import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  artifactFileName,
  backupObjectKey,
  backupTimestamp,
  companionKey,
  parseBackupObjectKey,
  parseBackupTimestamp,
  tierPrefix,
} from './backup-keys.js';

const AT = epochMsFromIso('2026-09-23T02:20:00Z');

describe('backupTimestamp', () => {
  it('formats UTC as the shell job did, dropping milliseconds', () => {
    expect(backupTimestamp(AT)).toBe('20260923T022000Z');
    expect(backupTimestamp(AT + 999)).toBe('20260923T022000Z');
  });

  it('refuses a non-finite instant', () => {
    expect(() => backupTimestamp(Number.NaN)).toThrow(RangeError);
    expect(() => backupTimestamp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('parseBackupTimestamp', () => {
  it('round-trips', () => {
    expect(parseBackupTimestamp('20260923T022000Z')).toBe(AT);
  });

  it('refuses dates Date.UTC would roll over, and malformed text', () => {
    expect(parseBackupTimestamp('20260231T000000Z')).toBeNull();
    expect(parseBackupTimestamp('20260923T246000Z')).toBeNull();
    expect(parseBackupTimestamp('2026-09-23T02:20:00Z')).toBeNull();
    expect(parseBackupTimestamp('20260923T022000')).toBeNull();
    expect(parseBackupTimestamp('')).toBeNull();
  });
});

describe('backupObjectKey', () => {
  it('lays out prefix, tier, date path and file name per OPERATIONS §6.2', () => {
    expect(backupObjectKey('main', 'daily', AT).key).toBe(
      'fw-main/daily/2026/09/23/fire-watch-main-20260923T022000Z.dump.age',
    );
    expect(backupObjectKey('personal', 'daily', AT).key).toBe(
      'fw-personal/daily/2026/09/23/fire-watch-personal-20260923T022000Z.dump.age',
    );
    expect(backupObjectKey('main', 'weekly', AT).key).toBe(
      'fw-main/weekly/2026/09/23/fire-watch-main-20260923T022000Z.dump.age',
    );
  });

  it('truncates the instant to the second it names', () => {
    const key = backupObjectKey('main', 'daily', AT + 750);
    expect(key.takenAtMs).toBe(AT);
  });

  it('agrees with artifactFileName', () => {
    const key = backupObjectKey('personal', 'daily', AT);
    expect(key.key.endsWith(`/${artifactFileName('personal', AT)}`)).toBe(true);
  });
});

describe('parseBackupObjectKey', () => {
  it('is the inverse of backupObjectKey', () => {
    for (const set of ['main', 'personal'] as const) {
      for (const tier of ['daily', 'weekly', 'monthly'] as const) {
        const key = backupObjectKey(set, tier, AT);
        expect(parseBackupObjectKey(key.key)).toEqual(key);
      }
    }
  });

  it('refuses keys whose halves disagree', () => {
    // Set prefix and file-name set differ.
    expect(
      parseBackupObjectKey(
        'fw-main/daily/2026/09/23/fire-watch-personal-20260923T022000Z.dump.age',
      ),
    ).toBeNull();
    // Date path and timestamp differ.
    expect(
      parseBackupObjectKey('fw-main/daily/2026/09/22/fire-watch-main-20260923T022000Z.dump.age'),
    ).toBeNull();
    // Impossible timestamp.
    expect(
      parseBackupObjectKey('fw-main/daily/2026/02/31/fire-watch-main-20260231T022000Z.dump.age'),
    ).toBeNull();
  });

  it('refuses foreign keys', () => {
    expect(parseBackupObjectKey('fw-main/daily/2026/09/23/notes.txt')).toBeNull();
    expect(
      parseBackupObjectKey('fw-main/hourly/2026/09/23/fire-watch-main-20260923T022000Z.dump.age'),
    ).toBeNull();
    expect(
      parseBackupObjectKey('fw-main/daily/2026/09/23/fire-watch-main-20260923T022000Z.dump'),
    ).toBeNull();
    expect(
      parseBackupObjectKey('x/fw-main/daily/2026/09/23/fire-watch-main-20260923T022000Z.dump.age'),
    ).toBeNull();
  });
});

describe('companionKey and tierPrefix', () => {
  it('pairs the two sets of one night by timestamp and tier', () => {
    const main = backupObjectKey('main', 'daily', AT);
    expect(companionKey(main, 'personal')).toEqual(backupObjectKey('personal', 'daily', AT));
    expect(companionKey(main, 'main')).toEqual(main);
  });

  it('ends a tier prefix with the slash a lifecycle rule needs', () => {
    expect(tierPrefix('main', 'weekly')).toBe('fw-main/weekly/');
    expect(tierPrefix('personal', 'daily')).toBe('fw-personal/daily/');
    expect(
      backupObjectKey('personal', 'daily', AT).key.startsWith(tierPrefix('personal', 'daily')),
    ).toBe(true);
  });
});
