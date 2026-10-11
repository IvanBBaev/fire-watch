import { describe, expect, it } from 'vitest';

import type { DetectionUidFn } from '../ports/firms-client.js';
import {
  effisLayerYear,
  ingestFirmsCsv,
  parseGeoDetections,
  sourceOfProduct,
} from './fit-input.js';
import type { FitDetection } from './label-join.js';

const uid: DetectionUidFn = (p) => `${p.source}|${p.acqTsIso}|${p.lat}|${p.lon}`;

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';
const ROW = 'BGR,42.700000,23.000000,330.5,0.39,0.36,2021-07-10,1124,N,VIIRS,n,2,295.1,12.5,D';

describe('fit input', () => {
  it('takes the source from the product directory, never the CSV', () => {
    expect(sourceOfProduct('VIIRS_SNPP_SP')).toBe('firms:viirs:snpp');
    expect(sourceOfProduct('VIIRS_NOAA20_SP')).toBe('firms:viirs:noaa20');
    expect(sourceOfProduct('MODIS_SP')).toBe('firms:modis');
    expect(sourceOfProduct('VIIRS_SNPP_NRT')).toBeNull();
  });

  it('counts a uid seen in an earlier chunk once', () => {
    const seen = new Set<string>();
    const into: FitDetection[] = [];
    const text = `${HEADER}\n${ROW}\n`;
    expect(ingestFirmsCsv(text, 'firms:viirs:snpp', uid, seen, into)).toEqual({
      rows: 1,
      rejected: 0,
      duplicates: 0,
    });
    expect(ingestFirmsCsv(text, 'firms:viirs:snpp', uid, seen, into)).toEqual({
      rows: 1,
      rejected: 0,
      duplicates: 1,
    });
    expect(into).toEqual([
      {
        detectionUid: 'firms:viirs:snpp|2021-07-10T11:24:00Z|42.70000|23.00000',
        source: 'firms:viirs:snpp',
        acqTsIso: '2021-07-10T11:24:00Z',
        latCanonical: '42.70000',
        lonCanonical: '23.00000',
        scanKm: 0.39,
        trackKm: 0.36,
      },
    ]);
  });

  it('reads the provisional DS-4 shape and refuses anything else', () => {
    const rows = parseGeoDetections(
      [
        { source: 'lsasaf:fci:frp-pixel', acqTsIso: '2025-07-10T13:00:00Z', lat: 42.7, lon: '23' },
        { source: 'lsasaf:fci:frp-pixel', acqTsIso: '2025-07-10T13:00:00Z', lat: 42.7, lon: 23 },
      ],
      uid,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lonCanonical: '23.00000', scanKm: null });
    expect(() => parseGeoDetections({}, uid)).toThrow(TypeError);
    expect(() =>
      parseGeoDetections([{ source: 'firms:modis', acqTsIso: 'x', lat: 1, lon: 1 }], uid),
    ).toThrow(/GEO source/);
  });

  it('recognises only the EFFIS layer file name', () => {
    expect(effisLayerYear('modis.ba.poly.2024.geojson')).toBe(2024);
    expect(effisLayerYear('modis.ba.poly.geojson')).toBeNull();
  });
});
