import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../../core/config/polling-bbox.js';
import {
  LIGHTNING_PAYLOAD_FORMAT,
  LIGHTNING_WINDOW_TOLERANCE_MS,
  parseLightningPayload,
} from '../../core/lightning/lightning-payload.js';
import {
  LIGHTNING_KIND as PORT_KIND,
  LIGHTNING_SOURCE as PORT_SOURCE,
  type LightningGranuleRef,
} from '../../core/ports/lightning-decoder.js';
import {
  DECODER_REASON_PREFIX,
  DECODER_REFUSED_EXIT,
  GRANULE_REF_ENV,
} from './child-process-decoder.js';
import { createMtgLiDecoder } from './mtg-li-decoder.js';
import {
  EXIT_REFUSED,
  LFL_VARIABLES,
  LIGHTNING_KIND,
  LIGHTNING_SOURCE,
  PAYLOAD_FORMAT,
  REASON_PREFIX,
  REF_ENV,
  WINDOW_TOLERANCE_MS,
  decodeLflBody,
  parseWindow,
  sniff,
  type DecodeAttempt,
  type Payload,
} from './mtg-li-flash-decoder.js';
import { buildLflBody, type SyntheticFlash } from './mtg-li-synthetic.js';

/** The real child, run from its TypeScript source (no relative runtime imports). */
const ENTRY = fileURLToPath(new URL('./mtg-li-flash-decoder.ts', import.meta.url));
const CHILD_TIMEOUT_MS = 20_000;

/** A window with the real product's unaligned 09-second edges. */
const REF: LightningGranuleRef = {
  source: LIGHTNING_SOURCE,
  kind: LIGHTNING_KIND,
  slotIso: '2026-09-30T12:20:09Z/2026-09-30T12:30:09Z',
  name: 'W_XX-EUMETSAT-Darmstadt,IMG+SAT,MTI1+LI-2-LFL--FD--CHK-BODY--ARC-NC4E_C_EUMT_20260930123025_L2PF_OPE_20260930122009_20260930123009_N__O_0075_0001.nc',
};

/** Two over Bulgaria, one over Greece, one over the Gulf of Guinea (outside the polling box). */
const FLASHES: readonly SyntheticFlash[] = [
  {
    t: '2026-09-30T12:21:00.250Z',
    lat: 42.7,
    lon: 23.3,
    radiance: 120.5,
    durationMs: 180,
    footprint: 12,
  },
  { t: '2026-09-30T12:25:30Z', lat: 42.1, lon: 24.75, radiance: 40, durationMs: 90, footprint: 3 },
  { t: '2026-09-30T12:29:59Z', lat: 39.6, lon: 22.4, radiance: null },
  { t: '2026-09-30T12:22:00Z', lat: 4.5, lon: 3.2, radiance: 10 },
];

function payloadOf(attempt: DecodeAttempt): Payload {
  if (!attempt.ok) throw new Error(`expected a payload, got a refusal: ${attempt.reason}`);
  return attempt.payload;
}

function reasonOf(attempt: DecodeAttempt): string {
  if (attempt.ok) throw new Error('expected a refusal');
  return attempt.reason;
}

describe('the child and the core agree', () => {
  it('on the payload format, the window tolerance, and the source/kind', () => {
    expect(PAYLOAD_FORMAT).toBe(LIGHTNING_PAYLOAD_FORMAT);
    expect(WINDOW_TOLERANCE_MS).toBe(LIGHTNING_WINDOW_TOLERANCE_MS);
    expect(LIGHTNING_SOURCE).toBe(PORT_SOURCE);
    expect(LIGHTNING_KIND).toBe(PORT_KIND);
    expect(REF_ENV).toBe(GRANULE_REF_ENV);
    expect(REASON_PREFIX).toBe(DECODER_REASON_PREFIX);
    expect(EXIT_REFUSED).toBe(DECODER_REFUSED_EXIT);
  });

  it('on the variable names of EUM/MTG/SPE/10/0452 A.6', () => {
    expect(Object.values(LFL_VARIABLES).map((v) => v.name)).toEqual([
      'flash_time',
      'latitude',
      'longitude',
      'radiance',
      'flash_duration',
      'flash_footprint',
    ]);
  });
});

