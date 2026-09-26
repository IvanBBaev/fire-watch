/**
 * The register checked against the properties CI-1 leans on, not against its own rows.
 *
 * Copying the sixteen scenarios back into assertions would only prove the table was typed
 * twice. What the gate actually rests on is smaller and much easier to break by accident:
 * the ids are the fixture directory names and are unique, the stages are cumulative so no
 * scenario stops being checked by being promoted, `demandedAtStage`, `blockedAtStage` and
 * `elsewhereAtStage` cover a stage between them with nothing falling into the gap, a
 * scenario proven by another suite may not also grow a fixture, and a directory that is
 * not named like a register scenario is left alone — the allowance that keeps
 * `harness-smoke` legal while a stray `S99` stays reportable.
 *
 * The blocked flags get a guard of their own, because clearing one without authoring the
 * fixture is the mistake the register exists to catch. Clearing a flag has to put the id
 * straight into its stage's demanded set — or, for a scenario another suite proves, into
 * the set the CLI checks for that suite's file — and a flag that is still set has to carry
 * a reason a failure message can print rather than a placeholder.
 *
 * Comparing the register against the directories actually under `server/fixtures/` is
 * deliberately absent: this is core code and may not touch a Node builtin (CI-9), so that
 * half belongs to the CLI, which has a filesystem.
 */

import { describe, expect, it } from 'vitest';

import { FIXTURE_REQUIREMENTS, type FixtureRequirement } from './fixture-format.js';
import {
  FIXTURE_REGISTER,
  blockedAtStage,
  demandedAtStage,
  elsewhereAtStage,
  entriesForStage,
  registerProblems,
  requirementsForStage,
  type RegisterEntry,
} from './register.js';

const ids = (entries: readonly RegisterEntry[]): string[] => entries.map((entry) => entry.id);

const REGISTER_IDS = ids(FIXTURE_REGISTER);

