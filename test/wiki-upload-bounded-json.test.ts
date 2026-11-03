import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { createTarget } from './operations/world.ts';

afterEach(() => vi.restoreAllMocks());
test('大量の構造を持つJSONはオブジェクトへ展開する前に拒否する', async () => {
  const target = await createTarget();
  const body = '{"files":[' + '{},'.repeat(1_999_999) + '{}]}';
  const parse = JSON.parse;
  let expanded = false;
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (text === body) {
      expanded = true;
      return {};
    }
    return parse(text, reviver);
  });
  const response = await createApp(implementedOperations).request(
    '/api/' + target.slug + '/org-wiki-upload',
    {
      method: 'POST',
      headers: {
        Origin: env.PUBLIC_ORIGIN,
        Cookie: sessionCookieName(env.PUBLIC_ORIGIN) + '=' + target.member.token,
        'Content-Type': 'application/json',
      },
      body,
    },
    env,
  );
  expect(response.status).toBe(400);
  expect(expanded).toBe(false);
});
test('文字列中のJSON記号と引用符・バックスラッシュは構造の上限に数えない', async () => {
  const target = await createTarget();
  const body = '{[,:]}"\\'.repeat(2000);
  const response = await createApp(implementedOperations).request(
    '/api/' + target.slug + '/org-wiki-upload',
    {
      method: 'POST',
      headers: {
        Origin: env.PUBLIC_ORIGIN,
        Cookie: sessionCookieName(env.PUBLIC_ORIGIN) + '=' + target.member.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: [{ file_name: '手順.md', body_md: body }] }),
    },
    env,
  );
  expect(response.status).toBe(200);
});
