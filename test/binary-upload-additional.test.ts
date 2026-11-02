import { afterEach, expect, test, vi } from 'vitest';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { sniffContentType } from '../src/server/attachments/sniff.ts';
import { app, attachmentRows, nothingWritten, objectKeysOf, upload } from './attachment-helpers.ts';
import { createTarget, testEnv } from './operations/world.ts';

afterEach(() => vi.restoreAllMocks());

test('成功した添付があっても、入力ヘッダーのない要求は既存の行とファイルを変えない', async () => {
  const target = await createTarget();
  expect((await upload(target)).status).toBe(200);
  const rows = await attachmentRows(target);
  const keys = await objectKeysOf(target.organization.id);
  for (const query of ['', `?workspace_id=${target.workspace.id}&file_name=a.png`]) {
    const response = await app.request(
      `/api/${target.slug}/attachment-upload${query}`,
      {
        method: 'POST',
        headers: {
          Origin: testEnv.PUBLIC_ORIGIN,
          Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.member.token}`,
          'Content-Type': 'application/json',
          'Content-Length': '2',
        },
        body: '{}',
      },
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(await attachmentRows(target)).toEqual(rows);
    expect(await objectKeysOf(target.organization.id)).toEqual(keys);
  }
});

test('先頭を確かめた後で本文のストリームが失敗しても、行もファイルも残らない', async () => {
  const target = await createTarget();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let sent = false;
  const file = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) controller.error(new Error('途中で切れた'));
        else {
          sent = true;
          controller.enqueue(new Uint8Array(64));
        }
      },
    },
    { highWaterMark: 0 },
  );
  expect((await upload(target, { file, contentLength: '128' })).status).toBe(500);
  expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
});

test('WebM の DocType は EBML のヘッダーの要素の境界内にあるものだけを使う', () => {
  const signature = [0x1a, 0x45, 0xdf, 0xa3];
  const docType = [0x42, 0x82, 0x84, ...new TextEncoder().encode('webm')];
  // ヘッダーの外の DocType と、別の要素の値に埋めた DocType は使わない。
  for (const bytes of [
    [...signature, 0x80, ...docType],
    [...signature, 0x8a, 0x42, 0x86, 0x87, ...docType],
    [...signature, 0x86, ...docType],
  ]) {
    expect(sniffContentType(new Uint8Array(bytes))).toBe('application/octet-stream');
  }
  // 2バイトの長さの符号も読める。
  expect(sniffContentType(new Uint8Array([...signature, 0x40, 0x07, ...docType]))).toBe('video/webm');
});
