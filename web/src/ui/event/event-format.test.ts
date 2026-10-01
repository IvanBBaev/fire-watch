import { describe, expect, it } from 'vitest';

import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import { distanceText, orbitText, pixelText, sensorLabel } from './event-format.js';

describe('sensorLabel', () => {
  it('names a known source and passes an unknown id through', () => {
    expect(sensorLabel('firms:viirs:noaa20')).toBe('VIIRS · NOAA-20');
    expect(sensorLabel('someone:new')).toBe('someone:new');
  });
});

describe('pixelText', () => {
  it('words the §1a pixel sizes', () => {
    expect(pixelText('firms:viirs:snpp', en, 'en')).toBe('375 m');
    expect(pixelText('firms:modis', en, 'en')).toBe('1 km');
    expect(pixelText('lsasaf:seviri:frp-pixel', en, 'en')).toBe('~4 km');
    expect(pixelText('lsasaf:fci:frp-pixel', en, 'en')).toBe('~3–4.5 km');
  });

  it('uses the locale decimal separator and units', () => {
    expect(pixelText('lsasaf:fci:frp-pixel', bg, 'bg')).toBe('~3–4,5 км');
    expect(pixelText('firms:viirs:snpp', bg, 'bg')).toBe('375 м');
  });

  it('says nothing for an unknown source', () => {
    expect(pixelText('someone:new', en, 'en')).toBeNull();
  });
});

describe('orbitText', () => {
  it('labels polar and geostationary sensors', () => {
    expect(orbitText('eumetsat:slstr:frp', en)).toBe('polar orbit');
    expect(orbitText('lsasaf:seviri:frp-pixel', en)).toBe('geostationary');
    expect(orbitText('someone:new', en)).toBeNull();
  });
});

describe('distanceText', () => {
  it('words a distance and a direction', () => {
    expect(distanceText({ km: 12, compass: 'NE', nearby: false }, en, 'en')).toBe(
      'About 12 km north-east of your location',
    );
    expect(distanceText({ km: 2.5, compass: 'S', nearby: false }, bg, 'bg')).toBe(
      'На около 2,5 км южно от вашето местоположение',
    );
  });

  it('drops the direction when the event is under a kilometre away', () => {
    expect(distanceText({ km: 0.4, compass: 'W', nearby: true }, en, 'en')).toBe(
      'Less than 1 km from your location',
    );
  });
});
