import { describe, expect, it } from 'vitest';

import { loadConfig, type Environment } from './config.js';
import { wireIngest } from './ingest-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

describe('wireIngest', () => {
  it('produces a complete set of dependencies without reaching anything', async () => {
    const wiring = wireIngest(loadConfig(ENV, 'fire-watch-test'));

    // The cycle takes four ports and silently does less if one is missing — `detectionUid`
    // in particular is easy to forget in a second entrypoint, and its absence would only
    // show up as a crash on the first row of the season.
    expect(typeof wiring.deps.client.fetchArea).toBe('function');
    expect(typeof wiring.deps.detectionUid).toBe('function');
    expect(typeof wiring.deps.store.appendDetections).toBe('function');
    expect(typeof wiring.deps.store.recordPollAttempt).toBe('function');
    expect(typeof wiring.deps.clock.now).toBe('function');

    await wiring.close();
  });

  it('leaves the source list to the cycle, which knows which sources are live', async () => {
    const wiring = wireIngest(loadConfig(ENV, 'fire-watch-test'));

    // Pinning the list here would mean the retired MODIS source could be re-enabled by a
    // wiring edit, far away from the registry that says it is retired.
    expect(wiring.deps.sources).toBeUndefined();

    await wiring.close();
  });
});
