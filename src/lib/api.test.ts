// 画面から操作を呼ぶ口（src/lib/api.ts の callOperation）の、応答が返らないときの打ち切り（#1039）。
// 読み取りは上限で通信の失敗（status 0）にし、書き込みは打ち切らない
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { READ_TIMEOUT_MS, callOperation } from './api.ts';
import { defineOperation } from '../shared/operations/define.ts';

const readOperation = defineOperation({
  name: 'timeout-read',
  description: '打ち切りを確かめる読み取り',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ value: z.string() }),
});

const longReadOperation = defineOperation({
  name: 'timeout-long-read',
  description: '長い上限を持つ読み取り',
  mode: 'read',
  permission: 'organization',
  clientTimeoutMs: 30_000,
  input: z.object({}),
  output: z.object({ value: z.string() }),
});

const writeOperation = defineOperation({
  name: 'timeout-write',
  description: '打ち切らない書き込み',
  mode: 'write',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ value: z.string() }),
});

const scope = { slug: 'aoba' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// signal が中断されるまで返らない fetch。signal が渡らなければ永遠に返らない
function hangingFetch(): typeof fetch {
  return ((_path: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
}

// 頭（status）は返すが、本文が signal の中断まで届かない fetch
function stalledBodyFetch(): typeof fetch {
  return ((_path: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(stream) {
        init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
}

// 結果が出たかを、待たずに覗く
function track<T>(promise: Promise<T>): { settled: () => boolean; result: Promise<T> } {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { settled: () => settled, result: promise };
}

describe('読み取りの打ち切り', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('既定の上限（10 秒）を過ぎても返らなければ、通信の失敗（status 0）にする', async () => {
    const call = track(callOperation(readOperation, {}, { ...scope, fetcher: hangingFetch() }));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call.result).resolves.toEqual({ ok: false, status: 0, error: null });
  });

  test('頭は返っても本文が届かなければ、応答の status ではなく通信の失敗にする', async () => {
    const call = track(callOperation(readOperation, {}, { ...scope, fetcher: stalledBodyFetch() }));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await expect(call.result).resolves.toEqual({ ok: false, status: 0, error: null });
  });

  test('定義に長い上限があれば、既定の 10 秒では切らず、その上限で切る', async () => {
    const call = track(callOperation(longReadOperation, {}, { ...scope, fetcher: hangingFetch() }));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000 - READ_TIMEOUT_MS);
    await expect(call.result).resolves.toEqual({ ok: false, status: 0, error: null });
  });

  test('上限の内に返った応答は、そのまま返し、後でタイマーが切れても変わらない', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ value: '届いた' }));
    const result = await callOperation(readOperation, {}, { ...scope, fetcher });
    expect(result).toEqual({ ok: true, data: { value: '届いた' } });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2);
    expect(init.signal?.aborted).toBe(false);
  });
});

describe('書き込みは打ち切らない', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('10 秒を大きく過ぎても待ち続け、遅れて返った応答をそのまま返す', async () => {
    let respond: (res: Response) => void = () => {};
    // 呼び出しの引数（中断の口が渡らないこと）は mock.calls で確かめる
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const call = track(callOperation(writeOperation, {}, { ...scope, fetcher }));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 6);
    expect(call.settled()).toBe(false);
    // 中断の口を渡さない
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeUndefined();
    respond(jsonResponse({ value: '保存した' }));
    await expect(call.result).resolves.toEqual({ ok: true, data: { value: '保存した' } });
  });
});

describe('定義の上限の欄', () => {
  test('write の操作には付けられない', () => {
    expect(() =>
      defineOperation({
        name: 'timeout-write-with-limit',
        description: '書き込みに上限を付けた',
        mode: 'write',
        permission: 'organization',
        clientTimeoutMs: 30_000,
        input: z.object({}),
        output: z.object({}),
      }),
    ).toThrow(/clientTimeoutMs/);
  });

  test.each([0, -1, 1.5])('正の整数でない値（%s）は付けられない', (value) => {
    expect(() =>
      defineOperation({
        name: 'timeout-bad-limit',
        description: '上限が正の整数でない',
        mode: 'read',
        permission: 'organization',
        clientTimeoutMs: value,
        input: z.object({}),
        output: z.object({}),
      }),
    ).toThrow(/clientTimeoutMs/);
  });
});
