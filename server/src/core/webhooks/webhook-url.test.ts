import { describe, expect, it } from 'vitest';

import { WEBHOOK_PARAMS } from '../config/webhook-params.js';
import { allAddressesPublic, isPublicAddress, validateWebhookUrl } from './webhook-url.js';

const RULES = WEBHOOK_PARAMS.values;

function reason(raw: string): string {
  const check = validateWebhookUrl(raw, RULES);
  return check.ok ? 'ok' : check.reason;
}

describe('validateWebhookUrl', () => {
  it('accepts a public https URL and normalises it', () => {
    expect(validateWebhookUrl('https://Hooks.Example.com./fire?x=1', RULES)).toEqual({
      ok: true,
      href: 'https://hooks.example.com./fire?x=1',
      host: 'hooks.example.com',
      ipLiteral: false,
    });
    expect(reason('https://hooks.example.com:443/fire')).toBe('ok');
  });

  it('refuses anything but https', () => {
    expect(reason('http://hooks.example.com/')).toBe('not_https');
    expect(reason('ftp://hooks.example.com/')).toBe('not_https');
    expect(reason('file:///etc/passwd')).toBe('not_https');
    expect(reason('not a url')).toBe('malformed');
  });

  it('refuses credentials, fragments, other ports and over-long URLs', () => {
    expect(reason('https://user:pw@hooks.example.com/')).toBe('credentials');
    expect(reason('https://hooks.example.com/#x')).toBe('fragment');
    expect(reason('https://hooks.example.com:8443/')).toBe('port');
    expect(reason(`https://hooks.example.com/${'a'.repeat(RULES.maxUrlLength)}`)).toBe('too_long');
  });

  it('refuses internal names and single-label hosts', () => {
    for (const host of [
      'localhost',
      'api.localhost',
      'printer.local',
      'metadata.google.internal',
      'nas.lan',
      'router.home.arpa',
      'x.onion',
      'intranet',
      'a.test',
    ]) {
      expect(reason(`https://${host}/`), host).toBe('host');
    }
    // A numeric last label: the URL parser refuses it before the name rules see it.
    expect(reason('https://foo.123/')).not.toBe('ok');
  });

  it('refuses private, loopback, link-local and metadata IP literals in every spelling', () => {
    for (const raw of [
      'https://127.0.0.1/',
      'https://2130706433/',
      'https://0x7f.0.0.1/',
      'https://10.0.0.5/',
      'https://172.16.3.4/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/',
      'https://0.0.0.0/',
      'https://[::1]/',
      'https://[::]/',
      'https://[fe80::1]/',
      'https://[fc00::1]/',
      'https://[fd00:ec2::254]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:169.254.169.254]/',
      'https://[64:ff9b::a9fe:a9fe]/',
      'https://[2001:db8::1]/',
    ]) {
      expect(reason(raw), raw).toBe('private_address');
    }
  });

  it('accepts a public IP literal', () => {
    expect(validateWebhookUrl('https://93.184.216.34/hook', RULES)).toMatchObject({
      ok: true,
      ipLiteral: true,
    });
    expect(reason('https://[2606:4700:4700::1111]/')).toBe('ok');
  });
});

describe('isPublicAddress', () => {
  it('judges IPv4 by the special-purpose registry', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('100.63.255.255')).toBe(true);
    for (const ip of [
      '0.1.2.3',
      '10.1.1.1',
      '100.127.0.1',
      '127.0.0.53',
      '169.254.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('judges IPv6 by global unicast and the embedded IPv4 of mapped forms', () => {
    expect(isPublicAddress('2a00:1450:4001:80b::200e')).toBe(true);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    for (const ip of ['::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '2002:7f00:1::', '2001::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('is false for anything that is not an address', () => {
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('1.2.3')).toBe(false);
    expect(isPublicAddress('1.2.3.256')).toBe(false);
    expect(isPublicAddress('1::2::3')).toBe(false);
  });
});

describe('allAddressesPublic', () => {
  it('needs at least one address and every address public', () => {
    expect(allAddressesPublic([])).toBe(false);
    expect(allAddressesPublic(['8.8.8.8', '2606:4700:4700::1111'])).toBe(true);
    expect(allAddressesPublic(['8.8.8.8', '10.0.0.1'])).toBe(false);
  });
});
