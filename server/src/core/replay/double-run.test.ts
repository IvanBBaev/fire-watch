import { describe, expect, it } from 'vitest';

import { NonDeterministicReplayError, assertDeterministic, firstDifference } from './double-run.js';

describe('assertDeterministic', () => {
  it('returns the report when both runs agree', () => {
    expect(assertDeterministic('S1', () => '{"a":1}\n')).toBe('{"a":1}\n');
  });

  it('actually runs the work twice', () => {
    // A single run compared against a cached copy of itself would prove nothing.
    let runs = 0;
    assertDeterministic('S1', () => {
      runs += 1;
      return 'stable';
    });

    expect(runs).toBe(2);
  });

  it('throws when the second run differs', () => {
    let runs = 0;
    const produce = (): string => {
      runs += 1;
      return `{"id":"fw-2026-0000${String(runs)}"}`;
    };

    expect(() => assertDeterministic('S1', produce)).toThrow(NonDeterministicReplayError);
  });

  it('says which fixture drifted and where', () => {
    let runs = 0;
    const produce = (): string => {
      runs += 1;
      return `{"events":[{"publicId":"smoke-00${String(runs)}"}]}`;
    };

    expect(() => assertDeterministic('harness-smoke', produce)).toThrow(
      /harness-smoke: two runs of the same fixture differ at byte 32/,
    );
  });

  it('carries the failure as data, not only as a message', () => {
    let runs = 0;
    let captured: unknown;
    try {
      assertDeterministic('S1', () => `run-${String((runs += 1))}`);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(NonDeterministicReplayError);
    expect((captured as NonDeterministicReplayError).failure).toEqual({
      offset: 4,
      first: 'run-1',
      second: 'run-2',
    });
  });
});

describe('firstDifference', () => {
  it('reports the first differing byte', () => {
    expect(firstDifference('abcdef', 'abcXef').offset).toBe(3);
  });

  it('reports the length when one output is a prefix of the other', () => {
    // Truncation is a real failure mode: a report that stops early is not "mostly equal".
    expect(firstDifference('abc', 'abcdef').offset).toBe(3);
  });

  it('is zero when the very first byte differs', () => {
    expect(firstDifference('x', 'y')).toEqual({ offset: 0, first: 'x', second: 'y' });
  });

  it('shows leading context so the offset is readable', () => {
    const first = `${'.'.repeat(40)}A${'.'.repeat(40)}`;
    const second = `${'.'.repeat(40)}B${'.'.repeat(40)}`;

    const failure = firstDifference(first, second, 5);

    // 20 characters of run-up, then the differing byte and the window after it.
    expect(failure.first).toBe(`${'.'.repeat(20)}A....`);
    expect(failure.second).toBe(`${'.'.repeat(20)}B....`);
  });
});
