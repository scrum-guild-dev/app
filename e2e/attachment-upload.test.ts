// 添付ファイルを上げる操作（attachment-upload。#744）を、本番と同じ配り方のサーバーへ直に呼ぶ。
// seed のセッション（seed/sessions.ts）の Cookie で、あおば開発の受託開発チームの一般のメンバー（ハルカ）として上げる。
// 入力はヘッダー X-Operation-Input、本文はファイルのバイトで、種類は申告ではなく先頭のバイトで決まる。上げる画面はまだ無い
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

// seed/data.sql の受託開発チーム
const WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

// PNG の印と IHDR の箱の先頭
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

function uploadHeaders(baseURL: string | undefined, input: unknown, contentType: string): Record<string, string> {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  return {
    Origin: new URL(baseURL).origin,
    'X-Operation-Input': encodeURIComponent(JSON.stringify(input)),
    'Content-Type': contentType,
  };
}

test('メンバーが小さな PNG を上げると 200 で、content_type は image/png', async ({ page, baseURL }) => {
  const res = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
    headers: uploadHeaders(baseURL, { workspace_id: WORKSPACE_ID, file_name: '画面の案.png' }, 'image/png'),
    data: PNG,
  });
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  expect(attachmentUpload.output.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ file_name: '画面の案.png', content_type: 'image/png', size_bytes: PNG.byteLength });
});

test('png と申告したテキストは application/octet-stream で保存する', async ({ page, baseURL }) => {
  const res = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
    headers: uploadHeaders(baseURL, { workspace_id: WORKSPACE_ID, file_name: '写真.png' }, 'image/png'),
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ content_type: 'application/octet-stream' });
});
