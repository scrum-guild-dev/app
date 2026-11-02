// wrangler.jsonc の R2 binding を Workers のテスト環境が模擬することを確かめる
import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';

test('ATTACHMENTS に保存したファイルを読み戻せる', async () => {
  const key = `${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  const body = '添付ファイルの中身';
  try {
    await env.ATTACHMENTS.put(key, body);
    const object = await env.ATTACHMENTS.get(key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe(body);
  } finally {
    await env.ATTACHMENTS.delete(key);
  }
});
