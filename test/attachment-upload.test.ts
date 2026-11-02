// 添付ファイルを上げる操作（attachment-upload。Issue #744）。入力はヘッダー X-Operation-Input、本文はファイルのバイト。
// 成功の応答と行と R2 の中身、申告の型を読まないこと、断る場合（400、413、403、404、409）とその順、断ったときに何も書かないことを見る。
// 組織の分離と権限の一覧の検査は test/operation-registry-production-*.test.ts が回す。ストリームと挿入の失敗は
// test/attachment-upload-runtime.test.ts
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import {
  MAX_BYTES,
  app,
  attachmentRows,
  nothingWritten,
  objectBytes,
  objectKeysOf,
  pngFile,
  textBytes,
  upload,
  type UploadOutput,
} from './attachment-helpers.ts';
import { createWorkspace } from './factories.ts';
import { bearerFor } from './operations/api-token.ts';
import { errorCodeOf, operationInputHeader, post } from './operations/harness.ts';
import { createTarget, testEnv, type Target } from './operations/world.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

// 断る検査の対照に使う組織。どの呼び出しも同じ理由で断る実装（今の登録は binary の本文を JSON でないとして 400 にする）で、
// 断る検査がたまたま通らないよう、断ったことを見るたびに、正しい呼び出しが別の組織で 200 になることも見る
let control: Promise<Target> | undefined;
async function expectValidUploadSucceeds(): Promise<void> {
  control ??= createTarget();
  const res = await upload(await control);
  expect(res.status, '対照: 正しい呼び出しは 200').toBe(200);
}

async function expectNothingWritten(target: Target): Promise<void> {
  expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  await expectValidUploadSucceeds();
}

