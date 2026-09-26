import { describe, expect, it } from 'vitest';

import { amzDateOf, awsUriEncode, signRequest } from './sigv4.js';

/**
 * The credentials AWS's signing examples are written with. The general SigV4 guide and
 * the S3 guide use secrets that differ by one character (`+` vs `/`); each vector below
 * uses the one its source document prints.
 */
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SIGV4_GUIDE_CREDENTIALS = {
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const S3_GUIDE_CREDENTIALS = {
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('signRequest', () => {
  it('reproduces the AWS "Signing AWS requests" IAM ListUsers example', () => {
    // docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html — the worked
    // example whose canonical-request hash, string to sign and signature are printed.
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: '',
      },
      {
        credentials: SIGV4_GUIDE_CREDENTIALS,
        region: 'us-east-1',
        service: 'iam',
        now: Date.UTC(2015, 7, 30, 12, 36, 0),
      },
    );

    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers.host).toBe('iam.amazonaws.com');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('reproduces the S3 "GET Object" example, which signs a range and a payload hash', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, example 1.
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: {
          Range: 'bytes=0-9',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        body: '',
      },
      {
        credentials: S3_GUIDE_CREDENTIALS,
        region: 'us-east-1',
        service: 's3',
        now: Date.UTC(2013, 4, 24, 0, 0, 0),
      },
    );

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs the body: a different payload is a different signature', () => {
    const request = {
      method: 'POST' as const,
      url: new URL('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails'),
      headers: { 'content-type': 'application/json' },
    };
    const context = {
      credentials: SIGV4_GUIDE_CREDENTIALS,
      region: 'eu-central-1',
      service: 'ses',
      now: Date.UTC(2026, 8, 18, 10, 0, 0),
    };
    const a = signRequest({ ...request, body: '{"a":1}' }, context);
    const b = signRequest({ ...request, body: '{"a":2}' }, context);
    expect(a.authorization).not.toBe(b.authorization);
    expect(a.authorization).toContain('SignedHeaders=content-type;host;x-amz-date,');
    // The secret never appears in what goes on the wire.
    expect(JSON.stringify(a)).not.toContain(SIGV4_GUIDE_CREDENTIALS.secretAccessKey);
  });
});

describe('amzDateOf', () => {
  it('is ISO 8601 basic, UTC, second precision', () => {
    expect(amzDateOf(Date.UTC(2026, 8, 18, 10, 5, 7, 999))).toBe('20260918T100507Z');
  });
});

describe('awsUriEncode', () => {
  it('encodes what RFC 3986 reserves and encodeURIComponent forgives', () => {
    expect(awsUriEncode("a b!'()*~-_.", false)).toBe('a%20b%21%27%28%29%2A~-_.');
    expect(awsUriEncode('x/y', false)).toBe('x%2Fy');
    expect(awsUriEncode('x/y', true)).toBe('x/y');
  });
});
