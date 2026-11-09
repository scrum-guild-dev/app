// #745: 本番と同じ配り方でアップロードから GET までを通す。手元では走らせず CI で検証する。
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

const WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'member');
});

test('PNG を上げた本人が GET でき、別人の管理者には不存在と同じ 404', async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
  const uploaded = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
    headers: {
      Origin: new URL(baseURL).origin,
      'X-Operation-Input': encodeURIComponent(
        JSON.stringify({ workspace_id: WORKSPACE_ID, file_name: '日本語の画面.png' }),
      ),
      'Content-Type': 'image/png',
    },
    data: bytes,
  });
  expect(uploaded.status()).toBe(200);
  const row = attachmentUpload.output.parse(await uploaded.json());
  const path = `/api/aoba/attachments/${row.id}`;
  const downloaded = await page.request.get(path);
  expect(downloaded.status()).toBe(200);
  expect(downloaded.headers()['content-type']).toBe('image/png');
  expect(downloaded.headers()['x-content-type-options']).toBe('nosniff');
  expect(downloaded.headers()['cache-control']).toContain('private');
  expect(downloaded.headers()['content-security-policy']).toContain('sandbox');
  expect(downloaded.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(await downloaded.body()).toEqual(bytes);
  await signIn(context, baseURL, 'admin');
  const denied = await page.request.get(path);
  const missing = await page.request.get(`/api/aoba/attachments/${crypto.randomUUID()}`);
  expect(denied.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await denied.json()).toEqual(await missing.json());
});

test('MP4 の単一 Range は 206、不正な開始位置は 416', async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const bytes = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  const uploaded = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
    headers: {
      Origin: new URL(baseURL).origin,
      'X-Operation-Input': encodeURIComponent(JSON.stringify({ workspace_id: WORKSPACE_ID, file_name: '録画.mp4' })),
      'Content-Type': 'video/mp4',
    },
    data: bytes,
  });
  expect(uploaded.status()).toBe(200);
  const row = attachmentUpload.output.parse(await uploaded.json());
  expect(row.content_type).toBe('video/mp4');
  const path = `/api/aoba/attachments/${row.id}`;
  const partial = await page.request.get(path, { headers: { Range: 'bytes=4-11' } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()['content-range']).toBe('bytes 4-11/24');
  expect(partial.headers()['accept-ranges']).toBe('bytes');
  expect(await partial.body()).toEqual(bytes.subarray(4, 12));
  const invalid = await page.request.get(path, { headers: { Range: 'bytes=24-' } });
  expect(invalid.status()).toBe(416);
  expect(invalid.headers()['content-range']).toBe('bytes */24');
  expect(invalid.headers()['x-content-type-options']).toBe('nosniff');
});

test('HTML を png と偽って上げても添付として取得し、埋め込んだ script は実行されない', async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  const uploaded = await page.request.post(`/api/aoba/${attachmentUpload.name}`, {
    headers: {
      Origin: new URL(baseURL).origin,
      'X-Operation-Input': encodeURIComponent(JSON.stringify({ workspace_id: WORKSPACE_ID, file_name: '写真.png' })),
      'Content-Type': 'image/png',
    },
    data: Buffer.from('<html><script>parent.postMessage("attachment-executed", "*")</script></html>'),
  });
  expect(uploaded.status()).toBe(200);
  const row = attachmentUpload.output.parse(await uploaded.json());
  expect(row.content_type).toBe('application/octet-stream');
  const path = `/api/aoba/attachments/${row.id}`;
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(response.headers()['content-security-policy']).toContain('sandbox');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  await page.goto('/aoba');
  await page.evaluate((path) => {
    const link = document.createElement('a');
    link.href = path;
    // API の添付は画面のルーターを通さず、Content-Disposition をブラウザに処理させる。
    link.dataset.sveltekitReload = '';
    link.textContent = '添付した HTML を開く';
    document.body.append(link);
  }, path);
  // ブラウザの通常のリンクからも、HTML の文書を開かずファイルとして落とす。
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: '添付した HTML を開く' }).click();
  expect((await downloaded).suggestedFilename()).toBe('写真.png');
  expect(page.url()).toContain('/aoba');
});
