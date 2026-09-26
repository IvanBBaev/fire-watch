import { describe, expect, it } from 'vitest';

import { deltaE2000, parseColor, toLab } from './color.js';
import type { CvdKind } from './cvd.js';
import { CVD_KINDS, MACHADO_2009, simulateCvd, simulateLinear } from './cvd.js';

const separation = (kind: CvdKind, first: string, second: string): number =>
  deltaE2000(
    toLab(simulateCvd(kind, parseColor(first))),
    toLab(simulateCvd(kind, parseColor(second))),
  );

describe('Machado 2009 CVD simulation (severity 1.0)', () => {
  it.each(CVD_KINDS)('%s leaves the gray axis where it is', (kind) => {
    // Every row of every published matrix sums to 1 (to the table's 6 decimals), so
    // achromatic colours are fixed points — a transcription error in any row breaks this.
    for (const row of MACHADO_2009[kind]) {
      expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 5);
    }
    for (const gray of ['#000000', '#3c3c3c', '#808080', '#ffffff']) {
      const lab = toLab(simulateCvd(kind, parseColor(gray)));
      const original = toLab(parseColor(gray));
      expect(deltaE2000(lab, original)).toBeLessThan(0.05);
    }
  });

  it('maps linear-light primaries to the columns of the published table', () => {
    // Machado 2009, severity 1.0 table, written out independently of the module.
    expect(simulateLinear('protanopia', [1, 0, 0])).toStrictEqual([0.152286, 0.114503, -0.003882]);
    expect(simulateLinear('deuteranopia', [0, 1, 0])).toStrictEqual([0.860646, 0.672501, 0.04294]);
    expect(simulateLinear('tritanopia', [0, 0, 1])).toStrictEqual([-0.178779, 0.147602, 0.3039]);
  });

  it('collapses the confusion axis of each deficiency and not the others', () => {
    // Red/green is the protan/deutan confusion; tritan vision keeps it.
    expect(separation('deuteranopia', '#ff0000', '#00ff00')).toBeLessThan(25);
    expect(separation('protanopia', '#ff0000', '#00ff00')).toBeLessThan(45);
    expect(separation('tritanopia', '#ff0000', '#00ff00')).toBeGreaterThan(70);
    // Blue/green is the tritan confusion; protan and deutan vision keep it.
    expect(separation('tritanopia', '#0000ff', '#00ff00')).toBeLessThan(50);
    expect(separation('protanopia', '#0000ff', '#00ff00')).toBeGreaterThan(80);
    expect(separation('deuteranopia', '#0000ff', '#00ff00')).toBeGreaterThan(80);
  });

  it('keeps alpha', () => {
    expect(simulateCvd('tritanopia', parseColor('rgba(10, 20, 30, 0.4)')).a).toBe(0.4);
  });
});
