import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODES, main } from './cli.js';

describe('cli main', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the scenario and exits 0 on --dry-run, without touching the network', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const code = await main([
      'run',
      '--base-url',
      'https://edge.example',
      '--t2-url',
      'https://t2.example',
      '--dry-run',
    ]);
    expect(code).toBe(0);
    const scenario = JSON.parse(out.join('')) as { totals: { sseConnections: number } };
    expect(scenario.totals.sseConnections).toBe(25_000);
  });

  it('exits 2 on a usage error', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['run'])).toBe(2);
  });

  it('maps verdicts to distinct exit codes, never 0 for an unfinished run', () => {
    expect(EXIT_CODES).toEqual({ pass: 0, fail: 1, invalid: 3, incomplete: 3 });
  });
});
