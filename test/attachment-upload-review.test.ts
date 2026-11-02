// done-check のレビューで見つかった筋を止めるテスト（Issue #744）。
// 行の ID の採番（UUIDv7）、時計（now()）、種類の判定の 64 バイトの上限、仮の回数の上限を見る
import { afterEach, describe, expect, test, vi } from 'vitest';
import { sniffContentType } from '../src/server/attachments/sniff.ts';
import { setFixedNow } from '../src/shared/clock.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { attachmentRows, objectKeysOf, recordingBucket, upload, type UploadOutput } from './attachment-helpers.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';

// version が 7、variant が 10xx の UUID（docs/data-model.md の「主キーは UUIDv7」）
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  setFixedNow(undefined);
  vi.restoreAllMocks();
});

describe('行の ID と時刻', () => {
  test('応答、行、R2 のキーの末尾の ID は同じ UUIDv7', async () => {
    const target = await createTarget();
    const res = await upload(target);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as UploadOutput;
    expect(id).toMatch(UUID_V7);
    const [row] = await attachmentRows(target);
    expect(row?.id).toBe(id);
    const [key] = await objectKeysOf(target.organization.id);
    expect(key?.split('/').at(-1)).toBe(id);
  });

  test('created_at は共通の時計（now()）の時刻', async () => {
    const target = await createTarget();
    const at = new Date('2026-11-01T09:30:00.000Z');
    // 開発用の時計（DEV_NOW）は、ループバックの公開 URL の環境でミドルウェアがリクエストごとに渡す（src/server/dev-clock.ts）
    const devEnv = Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: at.toISOString() });
    const res = await upload(target, { env: devEnv });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body.created_at).toBe(at.toISOString());
    const [row] = await attachmentRows(target);
    expect(row?.created_at).toBe(at.toISOString());
  });
});

describe('保存できなかったときのログ', () => {
  test('R2 の put が先に失敗したら、ログの error は流し込みの中止（AbortError）でなく put の例外の名前', async () => {
    const target = await createTarget();
    const { env: recording } = recordingBucket({
      put: async () => {
        throw new TypeError('R2 の書き込みに失敗した');
      },
    });
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(line);
    });
    const res = await upload(target, { env: recording });
    expect(res.status).toBe(500);
    const reasons = logged
      .filter((line): line is string => typeof line === 'string' && line.includes('添付ファイルを保存できなかった'))
      .map((line) => (JSON.parse(line) as { error: string }).error);
    expect(reasons).toEqual(['TypeError']);
  });
});

describe('種類の判定は先頭の 64 バイトまで', () => {
  // EBML のヘッダーの中に Void の要素（ID 0xEC）を padding バイト置き、その後に DocType の webm を置く。
  // 全体の長さは 5（印とヘッダーの大きさ）+ 2 + padding + 7（DocType の要素）
  function ebmlWithVoid(padding: number): Uint8Array {
    const body = [0xec, 0x80 | padding, ...new Array<number>(padding).fill(0), 0x42, 0x82, 0x84, ...'webm'];
    const bytes = [0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length, ...body].map((part) =>
      typeof part === 'string' ? part.charCodeAt(0) : part,
    );
    // 判定に渡す入力は 64 バイトより長くする（上限で切るのは sniffContentType 自身）
    return new Uint8Array([...bytes, ...new Array<number>(40).fill(0)]);
  }

  test('DocType が 64 バイト目で終わる WebM は video/webm', () => {
    expect(sniffContentType(ebmlWithVoid(50))).toBe('video/webm');
  });

  test('DocType が 65 バイト目に掛かる WebM は、長い入力を渡しても application/octet-stream', () => {
    expect(sniffContentType(ebmlWithVoid(51))).toBe('application/octet-stream');
  });
});

describe('仮の回数の上限', () => {
  // 組織の合計の上限（#68 のストーリー E）と付く先のない行の掃除（#746）が入るまでの蓋
  test('同じアカウントは 10 分に 60 回まで上げられ、61 回目は 429 の rate_limited で、行も R2 のファイルも増えない', async () => {
    expect(attachmentUpload.rateLimit).toEqual({ max: 60, windowSeconds: 600 });
    const target = await createTarget();
    for (let i = 0; i < 60; i++) expect((await upload(target)).status).toBe(200);
    const res = await upload(target);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
    expect(await attachmentRows(target)).toHaveLength(60);
    expect(await objectKeysOf(target.organization.id)).toHaveLength(60);
  });
});
