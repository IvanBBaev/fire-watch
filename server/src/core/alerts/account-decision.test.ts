import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { decideForAccount, type AccountZoneInput } from './account-decision.js';
import { NOTHING_NOTIFIED, type AlertZone, type AlertableEvent } from './alert-decision.js';

const NOON = epochMsFromIso('2026-08-14T12:00:00Z');
const MINUTE = 60_000;

const EVENT: AlertableEvent = {
  publicId: 'fw-2026-a1b2c',
  score: 0.8,
  detectionCount: 3,
  nightHighConfidenceCount: 0,
  geoOnly: false,
  invalidated: false,
  quarantined: false,
  status: 'active',
  statusBefore: null,
  relationKind: null,
  burnedAreaHa: null,
  startedAt: NOON - 60 * MINUTE,
  lastDetectionAt: NOON - 5 * MINUTE,
};

function zone(zoneId: string, distanceKm: number): AlertZone {
  return {
    zoneId,
    minScore: 0.45,
    timezone: 'Europe/Sofia',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    newFireOverridesQuietHours: true,
    distanceKm,
  };
}

function input(z: AlertZone, overrides: Partial<AccountZoneInput> = {}): AccountZoneInput {
  return {
    zone: z,
    state: null,
    lastNotified: NOTHING_NOTIFIED,
    zoneLastNotifiedAt: null,
    zoneCreation: false,
    ...overrides,
  };
}

describe('decideForAccount', () => {
  it('decides nothing for no zones', () => {
    expect(decideForAccount(EVENT, [], NOON)).toEqual([]);
  });

  it('sends a new fire for a single containing zone', () => {
    const [only] = decideForAccount(EVENT, [input(zone('zone-a', 3))], NOON);
    expect(only?.decision.outcome).toBe('send');
    expect(only?.decision.reason).toBe('first_alert');
    expect(only?.decision.nextState?.state).toBe('notified_new');
  });

  it('keeps only the nearest zone’s send (A1.12), preserving input order', () => {
    const decisions = decideForAccount(
      EVENT,
      [input(zone('zone-far', 8)), input(zone('zone-near', 2))],
      NOON,
    );
    expect(decisions.map((d) => d.zone.zoneId)).toEqual(['zone-far', 'zone-near']);
    expect(decisions.map((d) => d.decision.outcome)).toEqual(['suppress', 'send']);
    expect(decisions[0]?.decision.reason).toBe('nearer_zone');
  });

  it('seeds instead of sending inside the zone-creation evaluation', () => {
    const [only] = decideForAccount(
      EVENT,
      [input(zone('zone-a', 3), { zoneCreation: true })],
      NOON,
    );
    expect(only?.decision.outcome).toBe('seed');
  });
});
