// 添付ファイルを上げる操作（attachment-upload。Issue #744）の、ストリームと Workers の実行環境に頼る振る舞い。
// 本文を ReadableStream で送る、50MB ちょうど、Content-Length と本文の長さの食い違い、行の挿入の失敗（本物の D1 のトリガーで起こす）。
// 先に、テストの道具（app.request、highWaterMark 0 のストリーム、R2 を包む Proxy）が本物の workerd と同じに振る舞うことを、
// 道具を使わずに確かめる
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  MAX_BYTES,
  PNG_HEAD,
  attachmentRows,
  chunkedStream,
  failInsertsInto,
  generatedStream,
  nothingWritten,
  objectBytes,
  objectKeysOf,
  pngFile,
  recordingBucket,
  upload,
  type UploadOutput,
} from './attachment-helpers.ts';
import { createAttachment } from './factories.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('テストの道具の前提（本物の workerd で確かめる）', () => {
  test('app.request は文字列とバイトの本文に Content-Length を付けず、付けたヘッダーはそのまま届く', async () => {
    const echo = new Hono();
    echo.post('/', (c) => c.json({ length: c.req.header('Content-Length') ?? null }));
    const lengthOf = async (init: RequestInit) =>
      ((await (await echo.request('/', init)).json()) as { length: unknown }).length;
    expect(await lengthOf({ method: 'POST', body: 'abc' })).toBeNull();
    expect(await lengthOf({ method: 'POST', body: new Uint8Array(5) })).toBeNull();
    expect(await lengthOf({ method: 'POST', body: new Uint8Array(5), headers: { 'Content-Length': '5' } })).toBe('5');
  });

  test('highWaterMark 0 のストリームは、Request に渡しても読むまで pull されない', async () => {
    const { stream, pulls } = generatedStream(10, { chunkSize: 4 });
    const request = new Request('https://example.com/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { 'Content-Length': '10' },
    } as RequestInit);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pulls()).toBe(0);
    expect((await request.arrayBuffer()).byteLength).toBe(10);
    expect(pulls()).toBeGreaterThan(0);
  });

  test('R2 の put は長さの分からない ReadableStream を断り、FixedLengthStream の readable は受ける', async () => {
    const prefix = `runtime-${crypto.randomUUID()}/`;
    await expect(env.ATTACHMENTS.put(`${prefix}plain`, generatedStream(4).stream)).rejects.toThrow(/known length/);
    // Content-Length を付けた Request の本文でも、JS のストリームから作ったものは長さが分からない
    const request = new Request('https://example.com/', {
      method: 'POST',
      body: generatedStream(4).stream,
      duplex: 'half',
      headers: { 'Content-Length': '4' },
    } as RequestInit);
    await expect(env.ATTACHMENTS.put(`${prefix}request`, request.body)).rejects.toThrow(/known length/);
    const fixed = new FixedLengthStream(4);
    void generatedStream(4).stream.pipeTo(fixed.writable);
    await env.ATTACHMENTS.put(`${prefix}fixed`, fixed.readable);
    expect((await env.ATTACHMENTS.head(`${prefix}fixed`))?.size).toBe(4);
    await env.ATTACHMENTS.delete(`${prefix}fixed`);
  });

  test('FixedLengthStream に宣言より少ないバイトしか届かなければ put は失敗し、R2 に何も残らない', async () => {
    const key = `runtime-${crypto.randomUUID()}/short`;
    const fixed = new FixedLengthStream(10);
    void generatedStream(4)
      .stream.pipeTo(fixed.writable)
      .catch(() => {});
    await expect(env.ATTACHMENTS.put(key, fixed.readable)).rejects.toThrow();
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
  });

  test('R2 を包む Proxy は、put、get、head、list、delete を本物と同じに流し、呼び出しを記録する', async () => {
    const { bucket, calls } = recordingBucket();
    const key = `runtime-${crypto.randomUUID()}/proxy`;
    await bucket.put(key, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await (await bucket.get(key))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await env.ATTACHMENTS.head(key))?.size).toBe(3);
    expect((await bucket.list({ prefix: key })).objects.map((object) => object.key)).toEqual([key]);
    await bucket.delete(key);
    expect(await env.ATTACHMENTS.head(key)).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['put', 'get', 'list', 'delete']);
  });

  test('attachments の INSERT を止めるトリガーは、そのワークスペースの行だけを本物の D1 で止める', async () => {
    const target = await createTarget();
    const restore = await failInsertsInto(target.workspace.id);
    try {
      await expect(createAttachment(target.organization, target.workspace.id, target.admin.userId!)).rejects.toThrow(
        /insert failed/,
      );
      await expect(
        createAttachment(target.organization, target.otherWorkspace.id, target.admin.userId!),
      ).resolves.toBeDefined();
    } finally {
      await restore();
    }
    await expect(
      createAttachment(target.organization, target.workspace.id, target.admin.userId!),
    ).resolves.toBeDefined();
  });
});

