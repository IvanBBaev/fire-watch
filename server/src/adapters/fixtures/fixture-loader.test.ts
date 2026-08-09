import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertDeterministic } from '../../core/replay/double-run.js';
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