describe('上げると、付く先のない行と R2 のファイルができる', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test('応答は id、file_name、content_type、size_bytes、created_at で、出力の形に合う', async () => {
    const file = pngFile(20);
    const res = await upload(target, { file, fileName: '画面の案.png' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(attachmentUpload.output.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['content_type', 'created_at', 'file_name', 'id', 'size_bytes']);
    expect(body.id).toMatch(UUID);
    expect(body).toMatchObject({ file_name: '画面の案.png', content_type: 'image/png', size_bytes: file.byteLength });
    expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
  });

  test('行は付く先なし、attached_at なし、uploaded_by は呼んだ人、size_bytes は Content-Length、キーは <組織>/<ワークスペース>/<id>', async () => {
    const file = pngFile(100);
    const res = await upload(target, { file, person: target.member });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    const row = (await attachmentRows(target)).find((item) => item.id === body.id);
    expect(row).toEqual({
      id: body.id,
      workspace_id: target.workspace.id,
      task_id: null,
      story_id: null,
      epic_id: null,
      comment_id: null,
      object_key: `${target.organization.id}/${target.workspace.id}/${body.id}`,
      file_name: '画面の案.png',
      content_type: 'image/png',
      size_bytes: file.byteLength,
      uploaded_by: target.member.userId,
      attached_at: null,
      created_at: body.created_at,
    });
  });

  test('R2 に、行の object_key と同じキーで、送ったのと同じバイトが入る', async () => {
    const file = pngFile(300);
    const res = await upload(target, { file });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    const key = `${target.organization.id}/${target.workspace.id}/${body.id}`;
    expect(await objectKeysOf(target.organization.id)).toContain(key);
    expect(await objectBytes(key)).toEqual(file);
  });

  test('リーダーと、所属していない管理者も上げられ、uploaded_by はそれぞれの人', async () => {
    for (const person of [target.leader, target.admin]) {
      const res = await upload(target, { person });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as UploadOutput;
      const row = (await attachmentRows(target)).find((item) => item.id === id);
      expect(row?.uploaded_by).toBe(person.userId);
    }
  });

  test('管理者は所属していない別のワークスペースにも上げられ、キーはそのワークスペースの ID を持つ', async () => {
    const res = await upload(target, { person: target.admin, workspaceId: target.otherWorkspace.id });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as UploadOutput;
    const row = (await attachmentRows(target, target.otherWorkspace.id)).find((item) => item.id === id);
    expect(row?.object_key).toBe(`${target.organization.id}/${target.otherWorkspace.id}/${id}`);
    expect(await objectKeysOf(target.organization.id)).toContain(row!.object_key);
  });

  test('ファイル名は前後の空白を除いて保存し、応答も同じ値', async () => {
    const res = await upload(target, { fileName: '  議事録 2026-11.pdf　 ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body.file_name).toBe('議事録 2026-11.pdf');
    const row = (await attachmentRows(target)).find((item) => item.id === body.id);
    expect(row?.file_name).toBe('議事録 2026-11.pdf');
  });

  test('ファイル名はコードポイントで 255 字まで（絵文字の 255 字は UTF-16 で 510 でも通る）', async () => {
    for (const name of ['あ'.repeat(255), '📎'.repeat(255), 'a'.repeat(251) + '.png']) {
      const res = await upload(target, { fileName: name });
      expect(res.status, `${[...name].length} 字`).toBe(200);
      const body = (await res.json()) as UploadOutput;
      expect(body.file_name).toBe(name);
    }
  });

  test('1 バイトのファイルも上げられ、size_bytes は 1', async () => {
    const res = await upload(target, { file: new Uint8Array([0x41]) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body).toMatchObject({ size_bytes: 1, content_type: 'application/octet-stream' });
  });

  test('書き込みの API トークンでも上げられ、Origin が無くてもよい', async () => {
    const res = await post(app, attachmentUpload, {
      slug: target.slug,
      bearer: await bearerFor(target.member, 'write'),
      origin: null,
      body: { workspace_id: target.workspace.id, file_name: 'トークン.png' },
      file: pngFile(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect((await attachmentRows(target)).find((item) => item.id === body.id)?.uploaded_by).toBe(target.member.userId);
  });

  test('同じファイルを2回上げると、別の ID と別のキーの行が2つできる', async () => {
    const file = pngFile(4);
    const first = (await (await upload(target, { file })).json()) as UploadOutput;
    const second = (await (await upload(target, { file })).json()) as UploadOutput;
    expect(first.id).not.toBe(second.id);
    const keys = (await attachmentRows(target)).map((row) => row.object_key);
    expect(keys).toEqual(
      expect.arrayContaining([
        `${target.organization.id}/${target.workspace.id}/${first.id}`,
        `${target.organization.id}/${target.workspace.id}/${second.id}`,
      ]),
    );
  });
});

describe('種類は中身の先頭のバイトで決め、拡張子と申告の Content-Type を読まない', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  async function uploadedType(fileName: string, file: Uint8Array, declared?: string): Promise<string> {
    const res = await upload(target, {
      fileName,
      file,
      ...(declared === undefined ? {} : { headers: { 'Content-Type': declared } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    const row = (await attachmentRows(target)).find((item) => item.id === body.id);
    expect(row?.content_type).toBe(body.content_type);
    return body.content_type;
  }

  test.each([
    ['テキストを png と偽る', '写真.png', textBytes('ただの文章です'), 'image/png'],
    ['HTML を png と偽る', 'logo.png', textBytes('<!DOCTYPE html><html><script>alert(1)</script></html>'), 'image/png'],
    [
      'SVG を png と偽る',
      'icon.png',
      textBytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      'image/png',
    ],
    ['SVG を svg として申告', 'icon.svg', textBytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    ['HTML を html として申告', 'page.html', textBytes('<html></html>'), 'text/html'],
    ['テキストを mp4 と偽る', '動画.mp4', textBytes('not a video at all'), 'video/mp4'],
  ])('%s と application/octet-stream', async (_label, fileName, file, declared) => {
    expect(await uploadedType(fileName, file, declared)).toBe('application/octet-stream');
  });

  test('本物の PNG は、拡張子が txt で申告が text/plain でも image/png', async () => {
    expect(await uploadedType('メモ.txt', pngFile(), 'text/plain')).toBe('image/png');
  });

  test('申告の Content-Type が無くても、先頭のバイトで決める', async () => {
    expect(await uploadedType('無題', pngFile(), '')).toBe('image/png');
  });

  test.each([
    ['JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg'],
    ['GIF', textBytes('GIF89a\u0001\u0000'), 'image/gif'],
    ['WebP', new Uint8Array([...textBytes('RIFF'), 0x24, 0, 0, 0, ...textBytes('WEBPVP8 ')]), 'image/webp'],
    ['MP4', new Uint8Array([0, 0, 0, 0x18, ...textBytes('ftypisom'), 0, 0, 2, 0]), 'video/mp4'],
    ['HEIC', new Uint8Array([0, 0, 0, 0x18, ...textBytes('ftypheic'), 0, 0, 0, 0]), 'application/octet-stream'],
  ])('%s の中身を、名前 x.bin と申告 application/octet-stream で上げる', async (_label, file, expected) => {
    expect(await uploadedType('x.bin', file, 'application/octet-stream')).toBe(expected);
  });
});

describe('ヘッダーの入力が無いか壊れていると、何も書かずに 400 の invalid_input', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  // ヘッダーの値を直に決めて送る（null は付けない）
  async function sendWithInputHeader(value: string | null, extraHeaders: Record<string, string> = {}) {
    const file = pngFile();
    const headers = new Headers({
      Origin: testEnv.PUBLIC_ORIGIN,
      Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.member.token}`,
      'Content-Length': String(file.byteLength),
      ...extraHeaders,
    });
    if (value !== null) headers.set('X-Operation-Input', value);
    return app.request(`/api/${target.slug}/attachment-upload`, { method: 'POST', headers, body: file }, testEnv);
  }

  const valid = () => ({ workspace_id: target.workspace.id, file_name: '画面の案.png' });

  test('X-Operation-Input が無い', async () => {
    await expectError(await sendWithInputHeader(null), 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test('X-Operation-Input が空', async () => {
    await expectError(await sendWithInputHeader(''), 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test('URL の復号に失敗する', async () => {
    for (const value of ['%E0%A4%A', '%', '%7B%22workspace_id%22%3A%ZZ']) {
      await expectError(await sendWithInputHeader(value), 400, 'invalid_input');
    }
    await expectNothingWritten(target);
  });

  test('復号できても JSON でない', async () => {
    for (const value of ['{broken', 'workspace_id=1', 'null', '']) {
      await expectError(await sendWithInputHeader(encodeURIComponent(value) || 'x'), 400, 'invalid_input');
    }
    await expectNothingWritten(target);
  });

  test('JSON がスキーマに合わない', async () => {
    for (const input of [
      [],
      'text',
      42,
      {},
      { workspace_id: target.workspace.id },
      { file_name: '画面の案.png' },
      { workspace_id: 1, file_name: '画面の案.png' },
      { workspace_id: target.workspace.id, file_name: 7 },
      { workspace_id: 'x'.repeat(65), file_name: '画面の案.png' },
    ]) {
      await expectError(await sendWithInputHeader(operationInputHeader(input)), 400, 'invalid_input');
    }
    await expectNothingWritten(target);
  });

  test('日本語のファイル名を encodeURIComponent したヘッダーは、復号して読む', async () => {
    const res = await sendWithInputHeader(operationInputHeader(valid()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadOutput).file_name).toBe('画面の案.png');
  });

  test('入力を JSON の本文で送っても読まない（ヘッダーが無ければ 400）', async () => {
    const res = await app.request(
      `/api/${target.slug}/attachment-upload`,
      {
        method: 'POST',
        headers: {
          Origin: testEnv.PUBLIC_ORIGIN,
          Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.member.token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(JSON.stringify(valid()).length),
        },
        body: JSON.stringify(valid()),
      },
      testEnv,
    );
    await expectError(res, 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test('入力を URL のクエリで送っても読まない', async () => {
    const file = pngFile();
    const query = new URLSearchParams(valid()).toString();
    const res = await app.request(
      `/api/${target.slug}/attachment-upload?${query}`,
      {
        method: 'POST',
        headers: {
          Origin: testEnv.PUBLIC_ORIGIN,
          Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.member.token}`,
          'Content-Length': String(file.byteLength),
        },
        body: file,
      },
      testEnv,
    );
    await expectError(res, 400, 'invalid_input');
    await expectNothingWritten(target);
  });
});

describe('ファイル名が使えないと、何も書かずに 400 の invalid_input', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['全角の空白だけ', '　　'],
    ['ゼロ幅の空白だけ', '​'],
    ['256 字', 'あ'.repeat(256)],
    ['絵文字の 256 字', '📎'.repeat(256)],
    ['NUL を含む', 'a\u0000.png'],
    ['NUL で切ると拡張子が変わる', 'report.pdf\u0000.png'],
    ['BEL を含む', 'a\u0007.png'],
    ['改行を含む', 'a\nb.png'],
    ['タブを含む', 'a\tb.png'],
    ['DEL を含む', 'a\u007f.png'],
    ['C1 の制御文字を含む', 'a\u0085.png'],
    ['向きを変える制御を含む', 'gnp‮.exe'],
    ['ゼロ幅の空白を含む', 'a​b.png'],
    ['BOM を含む', '﻿a.png'],
    ['行の区切りを含む', 'a b.png'],
  ])('%s', async (_label, fileName) => {
    await expectError(await upload(target, { fileName }), 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test('前後の空白を除いて 255 字なら通る（除く前は 257 字）', async () => {
    const res = await upload(target, { fileName: ` ${'あ'.repeat(255)} ` });
    expect(res.status).toBe(200);
  });
});

describe('Content-Length が無いか使えないと 400、50MB を超えると本文を読まずに 413', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test('Content-Length が無い', async () => {
    await expectError(await upload(target, { contentLength: null }), 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test('Content-Length が 0（本文も空）', async () => {
    await expectError(await upload(target, { file: new Uint8Array(0), contentLength: '0' }), 400, 'invalid_input');
    await expectNothingWritten(target);
  });

  test.each(['abc', '-1', '1.5', '1e3', '0x10', '', '12abc', '9'.repeat(30)])(
    'Content-Length が 0 以上の整数でない（%j）',
    async (value) => {
      const res = await upload(target, { contentLength: value });
      // 30 桁の 9 は整数の形だが 50MB を超えるので 413
      if (value === '9'.repeat(30)) await expectError(res, 413, 'invalid_input');
      else await expectError(res, 400, 'invalid_input');
      await expectNothingWritten(target);
    },
  );

  test('Content-Length が 52428801 なら 413 の invalid_input', async () => {
    await expectError(await upload(target, { contentLength: String(MAX_BYTES + 1) }), 413, 'invalid_input');
    await expectNothingWritten(target);
  });
});

describe('断る順: 認証、組織、権限、トークンの範囲 → ヘッダーの入力 → Content-Length → ワークスペース', () => {
  let target: Target;
  let other: Target;
  beforeAll(async () => {
    [target, other] = await Promise.all([createTarget(), createTarget()]);
  });

  test('ログインしていなければ、Content-Length が上限を超えていても 401', async () => {
    const res = await post(app, attachmentUpload, {
      slug: target.slug,
      body: { workspace_id: target.workspace.id, file_name: 'a.png' },
      contentLength: String(MAX_BYTES + 1),
    });
    await expectError(res, 401, 'unauthenticated');
  });

  test('読み取りのトークンは、入力のヘッダーが無くても 403', async () => {
    const res = await post(app, attachmentUpload, {
      slug: target.slug,
      bearer: await bearerFor(target.member, 'read'),
      rawBody: pngFile(),
    });
    await expectError(res, 403, 'forbidden');
    const ok = await post(app, attachmentUpload, {
      slug: target.slug,
      bearer: await bearerFor(target.member, 'read'),
      body: { workspace_id: target.workspace.id, file_name: 'a.png' },
    });
    await expectError(ok, 403, 'forbidden');
    // 範囲の検査は今の登録の順なので、対照（正しい呼び出しの 200）は見ない
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });

  test('別の組織のワークスペースでも、ファイル名が使えなければ 400（404 より先）', async () => {
    await expectError(await upload(target, { workspaceId: other.workspace.id, fileName: '' }), 400, 'invalid_input');
    // 対照: ファイル名が使えれば 404
    await expectError(await upload(target, { workspaceId: other.workspace.id }), 404, 'not_found');
  });

  test('別の組織のワークスペースでも、Content-Length が無ければ 400、上限を超えれば 413（404 より先）', async () => {
    await expectError(await upload(target, { workspaceId: other.workspace.id }), 404, 'not_found');
    await expectError(
      await upload(target, { workspaceId: other.workspace.id, contentLength: null }),
      400,
      'invalid_input',
    );
    await expectError(
      await upload(target, { workspaceId: other.workspace.id, contentLength: String(MAX_BYTES + 1) }),
      413,
      'invalid_input',
    );
  });

  test('所属していない人でも、Content-Length が 0 なら 400（403 より先）', async () => {
    await expectError(
      await upload(target, { person: target.bystander, file: new Uint8Array(0), contentLength: '0' }),
      400,
      'invalid_input',
    );
    // 対照: 中身があれば 403
    await expectError(await upload(target, { person: target.bystander }), 403, 'forbidden');
  });

  test('閉じたワークスペースでも、上限を超えれば 413（409 より先）', async () => {
    const closed = await createTarget({ closed: true });
    await expectError(
      await upload(closed, { person: closed.admin, contentLength: String(MAX_BYTES + 1) }),
      413,
      'invalid_input',
    );
    await expectNothingWritten(closed);
  });
});

describe('ワークスペースの確かめ: 別の組織と無いワークスペースは 404、所属していなければ 403、閉じていれば 409', () => {
  let target: Target;
  let other: Target;
  beforeAll(async () => {
    [target, other] = await Promise.all([createTarget(), createTarget()]);
  });

  test('別の組織のワークスペースの ID は 404 の not_found で、どちらの組織にも何も書かない', async () => {
    for (const person of [target.member, target.admin]) {
      await expectError(await upload(target, { person, workspaceId: other.workspace.id }), 404, 'not_found');
    }
    await expectNothingWritten(target);
    await expectNothingWritten(other);
    // 別の組織の ID で始まるキーも、呼んだ組織の ID と別の組織のワークスペースの ID を組んだキーも無い
    const keys = await env.ATTACHMENTS.list({ prefix: `${target.organization.id}/${other.workspace.id}/` });
    expect(keys.objects).toEqual([]);
  });

  test('別の組織の人が、その組織の slug で上げても 404', async () => {
    await expectError(await upload(target, { person: other.admin }), 404, 'not_found');
    // 組織に入る検査は今の登録の順なので、対照は見ない
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
    expect(await nothingWritten(other)).toEqual({ rows: 0, objects: [] });
  });

  test('存在しないワークスペースの ID は 404', async () => {
    await expectError(await upload(target, { workspaceId: crypto.randomUUID() }), 404, 'not_found');
    await expectNothingWritten(target);
  });

  test('同じ組織の、所属していないワークスペースへは 403 の forbidden で、何も書かない', async () => {
    await expectError(
      await upload(target, { person: target.member, workspaceId: target.otherWorkspace.id }),
      403,
      'forbidden',
    );
    await expectError(await upload(target, { person: target.bystander }), 403, 'forbidden');
    await expectNothingWritten(target);
  });

  test('承諾待ちの招待だけの人は 404', async () => {
    await expectError(await upload(target, { person: target.invitee }), 404, 'not_found');
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });

  test('閉じたワークスペースは、管理者でも 409 の workspace_closed で、何も書かない', async () => {
    const closed = await createTarget({ closed: true });
    for (const person of [closed.admin, closed.leader, closed.member]) {
      await expectError(await upload(closed, { person }), 409, 'workspace_closed');
    }
    await expectNothingWritten(closed);
  });

  test('同じ組織に後から作ったワークスペースにも、管理者は上げられる（キーは入力のワークスペース）', async () => {
    const workspace = await createWorkspace(target.organization, target.admin.userId!);
    const res = await upload(target, { person: target.admin, workspaceId: workspace.id });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as UploadOutput;
    const [row] = await attachmentRows(target, workspace.id);
    expect(row?.object_key).toBe(`${target.organization.id}/${workspace.id}/${id}`);
  });
});
