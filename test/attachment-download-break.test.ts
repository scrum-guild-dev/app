// #745: 先行テストにない、HEAD・入力のすり替え・権限取消とエラー応答の境界。
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { download, expectDownloadHeaders, expectSafeDisposition, storedFile } from './attachment-download-helpers.ts';
import { app, recordingBucket } from './attachment-helpers.ts';
import { createMembership } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createPerson, createTarget, testEnv, type Target } from './operations/world.ts';

function head(target: Target, id: string, bindings: Env, extra: Record<string, string> = {}) {
  return app.request(
    `/api/${target.slug}/attachments/${id}`,
    {
      method: 'HEAD',
      headers: {
        Cookie: `${sessionCookieName(bindings.PUBLIC_ORIGIN)}=${target.member.token}`,
        ...extra,
      },
    },
    bindings,
  );
}

function expectNoStore(response: Response) {
  expect(
    response.headers
      .get('Cache-Control')
      ?.split(',')
      .map((part) => part.trim()),
  ).toEqual(expect.arrayContaining(['private', 'no-store']));
}

describe('HEAD の取得と認可', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each(['bytes=2-4', 'bytes=999999-', 'bytes=1-2,4-5'])('HEAD の %s は全体のメタデータだけ', async (range) => {
    const { row, bytes } = await storedFile(target, { contentType: 'video/mp4' });
    const { env: bindings, calls } = recordingBucket({
      get: () => {
        throw new Error('HEAD では本文を取得しない');
      },
    });
    const response = await head(target, row.id, bindings, { Range: range });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expectSafeDisposition(response, row.file_name, 'inline');
    expectDownloadHeaders(response);
    expectNoStore(response);
    expect(calls).toEqual([{ method: 'head', key: row.object_key }]);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('HEAD でも R2 の消えたオブジェクトは 404 で、本文を取得しない', async () => {
    const { row } = await storedFile(target);
    await env.ATTACHMENTS.delete(row.object_key);
    const { env: bindings, calls } = recordingBucket();
    const response = await head(target, row.id, bindings);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expectDownloadHeaders(response);
    expect(calls).toEqual([{ method: 'head', key: row.object_key }]);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('HEAD の権限拒否と異オリジン拒否は R2 に触れない', async () => {
    const { row } = await storedFile(target, { person: target.leader });
    const { env: bindings, calls } = recordingBucket();
    for (const [headers, expected] of [
      [{}, 404],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
    ] as const) {
      const response = await head(target, row.id, bindings, headers);
      expect(response.status).toBe(expected);
      expectDownloadHeaders(response);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
    expect(calls).toEqual([]);
  });
});

describe('入力と認証のすり替えを断る', () => {
  test('URL の ID をクエリと X-Operation-Input の自分の ID で上書きできない', async () => {
    const target = await createTarget();
    const own = await storedFile(target);
    const other = await storedFile(target, { person: target.leader });
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, `${other.row.id}?id=${own.row.id}`, {
      env: bindings,
      headers: { 'X-Operation-Input': encodeURIComponent(JSON.stringify({ id: own.row.id })) },
    });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(calls).toEqual([]);
  });

  test('GET の長すぎるパス ID は入力として検証し、R2 に触れない', async () => {
    const target = await createTarget();
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, 'a'.repeat(65), { env: bindings });
    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('invalid_input');
    expect(calls).toEqual([]);
    expectDownloadHeaders(response);
  });

  test.each(['not-a-token', ''])('無効な Bearer %j は有効な Cookie にフォールバックしない', async (bearer) => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, { bearer, env: bindings });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(calls).toEqual([]);
    expectDownloadHeaders(response);
    expectNoStore(response);
  });

  test('有効な Bearer と Cookie の併記でも Cookie 専用の配信を許可しない', async () => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, {
      bearer: await bearerFor(target.member, 'write'),
      env: bindings,
    });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('Origin が一致していても Fetch Metadata が same-site なら拒否する', async () => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, {
      env: bindings,
      headers: { Origin: new URL(testEnv.PUBLIC_ORIGIN).origin, 'Sec-Fetch-Site': 'same-site' },
    });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
    expect(calls).toEqual([]);
  });

  test('退会済みの所属しか残っていなければ本人の未添付も拒否する', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization });
    await createMembership(target.organization, target.workspace.id, person.userId!, {
      left_at: '2026-11-01T00:00:00.000Z',
      left_on: '2026-11-01',
    });
    const { row } = await storedFile(target, { person });
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, { person, env: bindings });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(calls).toEqual([]);
  });

  test('所有者の行でも R2 キーの組織・workspace・ID が一致しなければ配信しない', async () => {
    const target = await createTarget();
    for (const object_key of [
      `${crypto.randomUUID()}/${target.workspace.id}/${crypto.randomUUID()}`,
      `${target.organization.id}/${target.otherWorkspace.id}/${crypto.randomUUID()}`,
      `${target.organization.id}/${target.workspace.id}/${crypto.randomUUID()}`,
    ]) {
      const { row } = await storedFile(target, { row: { object_key } });
      const { env: bindings, calls } = recordingBucket();
      const response = await download(target, row.id, { env: bindings });
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('not_found');
      expect(calls).toEqual([]);
    }
  });
});

describe('Range と失敗の応答', () => {
  let target: Target;
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each(['items=0-1', 'unknown', 'frames=not-a-range'])(
    '未知の Range 単位 %s は全体の 200 として返す',
    async (range) => {
      const { row } = await storedFile(target, { contentType: 'video/webm', file: bytes });
      const response = await download(target, row.id, { headers: { Range: range } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(response.headers.get('Content-Length')).toBe('8');
      expectNoStore(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  test('空の If-Range でも範囲を使わず、不正 Range に 416 を返さない', async () => {
    const { row } = await storedFile(target, { contentType: 'video/webm', file: bytes });
    const response = await download(target, row.id, { headers: { Range: 'bytes=99-', 'If-Range': '' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test.each(['bytes=+1-2', 'bytes=0-1,', 'bytes=--1', 'bytes=NaN-', 'bytes=1e0-2'])(
    '不正な bytes Range %s は本文やファイル名を含まない JSON 416',
    async (range) => {
      const { row } = await storedFile(target, { contentType: 'video/mp4', file: bytes, fileName: '秘匿動画.mp4' });
      const { env: bindings, calls } = recordingBucket();
      const response = await download(target, row.id, { env: bindings, headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(response.headers.get('Content-Disposition')).toBeNull();
      expect(response.headers.get('Content-Range')).toBe('bytes */8');
      expect(await errorCodeOf(response)).toBe('invalid_input');
      expect(calls).toEqual([{ method: 'head', key: row.object_key }]);
      expectDownloadHeaders(response);
      expectNoStore(response);
    },
  );

  test('非動画の不正な bytes Range は 416 にせず全体を返す', async () => {
    const { row } = await storedFile(target, { contentType: 'application/pdf', file: bytes });
    const response = await download(target, row.id, { headers: { Range: 'bytes=1-2,4-5' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Accept-Ranges')).toBeNull();
    expectNoStore(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test('R2 に Range 取得直前でオブジェクトがなくなっても 404 を返す', async () => {
    const { row } = await storedFile(target, { contentType: 'video/mp4', file: bytes });
    const { env: bindings, calls } = recordingBucket({ get: () => null });
    const response = await download(target, row.id, { env: bindings, headers: { Range: 'bytes=1-2' } });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['head', 'get']);
    expectDownloadHeaders(response);
    expectNoStore(response);
  });
});
