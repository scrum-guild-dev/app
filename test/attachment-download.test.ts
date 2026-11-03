// #745: 内部の新関数を呼ばず、GET の応答から権限・型・Range・ストリームを検査する。
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { generatedStream, recordingBucket, textBytes, upload, type UploadOutput } from './attachment-helpers.ts';
import { download, expectDownloadHeaders, expectSafeDisposition, storedFile } from './attachment-download-helpers.ts';
import { createComment, createEpic, createStory, createTask } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createPerson, createTarget, type Target } from './operations/world.ts';

describe('ダウンロード用の道具の前提（本物の workerd と R2）', () => {
  test('R2 の本文は ReadableStream で、Response に渡してから同じバイトを読める', async () => {
    const key = `download-runtime-${crypto.randomUUID()}`;
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    await env.ATTACHMENTS.put(key, bytes);
    try {
      const object = await env.ATTACHMENTS.get(key);
      expect(object?.body).toBeInstanceOf(ReadableStream);
      const response = new Response(object!.body);
      expect(object!.bodyUsed).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(object!.bodyUsed).toBe(true);
    } finally {
      await env.ATTACHMENTS.delete(key);
    }
  });

  test('Response のラップは highWaterMark 0 の本文を先読みしない', async () => {
    const generated = generatedStream(12, { chunkSize: 4 });
    const first = new Response(generated.stream);
    const wrapped = new Response(first.body, first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(generated.pulls()).toBe(0);
    expect((await wrapped.arrayBuffer()).byteLength).toBe(12);
    expect(generated.pulls()).toBeGreaterThan(0);
  });

  test('R2 の範囲取得は全体の size と取得した range を区別する', async () => {
    const key = `download-runtime-${crypto.randomUUID()}`;
    await env.ATTACHMENTS.put(key, new Uint8Array([0, 1, 2, 3, 4]));
    try {
      const object = await env.ATTACHMENTS.get(key, { range: { offset: 1, length: 2 } });
      expect(object?.size).toBe(5);
      expect(object?.range).toMatchObject({ offset: 1, length: 2 });
      expect([...new Uint8Array(await object!.arrayBuffer())]).toEqual([1, 2]);
    } finally {
      await env.ATTACHMENTS.delete(key);
    }
  });
});

describe('保存した型とバイトで配信する', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'])(
    '%s は保存した型で inline、Origin が無い GET でも取得できる',
    async (contentType) => {
      const { row, bytes } = await storedFile(target, { contentType, fileName: '画像または動画.dat' });
      const response = await download(target, row.id);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(contentType);
      expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
      expectSafeDisposition(response, row.file_name, 'inline');
      expectDownloadHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  test.each(['image/svg+xml', 'text/html', 'text/plain', 'application/pdf', 'application/octet-stream'])(
    '%s は拡張子が png でも attachment',
    async (contentType) => {
      const { row, bytes } = await storedFile(target, { contentType, fileName: '写真.png' });
      const response = await download(target, row.id);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(contentType);
      expectSafeDisposition(response, row.file_name, 'attachment');
      expectDownloadHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  test('png と偽った HTML を上げても、保存した octet-stream と attachment で返す', async () => {
    const bytes = textBytes('<!doctype html><script>globalThis.downloadExecuted=true</script>');
    const uploaded = await upload(target, {
      file: bytes,
      fileName: '画像.png',
      headers: { 'Content-Type': 'image/png' },
    });
    expect(uploaded.status).toBe(200);
    const row = (await uploaded.json()) as UploadOutput;
    expect(row.content_type).toBe('application/octet-stream');
    const response = await download(target, row.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expectSafeDisposition(response, row.file_name, 'attachment');
    expectDownloadHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test('GIF89a の後ろに HTML が混じっても sandbox と nosniff を保持する', async () => {
    const bytes = textBytes('GIF89a<html><script>globalThis.downloadExecuted=true</script></html>');
    const uploaded = await upload(target, { file: bytes, fileName: '写真.gif' });
    expect(uploaded.status).toBe(200);
    const row = (await uploaded.json()) as UploadOutput;
    expect(row.content_type).toBe('image/gif');
    const response = await download(target, row.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expectDownloadHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test.each(['手順 "引用".txt', '手順\\名前.txt', '手順; filename=other.txt', '日本語 %22%0D%0A.txt', "記録'()*%.txt"])(
    'ファイル名 %s は安全な ASCII filename と元の UTF-8 filename* を持つ',
    async (fileName) => {
      const { row } = await storedFile(target, { fileName, contentType: 'application/octet-stream' });
      const response = await download(target, row.id);
      expect(response.status).toBe(200);
      expectSafeDisposition(response, fileName, 'attachment');
      expectDownloadHeaders(response);
      await response.arrayBuffer();
    },
  );

  test('R2 の本文を読み切る前に応答を返し、要求側が読むと同じストリームが流れる', async () => {
    const generated = generatedStream(65_536, { chunkSize: 4096 });
    const { row } = await storedFile(target, { file: new Uint8Array(65_536) });
    const { env: bindings } = recordingBucket({
      get: async (...args: unknown[]) => {
        const object = await env.ATTACHMENTS.get(args[0] as string);
        if (object === null) return null;
        return new Proxy(object, {
          get(object, property) {
            if (property === 'body') return generated.stream;
            const value: unknown = Reflect.get(object, property);
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
      },
    });
    const response = await download(target, row.id, { env: bindings });
    expect(response.status).toBe(200);
    expect(generated.pulls(), '応答を返す時点で本文を先読みしない').toBe(0);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(65_536);
    expect([...bytes.subarray(-4)]).toEqual([252, 253, 254, 255]);
  });
});

describe('動画の Range', () => {
  let target: Target;
  const bytes = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  beforeAll(async () => {
    target = await createTarget();
  });

  for (const contentType of ['video/mp4', 'video/webm']) {
    test.each([
      { range: 'bytes=0-0', start: 0, end: 0 },
      { range: 'bytes=4-11', start: 4, end: 11 },
      { range: 'bytes=25-', start: 25, end: 31 },
      { range: 'bytes=-5', start: 27, end: 31 },
      { range: 'bytes=28-999', start: 28, end: 31 },
      { range: 'bytes=-999', start: 0, end: 31 },
    ])(`${contentType} の $range は 206 と要求したバイト`, async ({ range, start, end }) => {
      const { row } = await storedFile(target, { contentType, file: bytes });
      const response = await download(target, row.id, { headers: { Range: range } });
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Type')).toBe(contentType);
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/32`);
      expect(response.headers.get('Content-Length')).toBe(String(end - start + 1));
      expectDownloadHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    });
  }

  test.each([
    'bytes=32-',
    'bytes=100-200',
    'bytes=9-2',
    'bytes=-0',
    'bytes=',
    'bytes=abc-def',
    'bytes=1.5-2',
    'bytes=0-1,4-5',
  ])('%s は 416 で全体の長さを返す', async (range) => {
    const { row } = await storedFile(target, { contentType: 'video/mp4', file: bytes });
    const response = await download(target, row.id, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */32');
    expectDownloadHeaders(response);
    await response.arrayBuffer();
  });

  test('Range が無い動画は全体を 200 で返し、Accept-Ranges を案内する', async () => {
    const { row } = await storedFile(target, { contentType: 'video/mp4', file: bytes });
    const response = await download(target, row.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBeNull();
    expectDownloadHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test('画像の Range は無視して全体を 200 で返す', async () => {
    const { row } = await storedFile(target, { contentType: 'image/png', file: bytes });
    const response = await download(target, row.id, { headers: { Range: 'bytes=4-7' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expectDownloadHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test.each(['"unpublished-etag"', 'Wed, 21 Oct 2015 07:28:00 GMT'])(
    'If-Range %s は検証子を公開するまで Range を無視して全体を 200 で返す',
    async (ifRange) => {
      const { row } = await storedFile(target, { contentType: 'video/mp4', file: bytes });
      const response = await download(target, row.id, { headers: { Range: 'bytes=4-7', 'If-Range': ifRange } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expectDownloadHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );
});

describe('未添付の所有者だけに返し、存在や保存先を漏らさない', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  async function expectHidden(id: string, person = target.member, slug?: string): Promise<void> {
    const response = await download(target, id, { person, slug });
    const missing = await download(target, crypto.randomUUID(), { person, slug });
    expect(response.status).toBe(404);
    expect(missing.status).toBe(404);
    expectDownloadHeaders(response);
    expectDownloadHeaders(missing);
    expect(await response.json()).toEqual(await missing.json());
    expect(response.headers.get('Content-Disposition')).toBeNull();
  }

  test('同じワークスペースの別人とリーダーと管理者にも、本人の未添付は 404', async () => {
    const { row } = await storedFile(target);
    const otherMember = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    for (const person of [otherMember, target.leader, target.admin]) await expectHidden(row.id, person);
    expect((await download(target, row.id)).status).toBe(200);
  });

  test('本人でも今所属しないワークスペースの未添付は 404', async () => {
    const { row } = await storedFile(target, { workspaceId: target.otherWorkspace.id });
    await expectHidden(row.id);
  });

  test('別の組織の ID は同じ組織の無い ID と同じ 404', async () => {
    const other = await createTarget();
    const { row } = await storedFile(other);
    await expectHidden(row.id);
    expect((await download(other, row.id)).status).toBe(200);
  });

  test('入れない組織と存在しない slug は同じ 404', async () => {
    const other = await createTarget();
    const { row } = await storedFile(target);
    await expectHidden(row.id, other.member);
    await expectHidden(row.id, target.member, `missing-${crypto.randomUUID()}`);
  });

  test('招待だけの人は 404', async () => {
    const { row } = await storedFile(target);
    await expectHidden(row.id, target.invitee);
  });

  test('行があっても R2 の中身が無ければ 404', async () => {
    const { row } = await storedFile(target);
    await env.ATTACHMENTS.delete(row.object_key);
    await expectHidden(row.id);
  });

  test('行が無い R2 オブジェクトは ID から取得できない', async () => {
    const id = crypto.randomUUID();
    await env.ATTACHMENTS.put(`${target.organization.id}/${target.workspace.id}/${id}`, textBytes('secret'));
    await expectHidden(id);
  });

  test('他人の未添付と不正 Range を組み合わせても 416 を漏らさず 404', async () => {
    const { row } = await storedFile(target, { contentType: 'video/mp4' });
    const response = await download(target, row.id, { person: target.leader, headers: { Range: 'bytes=999999-' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Range')).toBeNull();
    expectDownloadHeaders(response);
    expect(await errorCodeOf(response)).toBe('not_found');
  });

  test('付く先がある行は本人・リーダー・管理者にも安全に 404', async () => {
    const [task, story, epic] = await Promise.all([
      createTask(target.organization, target.workspace.id, target.member.userId!),
      createStory(target.organization, target.workspace.id, target.member.userId!),
      createEpic(target.organization, target.workspace.id, target.member.userId!),
    ]);
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (const linked of [
      { task_id: task.id },
      { story_id: story.id },
      { epic_id: epic.id },
      { comment_id: comment.id },
    ]) {
      const { row } = await storedFile(target, { row: { ...linked, attached_at: new Date().toISOString() } });
      for (const person of [target.member, target.leader, target.admin]) await expectHidden(row.id, person);
    }
  });

  test('権限を拒否した要求では R2 の中身を読まない', async () => {
    const { row } = await storedFile(target);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, { person: target.admin, env: bindings });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    await response.arrayBuffer();
  });
});

describe('GET でも認証・同意・組織停止・トークンの門を通る', () => {
  test.each(['same-origin', 'none'])('Sec-Fetch-Site %s は通す', async (site) => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const response = await download(target, row.id, { headers: { 'Sec-Fetch-Site': site } });
    expect(response.status).toBe(200);
    expectDownloadHeaders(response);
    await response.arrayBuffer();
  });

  test.each([
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'https://outside.example' },
  ] as Record<string, string>[])('別サイトからの読み込み %j は 403', async (headers) => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const { env: bindings, calls } = recordingBucket();
    const response = await download(target, row.id, { headers, env: bindings });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
    expectDownloadHeaders(response);
    expect(calls).toEqual([]);
  });

  test.each([null, 'invalid', 'expired'])('セッション %s は 401', async (kind) => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const person =
      kind === null
        ? null
        : kind === 'invalid'
          ? { ...target.member, token: 'not-a-session' }
          : await createPerson({
              organization: target.organization,
              sessionOverrides: { expires_at: '2000-01-01T00:00:00.000Z' },
            });
    const response = await download(target, row.id, { person });
    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('unauthenticated');
    expectDownloadHeaders(response);
  });

  test('同意していなければ 403 terms_required', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, consented: false });
    const { row } = await storedFile(target, { person });
    const response = await download(target, row.id, { person });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('terms_required');
    expectDownloadHeaders(response);
  });

  test('停止した組織は 403 organization_suspended', async () => {
    const target = await createTarget({ suspended: true });
    const { row } = await storedFile(target);
    const response = await download(target, row.id);
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('organization_suspended');
    expectDownloadHeaders(response);
  });

  test('無効化されたユーザーは 404', async () => {
    const target = await createTarget();
    const person = await createPerson({ organization: target.organization, disabled: true });
    const { row } = await storedFile(target, { person });
    const response = await download(target, row.id, { person });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('not_found');
    expectDownloadHeaders(response);
  });

  test.each(['read', 'write'] as const)('API トークン %s だけでは 403', async (scope) => {
    const target = await createTarget();
    const { row } = await storedFile(target);
    const response = await download(target, row.id, { person: null, bearer: await bearerFor(target.member, scope) });
    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('forbidden');
    expectDownloadHeaders(response);
  });
});
