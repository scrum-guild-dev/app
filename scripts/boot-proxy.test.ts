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
