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
// Empty since 2026-10-10 (TASKS F8): `map` and `criticalPath` were over from 2026-09-25,
// when the `?worker&url` worker bundle carried a second copy of MapLibre's shared module;
// MapLibre's own files are now shipped once each (`maplibreSharedModule()`).
const KNOWN_OVER_BUDGET: readonly BudgetName[] = [];

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
