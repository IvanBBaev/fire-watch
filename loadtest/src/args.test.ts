import { describe, expect, it } from 'vitest';

import { UsageError, parseArgs } from './args.js';

describe('parseArgs', () => {
  it('defaults to the gate configuration', () => {
    const args = parseArgs([
      'run',
      '--base-url',
      'https://edge.example/',
      '--t2-url',
      'https://t2.example',
    ]);
    expect(args).toMatchObject({
      command: 'run',
      baseUrl: 'https://edge.example',
      multiplier: 50,
      scale: 1,
      sseCap: 5_000,
      shard: { index: 1, count: 1 },
      durationsMs: { ramp: 120_000, steady: 600_000, originKill: 300_000 },
      cacheStatusHeader: 'cf-cache-status',
      dryRun: false,
    });
  });

  it('reads every flag', () => {
    const args = parseArgs([
      'run',
      '--base-url',
      'http://127.0.0.1:8080',
      '--origin-kill-s',
      '0',
      '--scale',
      '0.01',
      '--shard',
      '2/4',
      '--steady-s',
      '30',
      '--cache-status-header',
      'X-Cache',
      '--seed',
      '7',
      '--out',
      'r.json',
      '--dry-run',
    ]);
    expect(args).toMatchObject({
      t2Url: null,
      scale: 0.01,
      shard: { index: 2, count: 4 },
      durationsMs: { steady: 30_000, originKill: 0 },
      cacheStatusHeader: 'x-cache',
      seed: 7,
      out: 'r.json',
      dryRun: true,
    });
  });

  it.each([
    [[], /missing command/],
    [['bench'], /unknown command/],
    [['run'], /--base-url is required/],
    [['run', '--base-url', 'https://e.x'], /needs --t2-url/],
    [['run', '--base-url', 'ftp://e.x', '--origin-kill-s', '0'], /http/],
    [['run', '--base-url', 'https://e.x', '--origin-kill-s', '0', '--scale', '0'], /positive/],
    [['run', '--base-url', 'https://e.x', '--origin-kill-s', '0', '--shard', '3/2'], /--shard/],
    [['run', '--base-url', 'https://e.x', '--origin-kill-s', '0', '--sse-cap', '1.5'], /integer/],
    [['run', '--base-url', 'https://e.x', '--base-url', 'https://f.x'], /twice/],
    [['run', '--base-url', '--dry-run'], /needs a value/],
    [['run', '--bogus'], /unknown flag/],
    [['merge'], /at least one/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('parses merge', () => {
    expect(parseArgs(['merge', 'a.json', 'b.json', '--out', 'all.json'])).toEqual({
      command: 'merge',
      inputs: ['a.json', 'b.json'],
      out: 'all.json',
    });
  });
});
