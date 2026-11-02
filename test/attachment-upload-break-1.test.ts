// attachment-upload（#744）を崩しにいくテスト。既存のテストと重ならない手口だけを置く
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PNG_HEAD,
  attachmentRows,
  chunkedStream,
  failInsertsInto,
  nothingWritten,
  objectBytes,
  recordingBucket,
  upload,
  type UploadOutput,
} from './attachment-helpers.ts';
import { env } from 'cloudflare:workers';
import { createTarget } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe('先頭 64 バイトの読み出しとストリームの継ぎ直しで、R2 のバイトが送ったものと一致する', () => {
  const withPng = (rest: Uint8Array[]) => [PNG_HEAD, ...rest];
  test.each([
    ['0 バイトの塊を挟む', withPng([new Uint8Array(0), bytes(56, 1), new Uint8Array(0), bytes(10, 2)])],
    ['64 バイトちょうどの1塊と、その後の塊', [concat([PNG_HEAD, bytes(56, 3)]), bytes(20, 4)]],
    ['64 バイトちょうどで終わる', [concat([PNG_HEAD, bytes(56, 5)])]],
    ['63 + 1 + 1 で切れる', [concat([PNG_HEAD, bytes(55, 6)]), bytes(1, 7), bytes(1, 8)]],
    ['64 を跨ぐ塊（30 + 40 + 30）', [concat([PNG_HEAD, bytes(22, 9)]), bytes(40, 10), bytes(30, 11)]],
    ['最初の塊が 64 を大きく超える', [concat([PNG_HEAD, bytes(1000, 12)]), bytes(5, 13)]],
    ['64 バイトに届かない短いファイル', withPng([bytes(3, 14)])],
  ])('%s', async (_label, chunks) => {
    const target = await createTarget();
    const sent = concat(chunks);
    const res = await upload(target, { file: chunkedStream(chunks), contentLength: String(sent.byteLength) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body.content_type).toBe('image/png');
    const [row] = await attachmentRows(target);
    expect(row?.size_bytes).toBe(sent.byteLength);
    expect(await objectBytes(row!.object_key)).toEqual(sent);
  });

  test('最初の読み出しでストリームが例外を投げると、R2 に触れずに 500 で、何も残らない', async () => {
    const target = await createTarget();
    const { calls, env: recording } = recordingBucket();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error('最初から切れた'));
        },
      },
      { highWaterMark: 0 },
    );
    const res = await upload(target, { file, contentLength: '100', env: recording });
    expect(res.status).toBe(500);
    expect(calls.filter((call) => call.method === 'put')).toHaveLength(0);
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });
});

describe('ファイル名の入力の境界', () => {
  // JSON.stringify は片割れのサロゲートを \ud800 と書くので、encodeURIComponent でも壊れずにヘッダーに乗る
  test('片割れのサロゲートを含むファイル名は、断るか、応答と行が同じ値になる', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fileName = 'a\ud800.png';
    const res = await upload(target, { fileName });
    if (res.status === 400) {
      expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
      return;
    }
    expect(res.status).toBe(200);
    // 片割れのサロゲートを文字列のまま比べると、失敗の報告が UTF-8 にできず vitest の pool が落ちるので、符号単位の数で比べる
    const units = (value: string | undefined) => (value ?? '').split('').map((unit) => unit.charCodeAt(0));
    const body = JSON.parse(await res.text()) as UploadOutput;
    const [row] = await attachmentRows(target);
    // 画面は応答の値を一覧に出し、読み直すと行の値が出る。両者が違えば同じファイルの名前が変わって見える
    expect(units(row?.file_name)).toEqual(units(body.file_name));
    expect(units(body.file_name)).toEqual(units(fileName));
  });
});

describe('失敗の後始末のログ', () => {
  test('R2 の削除に失敗したときのログは、ほかのエラーのログと同じく level と requestId を持つ', async () => {
    const target = await createTarget();
    const { calls, env: recording } = recordingBucket({
      delete: async () => {
        throw new Error('R2 の削除に失敗した');
      },
    });
    const logged: string[] = [];
    for (const method of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const restore = await failInsertsInto(target.workspace.id);
    try {
      const res = await upload(target, { env: recording, headers: { 'cf-ray': 'break1-ray-0001' } });
      expect(res.status).toBe(500);
    } finally {
      await restore();
      const key = calls.find((call) => call.method === 'put')?.key;
      if (typeof key === 'string') await env.ATTACHMENTS.delete(key);
    }
    const operationLine = logged.find((line) => line.includes('"operation":"attachment-upload"'));
    expect(operationLine).toContain('"requestId":"break1-ray-0001"');
    const deleteLine = logged.find((line) => line.includes('消せなかった'));
    expect(deleteLine, '削除の失敗のログ').toBeDefined();
    const parsed = JSON.parse(deleteLine!) as Record<string, unknown>;
    // 「API のエラーとログ」: ログは JSON の1行で、requestId はエラーのログと同じ値。ほかの error のログは level と code を持つ
    expect(parsed).toMatchObject({ level: 'error', requestId: 'break1-ray-0001' });
  });
});
