// バイナリの Response をラップしても、セッション延長の Cookie が1本だけ残る。
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commonDb } from '../src/server/db/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { download, expectDownloadHeaders, storedFile } from './attachment-download-helpers.ts';
import { createSessionWithToken } from './factories.ts';
import { createTarget, testEnv } from './operations/world.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => vi.useRealTimers());

describe.each(['https://guild.example', 'http://127.0.0.1:5173'])('配信時の Cookie（%s）', (origin) => {
  test.each([200, 206])('%s の応答でも延長の Cookie とファイルのヘッダーを保つ', async (status) => {
    const target = await createTarget();
    const clock = Date.now();
    const old = new Date(clock - 2 * 60 * 60 * 1000).toISOString();
    const session = await createSessionWithToken(target.member.accountId, {
      created_at: old,
      last_used_at: old,
      expires_at: new Date(clock + 60 * 60 * 1000).toISOString(),
    });
    const person = { ...target.member, token: session.token };
    const { row, bytes } = await storedFile(target, { contentType: 'video/mp4' });
    const bindings = Object.assign({}, testEnv, { PUBLIC_ORIGIN: origin });
    const started = Date.now();
    const response = await download(target, row.id, {
      person,
      env: bindings,
      headers: status === 206 ? { Range: 'bytes=2-5' } : {},
    });
    const ended = Date.now();
    expect(response.status).toBe(status);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(`${sessionCookieName(origin)}=${session.token};`);
    expect(cookies[0]).toContain('Max-Age=2592000');
    expect(cookies[0]).toContain('Path=/');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');
    expect(cookies[0]!.includes('; Secure')).toBe(origin.startsWith('https:'));
    expect(cookies[0]).not.toContain('Domain=');
    expect(cookies[0]).not.toContain('Max-Age=0');
    expectDownloadHeaders(response);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Length')).toBe(String(status === 206 ? 4 : bytes.byteLength));
    expect(response.headers.get('Content-Range')).toBe(status === 206 ? `bytes 2-5/${bytes.byteLength}` : null);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(status === 206 ? bytes.subarray(2, 6) : bytes);
    const db = commonDb(env);
    const updated = await db.first(
      db.statement((q) =>
        q
          .selectFrom('sessions')
          .select(['created_at', 'last_used_at', 'expires_at'])
          .where('token_hash', '=', session.row.token_hash),
      ),
    );
    expect(updated?.created_at).toBe(old);
    const refreshed = Date.parse(updated!.last_used_at);
    expect(refreshed).toBeGreaterThanOrEqual(started);
    expect(refreshed).toBeLessThanOrEqual(ended);
    expect(Date.parse(updated!.expires_at)).toBe(refreshed + 30 * DAY_MS);
  });

  test('1時間たっていないセッションの Cookie は出し直さない', async () => {
    // ファクトリーの固定の有効期限を過ぎても、このテストが期限切れで落ちないようにする。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    const target = await createTarget();
    const used = new Date().toISOString();
    const session = await createSessionWithToken(target.member.accountId, {
      last_used_at: used,
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    const { row } = await storedFile(target);
    const bindings = Object.assign({}, testEnv, { PUBLIC_ORIGIN: origin });
    const response = await download(target, row.id, {
      person: { ...target.member, token: session.token },
      env: bindings,
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    await response.arrayBuffer();
    const db = commonDb(env);
    expect(
      await db.first(
        db.statement((q) =>
          q.selectFrom('sessions').select('last_used_at').where('token_hash', '=', session.row.token_hash),
        ),
      ),
    ).toEqual({ last_used_at: used });
  });
});
