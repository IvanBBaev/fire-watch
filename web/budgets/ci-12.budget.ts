/**
 * CI-12 — bundle byte budgets over the real production build in `web/dist`.
 *
 * Run through `pnpm run test:budgets`, which builds first. The classification rules and
 * the arithmetic are unit-tested on synthetic manifests in `bundle-budgets.test.ts`;
 * this file only points them at the shipped bundle.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkBuild, formatReport } from './bundle-budgets.js';
import type { BudgetName } from './bundle-budgets.js';
import { readBuild } from './read-build.js';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Budgets the current build is over, on record as a standing finding. The budgets are
 * ADR-005 spec numbers and are never raised to make this pass; an overage is fixed in
 * the bundle or taken to the founder. Compared exactly, so a new overage and a silent
 * fix both go red — the second so this list is emptied in the change that earns it.
 */
// Empty from 2026-10-10 (TASKS F8) to 2026-10-24: `map` and `criticalPath` were over from
// 2026-09-25, when the `?worker&url` worker bundle carried a second copy of MapLibre's
// shared module; MapLibre's own files are now shipped once each (`maplibreSharedModule()`).
//
// `criticalPath` over again since 2026-10-24 (V2-F4), by ~130 B gzip of 350 KiB: the
// land-cover note's loader (~180 B), its bg catalog strings (~165 B) and the WorldCover
// credit (~115 B) did not fit the ~330 B left after V2-F1. Founder decision pending. The
// candidate fix in the bundle: the `source` and `authority` fields of `CREDITS` are
// provenance the web never renders, yet they ship in the entry (~985 B gzip); moving them
// out of the shipped array would clear this with room to spare.
//
// After v2 wave 1 merged (V2-A1, A2, A4, B1, B3, D3, E3, F1, F4), ~2.4 KB over at 360,767 B,
// with the opt-in overlays' map layers (swaths, lightning, outlines) already lazy. Moving the
// credit provenance out (~1.15 KB) no longer clears it alone; the rest has to come from the
// bg catalog's strings for on-demand features or from a lazy Layers-panel body. Founder call.
const KNOWN_OVER_BUDGET: readonly BudgetName[] = ['criticalPath'];

describe('CI-12 bundle budgets (ADR-005 D3)', () => {
  const report = checkBuild(readBuild(distDir, publicDir));

  it('classifies every chunk and file of the build, and ships no webfont', () => {
    expect(report.errors).toStrictEqual([]);
  });

  it('stays within every byte budget, but for the overages on record', () => {
    console.log(formatReport(report));
    expect([...report.overBudget].sort()).toStrictEqual([...KNOWN_OVER_BUDGET].sort());
  });
});
