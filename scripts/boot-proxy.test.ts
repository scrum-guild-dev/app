import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { bootProxy } from './boot-proxy.ts';

test('ブラウザへ圧縮後のバイト列を送り、CookieとOriginとPOSTをAPIへ渡す', async () => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.headers.cookie, 'fixture=public');
    assert.equal(request.headers.origin, 'http://127.0.0.1');
    if (request.url === '/api/example') {
      assert.equal(request.method, 'POST');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), '{}');
    }
    response.setHeader('content-type', 'text/css');
    response.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    response.end('.sample{color:red}'.repeat(100));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = bootProxy((upstream.address() as AddressInfo).port);
  try {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const result = await new Promise<{ data: Buffer; encoding: string | undefined; cookies: string[] | undefined }>(
      (resolve, reject) => {
        const request = get(
          `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/style.css`,
          {
            headers: { 'accept-encoding': 'gzip', cookie: 'fixture=public', origin: 'http://127.0.0.1' },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                data: Buffer.concat(chunks),
                encoding: response.headers['content-encoding'],
                cookies: response.headers['set-cookie'],
              }),
            );
          },
        );
        request.on('error', reject);
      },
    );
    assert.equal(result.encoding, 'gzip');
    assert.ok(result.data.length < 100);
    assert.equal(gunzipSync(result.data).toString(), '.sample{color:red}'.repeat(100));
    assert.deepEqual(result.cookies, ['a=1; Path=/', 'b=2; Path=/']);
    const post = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/example`, {
      method: 'POST',
      headers: { cookie: 'fixture=public', origin: 'http://127.0.0.1' },
      body: '{}',
    });
    assert.equal(post.status, 200);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});

test('origin-form以外のリクエスト先は上流fetchより前に400で拒否する', async () => {
  const proxy = bootProxy(1);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response('unexpected upstream');
  };
  try {
    for (const target of ['@example.invalid/', 'http://example.invalid/', '//example.invalid/']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        get({ hostname: '127.0.0.1', port: (proxy.address() as AddressInfo).port, path: target }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }).on('error', reject);
      });
      assert.equal(status, 400, target);
    }
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test('非テキストとgzip非対応は圧縮せず、3xxと上流切断をそのまま判定できる', async () => {
  const binary = Buffer.from([0, 255, 1, 254]);
  const upstream = createServer((request, response) => {
    if (request.url === '/disconnect') {
      request.socket.destroy();
      return;
    }
    if (request.url === '/redirect') {
      response.statusCode = 302;
      response.setHeader('location', '/destination');
    }
    response.setHeader('content-type', request.url === '/font' ? 'font/woff2' : 'text/css');
    response.end(request.url === '/font' ? binary : 'sample');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = bootProxy((upstream.address() as AddressInfo).port);
  try {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    for (const [route, encoding, status] of [
      ['/font', 'gzip', 200],
      ['/style', '', 200],
      ['/redirect', '', 302],
      ['/disconnect', '', 502],
    ] as const) {
      const result = await new Promise<{
        status: number | undefined;
        encoding: string | undefined;
        location: string | undefined;
        body: Buffer;
      }>((resolve, reject) => {
        get(
          {
            hostname: '127.0.0.1',
            port: (proxy.address() as AddressInfo).port,
            path: route,
            headers: { 'accept-encoding': encoding },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode,
                encoding: response.headers['content-encoding'],
                location: response.headers.location,
                body: Buffer.concat(chunks),
              }),
            );
          },
        ).on('error', reject);
      });
      assert.equal(result.status, status);
      assert.equal(result.encoding, undefined);
      if (route === '/font') assert.deepEqual(result.body, binary);
      if (route === '/redirect') assert.equal(result.location, '/destination');
      if (route === '/disconnect') assert.equal(result.body.toString(), 'boot bench upstream failed');
    }
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
