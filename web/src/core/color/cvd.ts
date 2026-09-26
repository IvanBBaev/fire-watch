/**
 * Colour-vision-deficiency simulation for the CI-14 gate (review 06 §5.4, 07 §5.8.1).
 *
 * Machado, Oliveira & Fernandes 2009, "A Physiologically-based Model for Simulation of
 * Color Vision Deficiency" (IEEE TVCG 15(6)), severity 1.0 — i.e. full dichromacy, the
 * worst case the review asks the palette to survive. The matrices are the paper's
 * published severity-1.0 table and are applied to **linear** sRGB, which is the space the
 * model is derived in; the result is clamped back into gamut before it is re-encoded.
 *
 * Why Machado rather than Brettel/Viénot: one 3×3 matrix per deficiency covers all three
 * (protan, deutan, tritan) with one method, which is what the review requires, and the
 * matrices are small enough to be read against the paper in review.
 */

import type { LinearRgb, Rgba } from './color.js';
import { fromLinear, toLinear } from './color.js';

export const CVD_KINDS = ['protanopia', 'deuteranopia', 'tritanopia'] as const;
export type CvdKind = (typeof CVD_KINDS)[number];

type Matrix = readonly [LinearRgb, LinearRgb, LinearRgb];

/** Machado 2009, Table of simulation matrices, severity 1.0 (rows act on [R, G, B]ᵀ). */
export const MACHADO_2009: Readonly<Record<CvdKind, Matrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** The simulated linear-light triple, unclamped (clamping happens on re-encoding). */
export function simulateLinear(kind: CvdKind, [r, g, b]: LinearRgb): LinearRgb {
  const [row0, row1, row2] = MACHADO_2009[kind];
  const apply = ([m0, m1, m2]: LinearRgb): number => m0 * r + m1 * g + m2 * b;
  return [apply(row0), apply(row1), apply(row2)];
}

/** How `color` appears to a dichromat of the given kind, as displayable sRGB. */
export function simulateCvd(kind: CvdKind, color: Rgba): Rgba {
  return fromLinear(simulateLinear(kind, toLinear(color)), color.a);
}