/** Looks up one entry without indexing, and fails loudly if the register dropped it. */
function registerEntry(id: string): RegisterEntry {
  const found = FIXTURE_REGISTER.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the register no longer defines ${id}`);
  return found;
}

describe('FIXTURE_REGISTER', () => {
  it('holds all sixteen GATES §1.1 scenarios, S1 to S16, once each', () => {
    const expected = Array.from({ length: 16 }, (_, index) => `S${String(index + 1)}`);

    expect(REGISTER_IDS).toHaveLength(16);
    expect(new Set(REGISTER_IDS).size).toBe(REGISTER_IDS.length);
    expect([...REGISTER_IDS].sort()).toEqual([...expected].sort());
  });

  it('gives every entry an id a fixture directory could be named after', () => {
    // The id is the directory name; that is the only reason "the register has an entry
    // with no directory" is a sentence the gate can check.
    for (const entry of FIXTURE_REGISTER) {
      expect(entry.id).toMatch(/^S\d+$/);
    }
  });

  it('fills in every column the gate prints', () => {
    for (const entry of FIXTURE_REGISTER) {
      expect(FIXTURE_REQUIREMENTS).toContain(entry.required);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.asserts.length).toBeGreaterThan(0);
      expect(entry.owner.length).toBeGreaterThan(0);
    }
  });
});

describe('requirementsForStage', () => {
  it('is cumulative, in gate order', () => {
    // A fixture that stopped being checked at the stricter gate is a fixture nobody is
    // checking, so pre-season and suite re-run everything before them.
    expect(requirementsForStage('pre-merge')).toEqual(['pre-merge']);
    expect(requirementsForStage('pre-season')).toEqual(['pre-merge', 'pre-season']);
    expect(requirementsForStage('suite')).toEqual(['pre-merge', 'pre-season', 'suite']);
  });

  it('refuses a stage that is not a gate', () => {
    const notAStage = 'nightly' as unknown as FixtureRequirement;

    expect(() => requirementsForStage(notAStage)).toThrow(RangeError);
  });
});

describe('entriesForStage', () => {
  it('makes the suite gate responsible for the whole register', () => {
    expect(ids(entriesForStage('suite'))).toEqual(REGISTER_IDS);
  });

  it('returns a subset of the register, in register order', () => {
    for (const stage of FIXTURE_REQUIREMENTS) {
      const staged = ids(entriesForStage(stage));

      expect(staged).toEqual(REGISTER_IDS.filter((id) => staged.includes(id)));
    }
  });

  it('leaves the later stages something to do', () => {
    expect(ids(entriesForStage('pre-merge')).length).toBeLessThan(REGISTER_IDS.length);
  });
});

describe('demandedAtStage, blockedAtStage and elsewhereAtStage', () => {
  it('split every stage between them, with nothing lost and nothing counted twice', () => {
    for (const stage of FIXTURE_REQUIREMENTS) {
      const parts = [
        ids(demandedAtStage(stage)),
        ids(blockedAtStage(stage)),
        ids(elsewhereAtStage(stage)),
      ];
      const all = parts.flat();
      const covered = ids(entriesForStage(stage));

      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual([...covered].sort());
    }
  });

  it('never demands a fixture for a scenario another suite proves', () => {
    for (const stage of FIXTURE_REQUIREMENTS) {
      expect(demandedAtStage(stage).filter((entry) => entry.provenBy !== null)).toEqual([]);
    }
  });

  it('never calls a blocked scenario proven, wherever the proof would live', () => {
    // A path next to a blocked flag would read as "done" to anyone scanning the column.
    for (const entry of FIXTURE_REGISTER) {
      if (entry.blockedBy !== null) expect(entry.provenBy).toBeNull();
    }
  });

  it('points every elsewhere-proven scenario at a repo-relative test file', () => {
    // Whether the file exists is the CLI's check (it has a filesystem; this is core). What
    // can be held here is that the string is a path the CLI can resolve against the repo
    // root, and that it names a test — a scenario "proven" by a source file is not proven.
    for (const entry of elsewhereAtStage('suite')) {
      expect(entry.provenBy).not.toMatch(/^[/\\]/);
      expect(entry.provenBy).not.toContain('..');
      expect(entry.provenBy).toMatch(/\.test\.tsx?$/);
    }
  });

  it('records S15 as proven by the web cursor-client property suite, not by a fixture', () => {
    // GATES §1.1 says "fast-check" in S15's own row and the reconciler it exercises lives
    // in web/; a golden trace under server/fixtures would be one ordering of many.
    const s15 = registerEntry('S15');

    expect(s15.blockedBy).toBeNull();
    expect(s15.provenBy).toBe('web/src/core/feed/cursor-client.property.test.ts');
    expect(ids(elsewhereAtStage('suite'))).toContain('S15');
    expect(ids(demandedAtStage('suite'))).not.toContain('S15');
  });

  it('demands only what is unblocked, and blocks only what has a reason', () => {
    for (const stage of FIXTURE_REQUIREMENTS) {
      expect(demandedAtStage(stage).filter((entry) => entry.blockedBy !== null)).toEqual([]);

      for (const entry of blockedAtStage(stage)) {
        expect(typeof entry.blockedBy).toBe('string');
        expect(entry.blockedBy.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('registerProblems', () => {
  it('is silent when every demanded scenario has a fixture', () => {
    for (const stage of FIXTURE_REQUIREMENTS) {
      expect(registerProblems(stage, ids(demandedAtStage(stage)))).toEqual([]);
    }
  });

  it('reports a demanded scenario with no fixture, and repeats what it must assert', () => {
    const missing = registerEntry('S1');
    const present = ids(demandedAtStage('pre-merge')).filter((id) => id !== missing.id);

    const problems = registerProblems('pre-merge', present);

    expect(problems).toHaveLength(1);
    expect(problems.join('\n')).toContain(missing.id);
    // The message has to carry the scenario's own words: whoever hits this failure is
    // being asked to author the fixture, and the register is the only place that says
    // what it has to prove.
    expect(problems.join('\n')).toContain(missing.asserts);
  });

  it('reports a directory that claims a register id GATES §1.1 does not define', () => {
    const present = [...ids(demandedAtStage('pre-merge')), 'S99'];

    const problems = registerProblems('pre-merge', present);

    expect(problems).toHaveLength(1);
    expect(problems.join('\n')).toContain('S99');
  });

  it('reports a fixture for a scenario the register says another suite proves', () => {
    // Two proofs of one row drift apart without anyone noticing, and the register can only
    // vouch for the one it names.
    for (const entry of elsewhereAtStage('suite')) {
      const problems = registerProblems('suite', [...ids(demandedAtStage('suite')), entry.id]);

      expect(problems).toHaveLength(1);
      expect(problems.join('\n')).toContain(entry.provenBy);
    }
  });

  it('leaves a fixture named outside the S<n> space alone', () => {
    // `harness-smoke` is not a register scenario — it fails when the harness breaks, not
    // when clustering does — and the allowance is deliberate in both directions: without
    // it the smoke fixture is illegal, and with it a stray S-numbered directory is still
    // reported by the test above.
    const present = [...ids(demandedAtStage('pre-merge')), 'harness-smoke'];

    expect(registerProblems('pre-merge', present)).toEqual([]);
  });

  it('does not call a blocked scenario a missing fixture', () => {
    // S6 is the standing example: it asserts a lifecycle outcome nothing in the repo
    // computes, so pre-merge must stay green while its directory does not exist.
    const present = ids(demandedAtStage('pre-merge'));

    for (const entry of blockedAtStage('pre-merge')) {
      expect(present).not.toContain(entry.id);
    }
    expect(registerProblems('pre-merge', present)).toEqual([]);
  });
});

describe('blockedBy', () => {
  it('names the task that owes the fixture, rather than restating the row', () => {
    for (const entry of FIXTURE_REGISTER) {
      if (entry.blockedBy === null) continue;

      // Not the exact wording — that changes every time a task lands. What must not
      // appear is a flag with nothing behind it, because then the reason the fixture is
      // absent is unreviewable and the flag may as well be a deleted row.
      expect(entry.blockedBy.length).toBeGreaterThan(0);
      expect(entry.blockedBy).not.toBe(entry.id);
      expect(entry.blockedBy).not.toBe(entry.title);
    }
  });

  it('puts an entry into its own stage the moment its flag is cleared', () => {
    // This is what makes clearing a flag a commitment: the id becomes demanded, and the
    // gate stays red until someone authors the fixture — or it names the suite that proves
    // it, and the gate stays red if that suite disappears.
    for (const entry of FIXTURE_REGISTER) {
      if (entry.blockedBy !== null) continue;

      // Cleared means accounted for at its own stage: either a fixture is demanded, or the
      // suite that proves it is named and the CLI checks it is still there.
      const accounted = [
        ...ids(demandedAtStage(entry.required)),
        ...ids(elsewhereAtStage(entry.required)),
      ];
      expect(accounted).toContain(entry.id);
    }
  });
});
