import { describe, expect, it } from 'vitest';

import { KEEPALIVE_CHUNK, encodeFrame, encodeRetry, isEventFrame } from './frames.js';
import { frame } from './test-rows.js';

describe('encodeFrame', () => {
  it('writes id, event and one data line for an event frame, then a blank line', () => {
    const chunk = encodeFrame(frame(1041, 'event.created'));
    const lines = chunk.split('\n');
    expect(lines[0]).toBe('id: 1041');
    expect(lines[1]).toBe('event: event.created');
    expect(lines[2]?.startsWith('data: {')).toBe(true);
    expect(chunk.endsWith('\n\n')).toBe(true);
    // Exactly one data line: a payload with a newline inside would be split by the parser.
    expect(lines.filter((line) => line.startsWith('data:'))).toHaveLength(1);
  });

  it('omits the id line for a control frame, so it never moves Last-Event-ID', () => {
    const chunk = encodeFrame({ event: 'reset', data: { reason: 'too_old' } });
    expect(chunk).toBe('event: reset\ndata: {"reason":"too_old"}\n\n');
    expect(chunk).not.toContain('id:');
  });

  it('round-trips the payload through JSON on a single line', () => {
    const chunk = encodeFrame({
      event: 'freshness',
      data: {
        generated_at: '2026-07-14T10:15:00Z',
        max_seq: 1041,
        sources: [{ source_id: 'firms-modis', last_observed_at: null }],
      },
    });
    const data = chunk.split('\n')[1]?.slice('data: '.length) ?? '';
    expect(JSON.parse(data)).toEqual({
      generated_at: '2026-07-14T10:15:00Z',
      max_seq: 1041,
      sources: [{ source_id: 'firms-modis', last_observed_at: null }],
    });
  });

  it('never ships the raw score in an event frame (ADR-003 D4)', () => {
    expect(encodeFrame(frame(7))).not.toContain('"score"');
    expect(encodeFrame(frame(7))).toContain('"score_bucket"');
  });
});

describe('isEventFrame', () => {
  it('tells the replayable frames from the control frames by the id', () => {
    expect(isEventFrame(frame(1))).toBe(true);
    expect(isEventFrame({ event: 'degrade', data: { reason: 'capacity' } })).toBe(false);
  });
});

describe('encodeRetry', () => {
  it('is the retry line followed by the frame terminator', () => {
    expect(encodeRetry(5000)).toBe('retry: 5000\n\n');
    expect(encodeRetry(0)).toBe('retry: 0\n\n');
  });

  it('refuses anything a browser would ignore', () => {
    expect(() => encodeRetry(-1)).toThrow(RangeError);
    expect(() => encodeRetry(1.5)).toThrow(RangeError);
    expect(() => encodeRetry(Number.NaN)).toThrow(RangeError);
  });
});

describe('KEEPALIVE_CHUNK', () => {
  it('is a comment line: ignored by EventSource, enough to keep a proxy from idling out', () => {
    expect(KEEPALIVE_CHUNK.startsWith(':')).toBe(true);
    expect(KEEPALIVE_CHUNK.endsWith('\n\n')).toBe(true);
  });
});
