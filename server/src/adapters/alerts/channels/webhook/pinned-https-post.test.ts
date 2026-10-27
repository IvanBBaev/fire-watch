import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createPinnedHttpsPoster } from './pinned-https-post.js';

/** Never resolves in DNS (RFC 6761 `.invalid`): a request reaching the server was pinned. */
const UNRESOLVABLE = 'hooks.fire-watch-test.invalid';

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open !== undefined) {
    open.closeAllConnections();
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
});

interface Seen {
  host: string | undefined;
  path: string | undefined;
  body: string;
}

async function listen(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const post = createPinnedHttpsPoster(httpRequest);

describe('createPinnedHttpsPoster', () => {
  it('connects to the pinned address and keeps the name in the Host header', async () => {
    const seen: Seen[] = [];
    const port = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ host: req.headers.host, path: req.url, body });
        res.writeHead(204).end();
      });
    });

    const result = await post({
      href: `http://${UNRESOLVABLE}:${String(port)}/in/path?x=1`,
      address: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 2_000,
    });

    expect(result).toEqual({ status: 204 });
    expect(seen).toEqual([
      { host: `${UNRESOLVABLE}:${String(port)}`, path: '/in/path?x=1', body: '{"a":1}' },
    ]);
  });

  it('answers on the status line without waiting for a body that never ends', async () => {
    const port = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('x'.repeat(64 * 1024)); // and never `end()`
      });
    });

    const result = await post({
      href: `http://${UNRESOLVABLE}:${String(port)}/`,
      address: '127.0.0.1',
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ status: 200 });
  });

  it('reports a redirect as its status and does not follow it', async () => {
    let hits = 0;
    const port = await listen((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(302, { location: 'http://127.0.0.1/elsewhere' }).end();
    });

    const result = await post({
      href: `http://${UNRESOLVABLE}:${String(port)}/`,
      address: '127.0.0.1',
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ status: 302 });
    expect(hits).toBe(1);
  });

  it('times out when no headers arrive', async () => {
    const port = await listen((req) => {
      req.resume(); // and never answer
    });

    const result = await post({
      href: `http://${UNRESOLVABLE}:${String(port)}/`,
      address: '127.0.0.1',
      headers: {},
      body: '{}',
      timeoutMs: 100,
    });
    expect(result).toEqual({ error: 'TimeoutError: no response headers within 100 ms' });
  });

  it('resolves a connection failure as an error instead of throwing', async () => {
    const port = await listen((_req, res) => res.end());
    const open = server;
    server = undefined;
    await new Promise<void>((resolve) => open?.close(() => resolve()));

    const result = await post({
      href: `http://${UNRESOLVABLE}:${String(port)}/`,
      address: '127.0.0.1',
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('ECONNREFUSED') as string });
  });
});
