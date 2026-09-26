/**
 * The ingestion-parity check's read side (TASKS C9; A23).
 *
 * Our half of the comparison: the rows the reference will be compared against. The rules
 * are stated here so an adapter cannot quietly pick others:
 *
 *   - **NRT rows only** (`product_tier = 'NRT'`). The reference is a FIRMS NRT export; an
 *     SP row promoted later has a different uid by construction and would read as "extra".
 *   - **The window is on `acq_ts`**, half-open, exactly the comparator's.
 *   - **Only the requested sources.** A source with no reference file is not compared.
 *   - **Quarantined rows are included**, with the flag set.
 *
 * The bbox is *not* the reader's to apply: the comparator applies it to both sides, and
 * counts what it drops on each.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { OurParityRow, ParityWindow } from '../ingest/parity-check.js';

export interface ParityReader {
  loadNrtDetections(query: {
    readonly sources: readonly SourceId[];
    readonly window: ParityWindow;
  }): Promise<readonly OurParityRow[]>;
}
