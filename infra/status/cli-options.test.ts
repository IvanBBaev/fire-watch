import { describe, expect, it } from 'vitest';

import { parseCommand, UsageError } from './cli-options.js';

const NO_ENV = {};

describe('parseCommand', () => {
  it('shows help for no command and for help flags', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(parseCommand(argv, NO_ENV)).toEqual({ command: 'help' });
    }
  });

  it('rejects an unknown command and an unknown flag as usage errors', () => {
    expect(() => parseCommand(['deploy'], NO_ENV)).toThrow(UsageError);
    expect(() => parseCommand(['defensive-domains', '--name', 'x', '--bogus'], NO_ENV)).toThrow(
      UsageError,
    );
  });

  describe('probe', () => {
    it('reads targets from the environment, flags winning', () => {
      const command = parseCommand(['probe', '--api-base', 'https://flag.example'], {
        FIRE_WATCH_STATUS_API_BASE: 'https://env.example',
        FIRE_WATCH_STATUS_SNAPSHOT_URL: 'https://env.example/snapshot.json',
        FIRE_WATCH_STATUS_MIRROR_URL: '  ',
      });
      expect(command).toMatchObject({
        command: 'probe',
        apiBase: 'https://flag.example',
        snapshotUrl: 'https://env.example/snapshot.json',
        mirrorUrl: null,
        notices: 'infra/status/notices.json',
        out: 'infra/status/dist/site',
        nowMs: null,
        staleAfterMinutes: 45,
        refreshSeconds: 300,
        timeoutMs: 10_000,
        failOnOutage: false,
      });
    });

    it('parses the optional flags', () => {
      const command = parseCommand(
        [
          'probe',
          '--mirror-url',
          'https://mirror.example/snapshot.json',
          '--now',
          '2026-09-25T12:00:00Z',
          '--stale-after',
          '30',
          '--timeout',
          '5000',
          '--fail-on-outage',
          '--previous',
          'https://status.example/status.json',
        ],
        NO_ENV,
      );
      expect(command).toMatchObject({
        nowMs: Date.parse('2026-09-25T12:00:00Z'),
        staleAfterMinutes: 30,
        timeoutMs: 5000,
        failOnOutage: true,
        previous: 'https://status.example/status.json',
      });
    });

    it.each([
      [['probe']],
      [['probe', '--api-base', 'ftp://x.example']],
      [['probe', '--api-base', 'not a url']],
      [['probe', '--api-base', 'https://x.example', '--now', 'soon']],
      [['probe', '--api-base', 'https://x.example', '--refresh', '0']],
      [['probe', '--api-base', 'https://x.example', '--stale-after', '1.5']],
    ])('rejects %j', (argv) => {
      expect(() => parseCommand(argv, NO_ENV)).toThrow(UsageError);
    });
  });

  describe('email-auth', () => {
    it('parses selectors, defaulting their domain to the checked one', () => {
      const command = parseCommand(
        [
          'email-auth',
          '--domain',
          'Alerts.Example.BG',
          '--dkim',
          's1',
          '--dkim',
          's2@Mail.Example.BG',
          '--strict-alignment',
          '--resolver',
          '1.1.1.1',
        ],
        NO_ENV,
      );
      expect(command).toEqual({
        command: 'email-auth',
        domain: 'alerts.example.bg',
        role: 'sending',
        dkim: [
          { selector: 's1', domain: 'alerts.example.bg' },
          { selector: 's2', domain: 'mail.example.bg' },
        ],
        mailFromDomain: null,
        orgDomain: null,
        strictAlignment: true,
        resolvers: ['1.1.1.1'],
        json: false,
      });
    });

    it.each([
      [['email-auth']],
      [['email-auth', '--domain', 'localhost']],
      [['email-auth', '--domain', 'example.bg', '--role', 'relay']],
      [['email-auth', '--domain', 'example.bg', '--dkim', 'bad selector']],
      [['email-auth', '--domain', 'example.bg', '--mail-from', 'nope']],
    ])('rejects %j', (argv) => {
      expect(() => parseCommand(argv, NO_ENV)).toThrow(UsageError);
    });
  });

  describe('defensive-domains', () => {
    it('defaults the TLDs and the priority cut-off', () => {
      expect(parseCommand(['defensive-domains', '--name', 'firewatch'], NO_ENV)).toEqual({
        command: 'defensive-domains',
        name: 'firewatch',
        tlds: ['bg', 'com', 'eu'],
        priority: 'consider',
        json: false,
      });
    });

    it('rejects a missing name and an unknown priority', () => {
      expect(() => parseCommand(['defensive-domains'], NO_ENV)).toThrow(UsageError);
      expect(() =>
        parseCommand(['defensive-domains', '--name', 'x', '--priority', 'all'], NO_ENV),
      ).toThrow(UsageError);
    });
  });
});