describe('sniff and parseWindow', () => {
  it('tells HDF5 from netCDF classic from anything else', () => {
    expect(sniff(new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('hdf5');
    expect(sniff(new TextEncoder().encode('CDF\x01'))).toBe('netcdf-classic');
    expect(sniff(new Uint8Array([1, 2]))).toBe('unknown');
  });

  it.each([
    '2026-09-30T12:20:09Z',
    'a/b',
    '2026-09-30T12:30:09Z/2026-09-30T12:20:09Z',
    '2026-09-30T12:20:09+01:00/2026-09-30T12:30:09Z',
  ])('refuses the window %j', (slot) => {
    expect(parseWindow(slot)).toBeNull();
  });
});

describe('decodeLflBody', () => {
  it('decodes flash time, CF-scaled position and the optional fields', async () => {
    const payload = payloadOf(await decodeLflBody(REF, await buildLflBody(FLASHES)));
    expect(payload.window).toEqual({
      start: '2026-09-30T12:20:09.000Z',
      end: '2026-09-30T12:30:09.000Z',
    });
    expect(payload.flashes).toHaveLength(4);
    const [first, , third] = payload.flashes;
    expect(first?.t).toBe('2026-09-30T12:21:00.250Z');
    // Packed at 0.00275°, so the round trip is within half a step.
    expect(Math.abs(first!.lat - 42.7)).toBeLessThanOrEqual(0.001375);
    expect(Math.abs(first!.lon - 23.3)).toBeLessThanOrEqual(0.001375);
    expect(first?.radiance).toBeCloseTo(120.5, 1);
    expect(first?.durationMs).toBe(180);
    expect(first?.footprint).toBe(12);
    expect(third?.radiance).toBeNull();
    expect(payload.decoder).toMatchObject({ flashes: 4, clippedOut: 0, droppedWithoutPosition: 0 });
  });

  it('clips to a box in the child and counts what it clipped', async () => {
    const payload = payloadOf(
      await decodeLflBody(REF, await buildLflBody(FLASHES), { clip: POLLING_BBOX.values }),
    );
    expect(payload.flashes).toHaveLength(3);
    expect(payload.decoder.clippedOut).toBe(1);
  });

  it('drops a flash with a fill position or no time, and counts each', async () => {
    const payload = payloadOf(
      await decodeLflBody(
        REF,
        await buildLflBody([
          ...FLASHES.slice(0, 3),
          { t: '2026-09-30T12:23:00Z', lat: null, lon: 23 },
          { t: null, lat: 42, lon: 23 },
        ]),
      ),
    );
    expect(payload.flashes).toHaveLength(3);
    expect(payload.decoder.droppedWithoutPosition).toBe(1);
    expect(payload.decoder.droppedWithoutTime).toBe(1);
  });

  it('drops a stray flash outside the window, but refuses a file whose times are mostly elsewhere', async () => {
    const onlyOneStray = payloadOf(
      await decodeLflBody(
        REF,
        await buildLflBody([
          ...FLASHES,
          ...FLASHES,
          ...FLASHES,
          { t: '2026-09-30T13:00:00Z', lat: 42, lon: 23 },
        ]),
      ),
    );
    expect(onlyOneStray.decoder.droppedOutsideWindow).toBe(1);

    const wrongHour = FLASHES.map((f) => ({ ...f, t: '2026-09-30T14:25:00Z' }));
    expect(reasonOf(await decodeLflBody(REF, await buildLflBody(wrongHour)))).toMatch(
      /4 of 4 flash times fall outside the window/,
    );
  });

  it('keeps a flash within the tolerance of the window edge', async () => {
    const payload = payloadOf(
      await decodeLflBody(
        REF,
        await buildLflBody([{ t: '2026-09-30T12:31:30Z', lat: 42, lon: 23 }]),
      ),
    );
    expect(payload.flashes).toHaveLength(1);
  });

  it('refuses a missing required variable and names what the root does have', async () => {
    const reason = reasonOf(
      await decodeLflBody(
        REF,
        await buildLflBody(FLASHES, { omit: ['latitude'], extra: ['lat_pixel'] }),
      ),
    );
    expect(reason).toMatch(/required variable latitude is absent; root has \[/);
    expect(reason).toContain('lat_pixel');
    expect(reason).toContain('flash_time');
  });

  it('decodes without the optional variables, as nulls', async () => {
    const payload = payloadOf(
      await decodeLflBody(
        REF,
        await buildLflBody(FLASHES, { omit: ['radiance', 'flash_duration', 'flash_footprint'] }),
      ),
    );
    expect(payload.flashes[0]).toMatchObject({ radiance: null, durationMs: null, footprint: null });
  });

  it('refuses units that are not the specified ones, quoting what it found', async () => {
    expect(
      reasonOf(
        await decodeLflBody(
          REF,
          await buildLflBody(FLASHES, {
            units: { flash_time: 'seconds since 1970-01-01 00:00:00' },
          }),
        ),
      ),
    ).toMatch(/flash_time units are "seconds since 1970-01-01 00:00:00"/);
    expect(
      reasonOf(
        await decodeLflBody(REF, await buildLflBody(FLASHES, { units: { longitude: null } })),
      ),
    ).toBe('longitude has no units attribute');
    expect(
      reasonOf(
        await decodeLflBody(REF, await buildLflBody(FLASHES, { units: { radiance: 'W m-2' } })),
      ),
    ).toMatch(/radiance units are "W m-2"/);
  });

  it('refuses a variable of another type than specified', async () => {
    expect(
      reasonOf(await decodeLflBody(REF, await buildLflBody(FLASHES, { latitudeAsFloat: true }))),
    ).toBe('latitude is a 32-bit float, specified as a signed 16-bit integer');
  });

  it('refuses a ref it does not decode, a malformed window and a non-HDF5 file', async () => {
    const bytes = await buildLflBody(FLASHES);
    expect(
      reasonOf(await decodeLflBody({ ...REF, source: 'lsasaf:seviri:frp-pixel' }, bytes)),
    ).toMatch(/is not decoded by h5wasm-mtg-li-lfl/);
    expect(reasonOf(await decodeLflBody({ ...REF, slotIso: 'x' }, bytes))).toMatch(/ref window/);
    expect(reasonOf(await decodeLflBody(REF, new TextEncoder().encode('CDF\x02 ...')))).toMatch(
      /netCDF classic/,
    );
    expect(reasonOf(await decodeLflBody(REF, new Uint8Array(64)))).toBe(
      'file does not start with the HDF5 signature',
    );
  });
});

describe('the MTG LI decoder, across the wall', () => {
  const decoder = createMtgLiDecoder({
    entry: ENTRY,
    timeoutMs: CHILD_TIMEOUT_MS,
    clip: POLLING_BBOX.values,
  });

  it('turns a synthetic LFL BODY into a clipped payload the core parser accepts', async () => {
    const result = await decoder.decode(REF, await buildLflBody(FLASHES));
    expect(result.error).toBeNull();
    expect(result.outcome).toBe('ok');
    const read = parseLightningPayload(REF, result.payload ?? '');
    expect(read.ok && read.flashes).toHaveLength(3);
    expect(read.ok && read.counts).toMatchObject({ flashes: 4, clippedOut: 1 });
  }, 30_000);

  it('reports a layout refusal as refused, with the named reason', async () => {
    const result = await decoder.decode(REF, await buildLflBody(FLASHES, { omit: ['flash_time'] }));
    expect(result.outcome).toBe('refused');
    expect(result.error).toMatch(/required variable flash_time is absent/);
  }, 30_000);

  it('refuses bytes that are not a file', async () => {
    const result = await decoder.decode(REF, new TextEncoder().encode('<html>login</html>'));
    expect(result.outcome).toBe('refused');
    expect(result.error).toMatch(/HDF5 signature/);
  }, 30_000);
});
