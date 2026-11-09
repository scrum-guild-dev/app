import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

// wrangler dev のローカル配信は圧縮を保証しない。本番と同じくテキストをgzipで送り、
// ブラウザが圧縮後のバイト列を受け取ってからCDPの帯域制限を受けるようにする。
// 接続先とlistenは呼び出し側が作ったループバックのサーバーだけ。
export function bootProxy(upstreamPort: number) {
  return createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const name of ['content-type', 'cookie', 'origin', 'accept']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await fetch(`http://127.0.0.1:${upstreamPort}${request.url ?? '/'}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks),
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      const type = result.headers.get('content-type') ?? '';
      const compress =
        /text\/|javascript|json|svg|xml/.test(type) && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
      const body = Buffer.from(await result.arrayBuffer());
      for (const [name, value] of result.headers) {
        if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(name))
          response.setHeader(name, value);
      }
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('set-cookie', cookies);
      response.setHeader('cache-control', 'no-store');
      response.setHeader('vary', 'Accept-Encoding');
      if (compress) response.setHeader('content-encoding', 'gzip');
      response.statusCode = result.status;
      response.end(compress ? gzipSync(body) : body);
    } catch {
      response.statusCode = 502;
      response.end('boot bench upstream failed');
    }
  });
}
