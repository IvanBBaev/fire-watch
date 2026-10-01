import fc from 'fast-check';
import {
  ecfToLookAngles,
  eciToEcf,
  gstime,
  propagate,
  sgp4,
  twoline2satrec,
  type SatRec,
} from 'satellite.js';
import { describe, expect, it } from 'vitest';

import {
  OMM_BY_NORAD,
  OMM_NOAA20,
  OMM_S3A,
  CELESTRAK_FETCHED_AT_MS,
} from './__fixtures__/celestrak-omm.js';
import { parseOmmBody, satrecFromOmm } from './omm.js';
import {
  computePasses,
  greatCircleKm,
  sunElevationDeg,
  type ComputedPass,
  type GroundPoint,
} from './pass-compute.js';
import { PASS_PLATFORMS } from './pass-platforms.js';

const HOUR = 3_600_000;
const SOFIA: GroundPoint = { lat: 42.75, lon: 23.25 };

function satrecOf(body: string, noradId: number): SatRec {
  const parsed = parseOmmBody(body, noradId);
  if (!parsed.ok) throw new Error(parsed.reason);
  return satrecFromOmm(parsed.record);
}

/**
 * SGP4 against the published verification case: Vallado, Crawford, Hujsak & Kelso,
 * "Revisiting Spacetrack Report #3" (AIAA 2006-6753), test set `SGP4-VER.TLE`, satellite
 * 00005, whose expected states are in `tcppver.out`. Tolerance 1 m in position and
 * 1 mm/s in velocity — the reference run agrees with itself across platforms to ~1e-8 km,
 * so a looser bound would only hide a mis-wired library.
 */
describe('SGP4 reference (Vallado SGP4-VER, satellite 00005)', () => {
  const satrec = twoline2satrec(
    '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
    '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
  );
  const POSITION_TOLERANCE_KM = 1e-3;
  const VELOCITY_TOLERANCE_KMS = 1e-6;

  it.each([
    [0, [7022.46529266, -1400.08296755, 0.03995155], [1.893841015, 6.405893759, 4.53480725]],
    [
      360,
      [-7154.03120202, -3783.17682504, -3536.19412294],
      [4.741887409, -4.151817765, -2.093935425],
    ],
  ] as const)('t = %i min matches tcppver.out', (minutes, r, v) => {
    const state = sgp4(satrec, minutes);
    expect(state).not.toBeNull();
    const { position, velocity } = state!;
    expect(Math.abs(position.x - r[0])).toBeLessThan(POSITION_TOLERANCE_KM);
    expect(Math.abs(position.y - r[1])).toBeLessThan(POSITION_TOLERANCE_KM);
    expect(Math.abs(position.z - r[2])).toBeLessThan(POSITION_TOLERANCE_KM);
    expect(Math.abs(velocity.x - v[0])).toBeLessThan(VELOCITY_TOLERANCE_KMS);
    expect(Math.abs(velocity.y - v[1])).toBeLessThan(VELOCITY_TOLERANCE_KMS);
    expect(Math.abs(velocity.z - v[2])).toBeLessThan(VELOCITY_TOLERANCE_KMS);
  });

  it('the OMM path initialises SGP4 to a sane JPSS orbit', () => {
    const fromOmm = satrecOf(OMM_NOAA20, 43013);
    const at = new Date(CELESTRAK_FETCHED_AT_MS);
    const state = propagate(fromOmm, at);
    expect(state).not.toBeNull();
    const radius = Math.hypot(state!.position.x, state!.position.y, state!.position.z);
    // JPSS orbits at ~824 km: geocentric radius 7 190–7 210 km.
    expect(radius).toBeGreaterThan(7_180);
    expect(radius).toBeLessThan(7_220);
  });
});

