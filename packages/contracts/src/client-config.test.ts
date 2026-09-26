import { describe, expect, it } from 'vitest';

import {
  CLIENT_POLL_INTERVAL_MAX_MS,
  CLIENT_POLL_INTERVAL_MIN_MS,
  CLIENT_TRANSPORTS,
  IMAGERY_API_KEY_MAX_LENGTH,
  isClientImageryBlock,
  isClientTransport,
  isImageryApiKey,
  isImageryTileUrlTemplate,
} from './client-config.js';

describe('client transport', () => {
  it('knows exactly the two tiers the document can name', () => {
    expect(CLIENT_TRANSPORTS).toEqual(['poll', 'sse']);
    expect(isClientTransport('poll')).toBe(true);
    expect(isClientTransport('sse')).toBe(true);
    expect(isClientTransport('static')).toBe(false);
    expect(isClientTransport(undefined)).toBe(false);
  });
});

describe('poll interval bounds', () => {
  it('leave room for the default cadence on both sides', () => {
    // 45 s is what the web client ships with; the bounds must admit it or the document
    // could never restate the default.
    expect(CLIENT_POLL_INTERVAL_MIN_MS).toBeLessThan(45_000);
    expect(CLIENT_POLL_INTERVAL_MAX_MS).toBeGreaterThan(45_000);
    expect(CLIENT_POLL_INTERVAL_MAX_MS).toBe(1_800_000);
  });
});

describe('imagery block', () => {
  const TEMPLATE = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}';
  const KEY = 'AAPK.abc-123_x~y';

  it('accepts an https template with every placeholder and a URL-safe key', () => {
    expect(isClientImageryBlock({ tile_url_template: TEMPLATE, api_key: KEY })).toBe(true);
    // A template with its own query string is fine; the client appends `token` to it.
    expect(isImageryTileUrlTemplate(`${TEMPLATE}?blankTile=false`)).toBe(true);
  });

  it('refuses a template that cannot address a tile or would leak mixed content', () => {
    expect(isImageryTileUrlTemplate('https://tiles.example.test/{z}/{x}')).toBe(false);
    expect(isImageryTileUrlTemplate('http://tiles.example.test/{z}/{y}/{x}')).toBe(false);
    expect(isImageryTileUrlTemplate('not a url {z}{x}{y}')).toBe(false);
    expect(isImageryTileUrlTemplate(`${TEMPLATE}#frag`)).toBe(false);
    expect(isImageryTileUrlTemplate(42)).toBe(false);
  });

  it('refuses a template that already carries a token, since the key travels on its own', () => {
    expect(isImageryTileUrlTemplate(`${TEMPLATE}?token=abc`)).toBe(false);
  });

  it('refuses a key that is empty, too long, or could rewrite the URL it is appended to', () => {
    expect(isImageryApiKey('')).toBe(false);
    expect(isImageryApiKey('a&b=c')).toBe(false);
    expect(isImageryApiKey('a b')).toBe(false);
    expect(isImageryApiKey('a'.repeat(IMAGERY_API_KEY_MAX_LENGTH))).toBe(true);
    expect(isImageryApiKey('a'.repeat(IMAGERY_API_KEY_MAX_LENGTH + 1))).toBe(false);
  });

  it('refuses anything that is not a plain object with both members', () => {
    expect(isClientImageryBlock(null)).toBe(false);
    expect(isClientImageryBlock([])).toBe(false);
    expect(isClientImageryBlock({ tile_url_template: TEMPLATE })).toBe(false);
    expect(isClientImageryBlock({ api_key: KEY })).toBe(false);
  });
});
