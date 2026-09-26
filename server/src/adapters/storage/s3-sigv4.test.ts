import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  amzDate8601,
  canonicalHeaderMap,
  canonicalQueryString,
  EMPTY_PAYLOAD_SHA256,
  s3CanonicalUri,
  s3UriEncode,
  sha256Hex,
  signS3Request,
} from './s3-sigv4.js';

/**
 * The credentials and instant of the S3 guide's worked examples:
 * docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */
const CONTEXT = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  now: Date.UTC(2013, 4, 24, 0, 0, 0),
};
const HOST = 'examplebucket.s3.amazonaws.com';

describe('signS3Request against the AWS S3 examples', () => {
  it('GET Object', () => {
    const signed = signS3Request(
      {
        method: 'GET',
        host: HOST,
        path: '/test.txt',
        headers: { Range: 'bytes=0-9' },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      CONTEXT,
    );
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        `host:${HOST}`,
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_PAYLOAD_SHA256,
      ].join('\n'),
    );
    expect(signed.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n' +
        '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );
    expect(signed.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(signed.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object, whose key needs encoding and whose body is signed by hash', () => {
    const body = 'Welcome to Amazon S3.';
    expect(sha256Hex(body)).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    const signed = signS3Request(
      {
        method: 'PUT',
        host: HOST,
        path: '/test$file.text',
        headers: {
          Date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        },
        payloadHash: sha256Hex(body),
      },
      CONTEXT,
    );
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(signed.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('GET Bucket Lifecycle, a query parameter with no value', () => {
    const signed = signS3Request(
      {
        method: 'GET',
        host: HOST,
        path: '/',
        query: [['lifecycle', '']],
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      CONTEXT,
    );
    expect(signed.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(signed.signature).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('GET Bucket (list objects), a query sorted by name', () => {
    const signed = signS3Request(
      {
        method: 'GET',
        host: HOST,
        path: '/',
        query: [
          ['prefix', 'J'],
          ['max-keys', '2'],
        ],
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      CONTEXT,
    );
    expect(signed.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
    expect(signed.signature).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('never puts the secret in anything it returns', () => {
    const signed = signS3Request(
      { method: 'HEAD', host: HOST, path: '/a', payloadHash: EMPTY_PAYLOAD_SHA256 },
      CONTEXT,
    );
    expect(JSON.stringify(signed)).not.toContain(CONTEXT.credentials.secretAccessKey);
  });
});

describe('amzDate8601', () => {
  it('is ISO 8601 basic, UTC, second precision', () => {
    expect(amzDate8601(Date.UTC(2026, 8, 18, 10, 5, 7, 999))).toBe('20260918T100507Z');
  });
});

describe('canonicalisation properties', () => {
  it('s3UriEncode emits only unreserved characters and %XX escapes', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(s3UriEncode(text, false)).toMatch(/^(?:[A-Za-z0-9\-_.~]|%[0-9A-F]{2})*$/);
      }),
    );
  });

  it('s3UriEncode round-trips through decodeURIComponent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect(decodeURIComponent(s3UriEncode(text, false))).toBe(text);
        expect(decodeURIComponent(s3UriEncode(text, true))).toBe(text);
      }),
    );
  });

  it('s3UriEncode agrees with encodeURIComponent except for the five it forgives', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        const expected = encodeURIComponent(text).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        expect(s3UriEncode(text, false)).toBe(expected);
      }),
    );
  });

  it('the canonical URI keeps every slash and never normalises dot segments', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'grapheme' }), { maxLength: 6 }), (segments) => {
        const path = `/${segments.join('/')}`;
        const uri = s3CanonicalUri(path);
        expect(uri.split('/').length).toBe(path.split('/').length);
      }),
    );
    expect(s3CanonicalUri('/b/a/../c')).toBe('/b/a/../c');
  });

  it('the canonical query does not depend on parameter order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string(), fc.string()), { maxLength: 8 }),
        fc.integer(),
        (params, seed) => {
          const shuffled = [...params].sort(
            (a, b) => ((a[0].length * 31 + seed) % 7) - ((b[0].length * 31 + seed) % 7),
          );
          expect(canonicalQueryString(shuffled)).toBe(canonicalQueryString(params));
        },
      ),
    );
  });

  it('header names are case-insensitive and values whitespace-normalised', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,15}$/), fc.string(), (name, value) => {
        const upper = canonicalHeaderMap({ [name.toUpperCase()]: `  ${value}  ` });
        const lower = canonicalHeaderMap({ [name.toLowerCase()]: value });
        expect(upper).toEqual(lower);
        const normalised = lower[name.toLowerCase()] ?? '';
        expect(normalised).not.toMatch(/^\s|\s$|\s\s/);
      }),
    );
  });

  it('refuses a header given twice under different cases', () => {
    expect(() => canonicalHeaderMap({ Range: 'a', range: 'b' })).toThrow(/twice/);
  });

  it('the signature changes with the payload hash', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        const sign = (body: string): string =>
          signS3Request(
            { method: 'PUT', host: HOST, path: '/k', payloadHash: sha256Hex(body) },
            CONTEXT,
          ).signature;
        expect(sign(a)).not.toBe(sign(b));
      }),
      { numRuns: 50 },
    );
  });
});
