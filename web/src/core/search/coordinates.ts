/**
 * Coordinates typed into the search box: "42.69, 23.32", "42,69 23,32" (Bulgarian decimal
 * comma), "42.69; 23.32", and degrees-minutes-seconds with hemisphere letters in either
 * alphabet ("42°41'49\"N 23°19'18\"E", "42°41′49″ С, 23°19′18″ И").
 *
 * Latitude first, as every Bulgarian and Google Maps copy-paste writes it. A pair whose
 * first value cannot be a latitude but whose second can is read the other way round — a
 * GeoJSON-order paste is a common mistake and the swap is unambiguous. Anything else that
 * does not parse to a valid point is `null`: search then falls through to place names.
 */

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

const HEMISPHERE: Readonly<Record<string, 'N' | 'S' | 'E' | 'W'>> = {
  n: 'N',
  s: 'S',
  e: 'E',
  w: 'W',
  с: 'N',
  ю: 'S',
  и: 'E',
  з: 'W',
};

function valid(lat: number, lon: number): LatLon | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  // GeoJSON order pasted by mistake: swap only when that is the one valid reading.
  if (Math.abs(lon) <= 90 && Math.abs(lat) <= 180) return { lat: lon, lon: lat };
  return null;
}

const NUMBER = String.raw`[-+−]?\d{1,3}(?:[.,]\d+)?`;

/** Decimal degrees, separated by a comma, semicolon or whitespace. */
function parseDecimal(text: string): LatLon | null {
  const s = text.replace(/−/g, '-');
  // "42.69, 23.32" / "42.69 23.32" / "42.69;23.32" — dot decimals, any separator.
  let m = new RegExp(
    String.raw`^([-+]?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:\.\d+)?)$`,
  ).exec(s);
  // "42,69 23,32" / "42,69; 23,32" — comma decimals, separated by whitespace or ';'.
  m ??= new RegExp(
    String.raw`^([-+]?\d{1,3}(?:,\d+)?)\s*(?:;\s*|\s+)([-+]?\d{1,3}(?:,\d+)?)$`,
  ).exec(s);
  if (m === null) return null;
  const a = Number((m[1] as string).replace(',', '.'));
  const b = Number((m[2] as string).replace(',', '.'));
  return valid(a, b);
}

const DMS_PART = new RegExp(
  String.raw`(${NUMBER})\s*°?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:["″”]|'')\s*)?([NSEWnsewСЮИЗсюиз])`,
  'gu',
);

/** Degrees[-minutes[-seconds]] with a hemisphere letter after each part. */
function parseDms(text: string): LatLon | null {
  const parts = [...text.matchAll(DMS_PART)];
  if (parts.length !== 2) return null;
  // Everything but the two parts and separators must be consumed, or it is not a coordinate.
  const leftover = text.replace(DMS_PART, '').replace(/[\s,;]/g, '');
  if (leftover !== '') return null;
  let lat: number | null = null;
  let lon: number | null = null;
  for (const part of parts) {
    const deg = Number((part[1] as string).replace('−', '-').replace(',', '.'));
    const min = part[2] === undefined ? 0 : Number(part[2].replace(',', '.'));
    const sec = part[3] === undefined ? 0 : Number(part[3].replace(',', '.'));
    if (min >= 60 || sec >= 60 || deg < 0) return null;
    const hemi = HEMISPHERE[(part[4] as string).toLowerCase()];
    const value = deg + min / 60 + sec / 3600;
    if (hemi === 'N' || hemi === 'S') {
      if (lat !== null) return null;
      lat = hemi === 'S' ? -value : value;
    } else {
      if (lon !== null) return null;
      lon = hemi === 'W' ? -value : value;
    }
  }
  if (lat === null || lon === null) return null;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function parseCoordinates(input: string): LatLon | null {
  const text = input.trim();
  if (text === '') return null;
  return parseDecimal(text) ?? parseDms(text);
}