describe('本文を ReadableStream で送る', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test('Content-Length を付ければ 200 で、R2 に同じバイトが入る', async () => {
    const file = pngFile(5000);
    const res = await upload(target, {
      file: chunkedStream([file.subarray(0, 1000), file.subarray(1000, 3000), file.subarray(3000)]),
      contentLength: String(file.byteLength),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body).toMatchObject({ size_bytes: file.byteLength, content_type: 'image/png' });
    expect(await objectBytes(`${target.organization.id}/${target.workspace.id}/${body.id}`)).toEqual(file);
  });

  test('Content-Length を付けなければ、本文を読まずに 400 で、何も書かない', async () => {
    const fresh = await createTarget();
    const { stream, pulls } = generatedStream(100);
    const res = await upload(fresh, { file: stream });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(pulls()).toBe(0);
    expect(await nothingWritten(fresh)).toEqual({ rows: 0, objects: [] });
    // 対照: 同じストリームに Content-Length を付ければ 200
    expect((await upload(fresh, { file: generatedStream(100).stream, contentLength: '100' })).status).toBe(200);
  });

  test('先頭の印が1バイトずつ別の塊で届いても、先頭の 64 バイトで種類を決める', async () => {
    const file = pngFile(60);
    const res = await upload(target, {
      file: chunkedStream([...file].map((byte) => new Uint8Array([byte]))),
      contentLength: String(file.byteLength),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadOutput).content_type).toBe('image/png');
  });

  test('64 バイトより後ろに印があっても、その形式にしない', async () => {
    const file = new Uint8Array(64 + PNG_HEAD.byteLength + 8);
    file.set(PNG_HEAD, 64);
    const res = await upload(target, { file });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadOutput).content_type).toBe('application/octet-stream');
  });

  test('本文が Content-Length より短ければ失敗し、行も R2 のファイルも残らない', async () => {
    const fresh = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload(fresh, { file: generatedStream(10).stream, contentLength: '20' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await nothingWritten(fresh)).toEqual({ rows: 0, objects: [] });
    // 対照: 長さが合えば 200
    expect((await upload(fresh, { file: generatedStream(20).stream, contentLength: '20' })).status).toBe(200);
  });

  test('本文が Content-Length より長ければ失敗し、行も R2 のファイルも残らない', async () => {
    const fresh = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload(fresh, { file: generatedStream(20).stream, contentLength: '10' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await nothingWritten(fresh)).toEqual({ rows: 0, objects: [] });
    // 対照: 長さが合えば 200
    expect((await upload(fresh, { file: generatedStream(10).stream, contentLength: '10' })).status).toBe(200);
  });

  test('Content-Length が 52428801 なら、本文を1度も読まずに 413 で、何も書かない', async () => {
    const fresh = await createTarget();
    const { stream, pulls } = generatedStream(MAX_BYTES + 1);
    const res = await upload(fresh, { file: stream, contentLength: String(MAX_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(pulls()).toBe(0);
    expect(await nothingWritten(fresh)).toEqual({ rows: 0, objects: [] });
  });

  // 52428800 バイトを 1MB ずつ作って流す。手元では R2 への put は 1 秒ほど（FixedLengthStream で測った値）
  test('50MB ちょうど（52428800 バイト）を作りながら流すと 200 で、R2 にも行にも同じ大きさで入る', async () => {
    const { stream } = generatedStream(MAX_BYTES);
    const res = await upload(target, { file: stream, contentLength: String(MAX_BYTES), fileName: '録画.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body).toMatchObject({ size_bytes: MAX_BYTES, content_type: 'image/png' });
    const key = `${target.organization.id}/${target.workspace.id}/${body.id}`;
    expect((await env.ATTACHMENTS.head(key))?.size).toBe(MAX_BYTES);
    // 先頭と末尾のバイトが、作った値と同じ
    const head = await env.ATTACHMENTS.get(key, { range: { offset: 0, length: 16 } });
    expect(new Uint8Array(await head!.arrayBuffer()).subarray(0, 8)).toEqual(PNG_HEAD);
    const tail = await env.ATTACHMENTS.get(key, { range: { suffix: 4 } });
    expect([...new Uint8Array(await tail!.arrayBuffer())]).toEqual(
      [MAX_BYTES - 4, MAX_BYTES - 3, MAX_BYTES - 2, MAX_BYTES - 1].map((at) => at & 0xff),
    );
    const row = (await attachmentRows(target)).find((item) => item.id === body.id);
    expect(row?.size_bytes).toBe(MAX_BYTES);
    await env.ATTACHMENTS.delete(key);
  }, 120_000);
});

describe('途中で失敗しても、付く先のないファイルを R2 に残さない', () => {
  test('attachments の INSERT が失敗すると、書いた R2 のファイルを消してから 500 の internal', async () => {
    const target = await createTarget();
    const { calls, env: recording } = recordingBucket();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const restore = await failInsertsInto(target.workspace.id);
    let res: Response;
    try {
      res = await upload(target, { env: recording });
    } finally {
      await restore();
    }
    expect(res.status).toBe(500);
    expect(await errorCodeOf(res)).toBe('internal');
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
    // R2 に書いてから行を入れ、入らなかったので同じキーを消した
    const puts = calls.filter((call) => call.method === 'put');
    const deletes = calls.filter((call) => call.method === 'delete');
    expect(puts).toHaveLength(1);
    const key = puts[0]!.key as string;
    expect(key).toMatch(new RegExp(`^${target.organization.id}/${target.workspace.id}/${UUID}$`));
    expect(deletes.map((call) => call.key)).toEqual([key]);
    expect(calls.findIndex((call) => call.method === 'put')).toBeLessThan(
      calls.findIndex((call) => call.method === 'delete'),
    );
  });

  test('R2 の削除も失敗したら 500 で、ログにキーを出さずに件数を出す', async () => {
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
    let res: Response;
    try {
      res = await upload(target, { env: recording });
    } finally {
      await restore();
    }
    expect(res.status).toBe(500);
    expect(await errorCodeOf(res)).toBe('internal');
    expect((await attachmentRows(target)).length).toBe(0);
    const key = calls.find((call) => call.method === 'put')!.key as string;
    expect(calls.some((call) => call.method === 'delete' && call.key === key)).toBe(true);
    // 操作のログのほかに、消せなかったことのログが出る。どのログにもキー（ワークスペースの ID と行の ID）を出さない
    const extra = logged.filter((line) => !line.includes('"operation":"attachment-upload"'));
    expect(extra.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(key);
      expect(line).not.toContain(key.split('/')[2]!);
      expect(line).not.toContain(`/${target.workspace.id}`);
    }
    expect(extra.some((line) => /\b1\b/.test(line))).toBe(true);
    // 消せなかったファイルは、後片付けとしてここで消す
    await env.ATTACHMENTS.delete(key);
  });

  test('R2 への書き込みが失敗したら、行を入れずに 500', async () => {
    const target = await createTarget();
    const { env: recording } = recordingBucket({
      put: async () => {
        throw new Error('R2 の書き込みに失敗した');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload(target, { env: recording });
    expect(res.status).toBe(500);
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });

  test('挿入の失敗の後も、同じワークスペースに上げ直せる', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const restore = await failInsertsInto(target.workspace.id);
    try {
      expect((await upload(target)).status).toBe(500);
    } finally {
      await restore();
    }
    const res = await upload(target);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as UploadOutput;
    expect(await objectKeysOf(target.organization.id)).toEqual([
      `${target.organization.id}/${target.workspace.id}/${id}`,
    ]);
  });
});
