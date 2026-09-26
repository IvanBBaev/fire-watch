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
const KNOWN_OVER_BUDGET: readonly BudgetName[] = [
  // 2026-09-25, founder decision pending. MapLibre 6's worker was never in `dist` (it
  // 404ed, so no map ever painted a tile or a fire); shipping it adds ~126 KiB gz to the
  // lazy map path. Most of that is MapLibre's shared module, which the worker bundle and
  // the map chunk each carry a copy of. Before the fix the map chunk alone was ~238 KiB.
  'criticalPath',
  'map',
];

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