describe('computePasses', () => {
  const window = {
    fromMs: CELESTRAK_FETCHED_AT_MS - 12 * HOUR,
    toMs: CELESTRAK_FETCHED_AT_MS + 24 * HOUR,
  };

  it('agrees with a brute-force 1 s elevation sweep', () => {
    const satrec = satrecOf(OMM_NOAA20, 43013);
    const passes = computePasses(satrec, SOFIA, window, 3060);
    expect(passes.length).toBeGreaterThanOrEqual(8);

    for (const pass of passes) {
      // Walk second by second across the pass and a minute either side.
      let firstUp: number | null = null;
      let lastUp: number | null = null;
      let best = -Infinity;
      let bestAt = 0;
      for (let t = pass.aosMs - 60_000; t <= pass.losMs + 60_000; t += 1000) {
        const el = elevationDeg(satrec, SOFIA, t);
        if (el > 0) {
          firstUp ??= t;
          lastUp = t;
        }
        if (el > best) {
          best = el;
          bestAt = t;
        }
      }
      expect(Math.abs(firstUp! - pass.aosMs)).toBeLessThanOrEqual(2000);
      expect(Math.abs(lastUp! - pass.losMs)).toBeLessThanOrEqual(2000);
      expect(Math.abs(bestAt - pass.culminationMs)).toBeLessThanOrEqual(3000);
      expect(Math.abs(best - pass.maxElevationDeg)).toBeLessThanOrEqual(0.1);
    }
  });

  it('finds the sun-synchronous rhythm: VIIRS early afternoon and after midnight, local solar time', () => {
    const passes = computePasses(satrecOf(OMM_NOAA20, 43013), SOFIA, window, 3060);
    for (const pass of passes.filter((p) => p.inSwath)) {
      // Local solar hour = UTC + lon/15.
      const solarHour = (((pass.culminationMs / HOUR + SOFIA.lon / 15) % 24) + 24) % 24;
      const nearAfternoon = solarHour > 11.5 && solarHour < 15.5;
      const nearNight = solarHour > 23.5 || solarHour < 3.5;
      expect(nearAfternoon || nearNight, `solar hour ${solarHour.toFixed(2)}`).toBe(true);
      expect(pass.daylight).toBe(nearAfternoon ? 'day' : 'night');
    }
  });

  it('SLSTR looks mid-morning by day and mid-evening by night', () => {
    const passes = computePasses(satrecOf(OMM_S3A, 41335), SOFIA, window, 1420);
    const inSwath = passes.filter((p) => p.inSwath);
    expect(inSwath.length).toBeGreaterThan(0);
    for (const pass of inSwath) {
      const solarHour = (((pass.culminationMs / HOUR + SOFIA.lon / 15) % 24) + 24) % 24;
      expect(
        (solarHour > 8.5 && solarHour < 12) || (solarHour > 20.5 && solarHour < 24),
        `solar hour ${solarHour.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('is deterministic', () => {
    const satrec = () => satrecOf(OMM_NOAA20, 43013);
    expect(computePasses(satrec(), SOFIA, window, 3060)).toEqual(
      computePasses(satrec(), SOFIA, window, 3060),
    );
  });

  it('keeps only passes whose culmination is inside the window, and each exactly once', () => {
    const satrec = satrecOf(OMM_NOAA20, 43013);
    const whole = computePasses(satrec, SOFIA, window, 3060);
    const split = window.fromMs + 7 * HOUR + 1234;
    const left = computePasses(satrec, SOFIA, { fromMs: window.fromMs, toMs: split }, 3060);
    const right = computePasses(satrec, SOFIA, { fromMs: split, toMs: window.toMs }, 3060);
    expect([...left, ...right]).toEqual(whole);
  });

  const platformArb = fc.constantFrom(...PASS_PLATFORMS);
  const pointArb = fc.record({
    lat: fc.double({ min: 39.25, max: 45.75, noNaN: true }),
    lon: fc.double({ min: 20.25, max: 30.75, noNaN: true }),
  });
  const offsetArb = fc.integer({ min: -2 * 24, max: 2 * 24 });

  it('property: every pass is ordered, inside the window, whole-second and self-consistent', () => {
    fc.assert(
      fc.property(platformArb, pointArb, offsetArb, (platform, point, offsetHours) => {
        const satrec = satrecOf(OMM_BY_NORAD[platform.noradId]!, platform.noradId);
        const from = CELESTRAK_FETCHED_AT_MS + offsetHours * HOUR;
        const passes = computePasses(
          satrec,
          point,
          { fromMs: from, toMs: from + 12 * HOUR },
          platform.swathKm,
        );
        let previous: ComputedPass | null = null;
        for (const pass of passes) {
          expect(pass.aosMs).toBeLessThan(pass.culminationMs);
          expect(pass.culminationMs).toBeLessThan(pass.losMs);
          // An 824 km LEO is up for at most ~16 minutes over one point.
          expect(pass.losMs - pass.aosMs).toBeLessThan(17 * 60_000);
          expect(pass.culminationMs).toBeGreaterThanOrEqual(from - 1000);
          expect(pass.culminationMs).toBeLessThan(from + 12 * HOUR + 1000);
          for (const t of [pass.aosMs, pass.culminationMs, pass.losMs]) expect(t % 1000).toBe(0);
          expect(pass.maxElevationDeg).toBeGreaterThanOrEqual(0);
          expect(pass.maxElevationDeg).toBeLessThanOrEqual(90);
          expect(pass.inSwath).toBe(pass.crossTrackKm <= platform.swathKm / 2 + 0.5);
          if (previous !== null) expect(previous.losMs).toBeLessThan(pass.aosMs);
          previous = pass;
        }
      }),
      { numRuns: 40 },
    );
  });

  it('property: higher culmination means a closer ground track', () => {
    fc.assert(
      fc.property(platformArb, pointArb, (platform, point) => {
        const satrec = satrecOf(OMM_BY_NORAD[platform.noradId]!, platform.noradId);
        const passes = computePasses(satrec, point, window, platform.swathKm);
        const byElevation = [...passes].sort((a, b) => b.maxElevationDeg - a.maxElevationDeg);
        for (let i = 1; i < byElevation.length; i += 1) {
          // Allow the rounding of both numbers plus orbit-altitude variation (~20 km).
          expect(byElevation[i]!.crossTrackKm + 25).toBeGreaterThanOrEqual(
            byElevation[i - 1]!.crossTrackKm,
          );
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('geometry helpers', () => {
  it('great-circle distance: one degree of latitude is ~111.2 km', () => {
    expect(greatCircleKm({ lat: 42, lon: 25 }, { lat: 43, lon: 25 })).toBeCloseTo(111.2, 0);
    expect(greatCircleKm(SOFIA, SOFIA)).toBe(0);
  });

  it('sun elevation: high at Sofia noon in summer, below the horizon at midnight', () => {
    // 2026-06-21, local solar noon at 23.25° E ≈ 10:27 UTC; max elevation 90 − 42.75 + 23.44.
    const noon = Date.UTC(2026, 5, 21, 10, 27);
    expect(sunElevationDeg(SOFIA, noon)).toBeGreaterThan(70);
    expect(sunElevationDeg(SOFIA, noon)).toBeLessThan(71.5);
    expect(sunElevationDeg(SOFIA, Date.UTC(2026, 5, 21, 22, 27))).toBeLessThan(-20);
  });
});

/** Recomputed outside the module under test, from the library's primitives. */
function elevationDeg(satrec: SatRec, point: GroundPoint, ms: number): number {
  const date = new Date(ms);
  const state = propagate(satrec, date);
  if (state === null) return -90;
  const look = ecfToLookAngles(
    { latitude: (point.lat * Math.PI) / 180, longitude: (point.lon * Math.PI) / 180, height: 0 },
    eciToEcf(state.position, gstime(date)),
  );
  return (look.elevation * 180) / Math.PI;
}
