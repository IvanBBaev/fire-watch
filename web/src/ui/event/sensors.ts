/**
 * The instruments behind each source id, with their nominal pixel size — one typed table.
 *
 * Values transcribe GLOSSARY §1a ("Source-id registry"), which is the authority; do not
 * tune them here. Pixel size is what makes the FRP caveat concrete: the same fire read by a
 * 375 m VIIRS pixel and a ~4 km SEVIRI pixel yields different numbers, so FRP is never
 * compared across instruments.
 *
 * Instrument and platform names are proper nouns and stay untranslated in both locales,
 * like the product name; only the words around them go through the catalogs.
 */

import type { SourceId } from '@fire-watch/contracts';

export type Orbit = 'polar' | 'geostationary';

export interface SensorInfo {
  /** Instrument and platform, e.g. "VIIRS · Suomi NPP". */
  readonly label: string;
  readonly orbit: Orbit;
  /** Nominal pixel edge at nadir (polar) or over Bulgaria (geostationary), in metres. */
  readonly pixelMinM: number;
  /** Equal to {@link pixelMinM} unless §1a states a range. */
  readonly pixelMaxM: number;
  /** §1a writes the value with "~" — an over-Bulgaria figure, not a fixed grid. */
  readonly approximate: boolean;
}

export const SENSORS: Readonly<Record<SourceId, SensorInfo>> = {
  'firms:viirs:snpp': {
    label: 'VIIRS · Suomi NPP',
    orbit: 'polar',
    pixelMinM: 375,
    pixelMaxM: 375,
    approximate: false,
  },
  'firms:viirs:noaa20': {
    label: 'VIIRS · NOAA-20',
    orbit: 'polar',
    pixelMinM: 375,
    pixelMaxM: 375,
    approximate: false,
  },
  'firms:viirs:noaa21': {
    label: 'VIIRS · NOAA-21',
    orbit: 'polar',
    pixelMinM: 375,
    pixelMaxM: 375,
    approximate: false,
  },
  'firms:modis': {
    label: 'MODIS · Terra/Aqua',
    orbit: 'polar',
    pixelMinM: 1000,
    pixelMaxM: 1000,
    approximate: false,
  },
  'eumetsat:slstr:frp': {
    label: 'SLSTR · Sentinel-3A/3B',
    orbit: 'polar',
    pixelMinM: 1000,
    pixelMaxM: 1000,
    approximate: false,
  },
  'lsasaf:seviri:frp-pixel': {
    label: 'SEVIRI · Meteosat',
    orbit: 'geostationary',
    pixelMinM: 4000,
    pixelMaxM: 4000,
    approximate: true,
  },
  'lsasaf:fci:frp-pixel': {
    label: 'FCI · Meteosat Third Generation',
    orbit: 'geostationary',
    pixelMinM: 3000,
    pixelMaxM: 4500,
    approximate: true,
  },
};

/** The table's rows in registry order — the order sensors are listed on the page. */
const ORDER: readonly string[] = Object.keys(SENSORS);

export function isKnownSource(sourceId: string): sourceId is SourceId {
  return Object.hasOwn(SENSORS, sourceId);
}

/** A stable sort key: registry order, unknown ids last. */
export function sensorOrder(sourceId: string): number {
  const index = ORDER.indexOf(sourceId);
  return index === -1 ? ORDER.length : index;
}

/** The unit-bearing parts of a pixel size; the caller words them through the catalog. */
export interface PixelSize {
  readonly unit: 'm' | 'km';
  /** Equal to {@link PixelSize.max} unless the table states a range (FCI: 3 to 4.5 km). */
  readonly min: number;
  readonly max: number;
  readonly approximate: boolean;
}

/** Metres below 1 km, kilometres from 1 km up. */
export function pixelSize(sensor: SensorInfo): PixelSize {
  const unit = sensor.pixelMaxM >= 1000 ? 'km' : 'm';
  const scale = unit === 'km' ? 1000 : 1;
  return {
    unit,
    min: sensor.pixelMinM / scale,
    max: sensor.pixelMaxM / scale,
    approximate: sensor.approximate,
  };
}
