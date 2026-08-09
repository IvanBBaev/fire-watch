import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from './clock.js';

describe('epochMsFromIso', () => {
  it('accepts an explicit UTC instant', () => {
    expect(epochMsFromIso('2026-08-02T00:00:00Z')).toBe(Date.UTC(2026, 7, 2));
    expect(epochMsFromIso('2026-08-02T00:00Z')).toBe(Date.UTC(2026, 7, 2));
  });

  it('rejects anything the host timezone could reinterpret', () => {
    expect(() => epochMsFromIso('2026-08-02T00:00:00')).toThrow(RangeError);
    expect(() => epochMsFromIso('2026-08-02T00:00:00+02:00')).toThrow(RangeError);
    expect(() => epochMsFromIso('2026-08-02')).toThrow(RangeError);
  });
});

describe('VirtualClock', () => {
  it('stands still until the test moves it', () => {
    const clock = new VirtualClock('2026-08-02T00:00:00Z');
    const first = clock.now();
    expect(clock.now()).toBe(first);
    clock.advanceHours(72);
    expect(clock.now() - first).toBe(72 * 3_600_000);
  });

  it('refuses to run backwards', () => {
    const clock = new VirtualClock('2026-08-02T00:00:00Z');
    expect(() => clock.advanceMs(-1)).toThrow(RangeError);
    expect(() => clock.set('2026-08-01T00:00:00Z')).toThrow(RangeError);
  });
});
