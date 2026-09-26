/**
 * S14 through the templates: every alert the fixture decides to send, rendered in
 * Europe/Sofia across both 2026/27 transitions (25 Oct 2026, 28 Mar 2027).
 *
 * The replay suite already proves the *decisions* (quiet hours from the tz database, one
 * 09:00 digest per window). This proves the *words*: the `HH:MM` a recipient reads is the
 * local wall-clock time of the instant — including the repeated 03:30 on 25 Oct, which
 * renders `03:30` twice because the frozen §3 string carries no offset — every digest
 * title reads 09:00 local whatever the UTC hour, and every rendered alert passes CI-10.
 *
 * The fixture carries decisions, not template parameters (nothing binds them yet —
 * `routing.copyFor` is unarmed), so the parameters here are synthetic apart from the
 * instants, which come from the fixture.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lintAlert } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { fillCopy } from '../../../core/alerts/templates/alert-copy.js';
import {
  lintContextFor,
  renderAlertTemplate,
} from '../../../core/alerts/templates/alert-templates.js';
import type { AlertChannel } from '../../../core/ports/alert-outbox-store.js';

interface FixtureAlert {
  readonly zoneId: string;
  readonly publicId: string;
  readonly outcome: 'send' | 'defer' | 'suppress';
  readonly alertType: 'new_fire' | 'escalation' | 'digest';
  readonly alertSubkey: string;
  readonly atIso: string;
}

const expected = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../fixtures/S14/expected.json', import.meta.url)),
    'utf8',
  ),
) as { readonly alerts: readonly FixtureAlert[] };

const TIME_ZONE = 'Europe/Sofia';
const CHANNELS: readonly AlertChannel[] = ['push', 'telegram', 'email'];
const LOCALES = ['bg', 'en'] as const;

const sends = expected.alerts.filter((alert) => alert.outcome === 'send');
const newFires = sends.filter((alert) => alert.alertType === 'new_fire');

/** One digest per zone and window, listing the events the fixture folded into it. */
const digests: FixtureAlert[][] = [];
for (const alert of sends.filter((send) => send.alertType === 'digest')) {
  const group = digests.find(
    (open) => open[0]?.zoneId === alert.zoneId && open[0]?.alertSubkey === alert.alertSubkey,
  );
  if (group === undefined) digests.push([alert]);
  else group.push(alert);
}

/** The local wall-clock time of every new-fire send, in fixture order. */
const EXPECTED_LOCAL_TIMES = [
  '03:30', // 2026-10-24T00:30Z, EEST
  '03:30', // 2026-10-25T00:30Z — first 03:30, still EEST
  '03:30', // 2026-10-25T01:30Z — the repeated 03:30, now EET
  '06:00', // 2026-10-25T04:00Z
  '07:00', // 2026-10-25T05:00Z, zone a
  '07:00', // 2026-10-25T05:00Z, zone b
  '03:30', // 2027-03-27T01:30Z, EET
  '02:30', // 2027-03-28T00:30Z — before the skipped hour
  '04:30', // 2027-03-28T01:30Z — after it; 03:xx never exists that night
  '07:00', // 2027-03-28T04:00Z, zone a
  '07:00', // 2027-03-28T04:00Z, zone b
];

function place(publicId: string): { bg: string; en: string } {
  return { bg: `Малко Търново (${publicId})`, en: `Malko Tarnovo (${publicId})` };
}

function newFireParams(alert: FixtureAlert): Record<string, unknown> {
  return {
    eventUrl: `https://firewatch.example/e/${alert.publicId}`,
    placeName: place(alert.publicId),
    distanceKm: 6.2,
    zoneLabel: alert.zoneId,
    observedAt: alert.atIso,
    scoreBucket: 'likely',
    burnedAreaHa: null,
    areaSource: null,
    agriBurn: false,
  };
}

function digestParams(group: readonly FixtureAlert[]): Record<string, unknown> {
  return {
    windowStart: group[0]?.alertSubkey,
    zoneLabel: group[0]?.zoneId ?? null,
    entries: group.map((alert) => {
      const { zoneLabel: _zone, ...entry } = newFireParams(alert);
      return entry;
    }),
  };
}

describe('S14 rendered in Europe/Sofia', () => {
  it('has the sends the fixture decides', () => {
    expect(newFires.map((alert) => alert.atIso)).toHaveLength(EXPECTED_LOCAL_TIMES.length);
    expect(digests).toHaveLength(8);
  });

  it.each(LOCALES)('new_fire shows the local detection time (%s)', (locale) => {
    const times = newFires.map((alert) => {
      const rendered = renderAlertTemplate({
        templateId: 'new_fire.v1',
        templateParams: newFireParams(alert),
        channel: 'push',
        locale,
        timeZone: TIME_ZONE,
      });
      const activeLine = rendered.body
        .split('\n')
        .find((line) => line.startsWith(fillCopy('frozen.active', locale, { time: '' })));
      return activeLine?.slice(-5);
    });
    expect(times).toEqual(EXPECTED_LOCAL_TIMES);
  });

  it.each(LOCALES)('every digest is titled 09:00 local (%s)', (locale) => {
    for (const group of digests) {
      const rendered = renderAlertTemplate({
        templateId: 'digest.v1',
        templateParams: digestParams(group),
        channel: 'email',
        locale,
        timeZone: TIME_ZONE,
      });
      expect(rendered.title, group[0]?.alertSubkey).toMatch(/, 09:00$/u);
    }
  });

  const cases = CHANNELS.flatMap((channel) => LOCALES.map((locale) => [channel, locale] as const));

  it.each(cases)('every send renders clean on %s in %s', (channel, locale) => {
    const requests = [
      ...newFires.map((alert) => ({
        templateId: 'new_fire.v1',
        templateParams: newFireParams(alert),
      })),
      ...digests.map((group) => ({ templateId: 'digest.v1', templateParams: digestParams(group) })),
    ];
    for (const { templateId, templateParams } of requests) {
      const rendered = renderAlertTemplate({
        templateId,
        templateParams,
        channel,
        locale,
        timeZone: TIME_ZONE,
      });
      expect(lintAlert(rendered, lintContextFor(templateId, templateParams))).toEqual([]);
    }
  });
});
