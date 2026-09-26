import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertDeterministic } from '../../core/replay/double-run.js';
import { EMPTY_OBSERVATIONS } from '../../core/replay/fixture-format.js';
import { diffAgainstExpected, runReplay, serializeReport } from '../../core/replay/runner.js';
import { createSmokeEngine } from '../../core/replay/smoke-engine.js';
import { MANIFEST_FILE, listFixtureDirectories, loadFixture } from './fixture-loader.js';

const FIXTURES_ROOT = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const SMOKE = join(FIXTURES_ROOT, 'harness-smoke');

const temporaries: string[] = [];

/** A throwaway copy of a fixture, so the tamper tests never edit the checked-in one. */
function copyOf(source: string): string {
  const directory = join(mkdtempSync(join(tmpdir(), 'fw-fixture-')), basename(source));
  cpSync(source, directory, { recursive: true });
  temporaries.push(directory);
  return directory;
}

function rewrite<T>(directory: string, file: string, edit: (json: T) => unknown): void {
  const path = join(directory, file);
  const json = JSON.parse(readFileSync(path, 'utf8')) as T;
  writeFileSync(path, JSON.stringify(edit(json)), 'utf8');
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('listFixtureDirectories', () => {
  it('finds the checked-in fixtures in a stable order', () => {
    const directories = listFixtureDirectories(FIXTURES_ROOT);

    expect(directories).toContain(SMOKE);
    expect(directories).toEqual([...directories].sort());
  });

  it('loads every fixture in the register', () => {
    // The register grows one directory at a time; this is what notices a broken addition
    // before that fixture's own suite exists.
    for (const directory of listFixtureDirectories(FIXTURES_ROOT)) {
      expect(() => loadFixture(directory)).not.toThrow();
    }
  });
});

describe('loadFixture', () => {
  it('reads the manifest, the polls and the expectations', () => {
    const fixture = loadFixture(SMOKE);

    expect(fixture.manifest.id).toBe('harness-smoke');
    expect(fixture.manifest.required).toBe('pre-merge');
    expect(fixture.manifest.mode).toBe('live');
    expect(fixture.batches.map((batch) => batch.name)).toEqual(['poll-01.json', 'poll-02.json']);
    expect(fixture.batches[0]?.detections).toHaveLength(3);
    expect(fixture.batches[1]?.detections).toHaveLength(2);
  });

  it('rejects a detection whose id no longer describes its own fields', () => {
    // The failure this exists for: someone nudges a coordinate to move a detection across
    // a cluster boundary and does not recompute the id.
    const directory = copyOf(SMOKE);
    rewrite<{ detections: { latCanonical: string }[] }>(directory, 'poll-01.json', (batch) => {
      const first = batch.detections[0];
      if (first) first.latCanonical = '41.99999';
      return batch;
    });

    expect(() => loadFixture(directory)).toThrow(/detection_uid does not match its own fields/);
    expect(() => loadFixture(directory)).toThrow(/GLOSSARY §1b/);
  });

  it('names the file that is missing', () => {
    const directory = copyOf(SMOKE);
    rmSync(join(directory, 'poll-02.json'));

    expect(() => loadFixture(directory)).toThrow(/fixture file is missing: .*poll-02\.json/);
  });

  it('names the file that is not JSON', () => {
    const directory = copyOf(SMOKE);
    writeFileSync(join(directory, MANIFEST_FILE), '{ not json', 'utf8');

    expect(() => loadFixture(directory)).toThrow(/not valid JSON: .*manifest\.json/);
  });
});

describe('CI-2 — the determinism double-run', () => {
  it('produces byte-identical reports across two independent runs', () => {
    // Everything is rebuilt inside `produce`, including the load: a shared engine or a
    // shared parse between the runs would make the second run a continuation, not a repeat.
    const produce = (): string => serializeReport(runReplay(loadFixture(SMOKE), createSmokeEngine));

    expect(() => assertDeterministic('harness-smoke', produce)).not.toThrow();
  });

  it('matches the outcomes the fixture asserts', () => {
    const fixture = loadFixture(SMOKE);

    expect(diffAgainstExpected(runReplay(fixture, createSmokeEngine), fixture.expected)).toEqual(
      [],
    );
  });

  it('does not depend on the order the polls were written in the file', () => {
    // The file lists poll 1 out of canonical order on purpose. Shuffling it further must
    // not move the report — that is what `orderBatch` is for, and the assertion below is
    // what notices if the runner ever stops calling it.
    const fixture = loadFixture(SMOKE);
    const shuffled = {
      ...fixture,
      batches: fixture.batches.map((batch) => ({
        ...batch,
        detections: [...batch.detections].reverse(),
      })),
    };

    expect(serializeReport(runReplay(shuffled, createSmokeEngine))).toBe(
      serializeReport(runReplay(fixture, createSmokeEngine)),
    );
  });
});

describe('loadFixture — the observation context', () => {
  /** The first row of `harness-smoke/poll-01.json`, so a declaration can name it. */
  const SMOKE_UID = '331623aaa3de29822bfd8c67347ef059fe69f45aa32c4c9a64ecedf9249b1cbc';

  /** A copy of the smoke fixture with an observations file wired into its manifest. */
  function withObservations(body: unknown, file = 'observations.json'): string {
    const directory = copyOf(SMOKE);
    writeFileSync(join(directory, file), JSON.stringify(body), 'utf8');
    rewrite<Record<string, unknown>>(directory, MANIFEST_FILE, (json) => ({
      ...json,
      observations: file,
    }));
    return directory;
  }

  it('gives a fixture that names no observations file the shared empty context', () => {
    // Every fixture in the register predates the field; none of them has to grow one, and
    // a consumer still reads the same three arrays.
    expect(loadFixture(SMOKE).observations).toBe(EMPTY_OBSERVATIONS);
  });

  it('reads the file the manifest names', () => {
    const directory = withObservations({
      cloudCover: [{ fromIso: '2026-08-02T11:00:00Z', toIso: '2026-08-02T13:00:00Z', percent: 85 }],
      outages: [{ source: 'firms:viirs:noaa20', fromIso: '2026-08-02T11:00:00Z', toIso: null }],
      declarations: [
        {
          detectionUid: SMOKE_UID,
          state: 'officially_extinguished',
          declaredAtIso: '2026-08-03T09:00:00Z',
          attribution: 'ГДПБЗН, РДПБЗН Хасково',
        },
      ],
    });

    const fixture = loadFixture(directory);

    expect(fixture.observations.cloudCover).toHaveLength(2);
    expect(fixture.observations.outages[0]?.source).toBe('firms:viirs:noaa20');
    expect(fixture.observations.declarations[0]?.detectionUid).toBe(SMOKE_UID);
  });

  it('names the observations file that is missing', () => {
    const directory = withObservations({});
    rmSync(join(directory, 'observations.json'));

    expect(() => loadFixture(directory)).toThrow(/fixture file is missing: .*observations\.json/);
  });

  it('names the observations file in a format error', () => {
    const directory = withObservations({ clouds: [] }, 'weather.json');

    expect(() => loadFixture(directory)).toThrow(/weather\.json: unknown key "clouds"/);
  });

  it('rejects a declaration that names a detection no poll delivers', () => {
    // A mistyped uid names an event that never exists, so the declaration would silently
    // do nothing and the scenario would assert the outcome of a statement it never made.
    const directory = withObservations({
      declarations: [
        {
          detectionUid: 'f'.repeat(64),
          state: 'officially_contained',
          declaredAtIso: '2026-08-03T09:00:00Z',
          attribution: 'ГДПБЗН',
        },
      ],
    });

    expect(() => loadFixture(directory)).toThrow(/which no poll in this fixture delivers/);
  });
});
