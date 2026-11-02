// attachment-upload（#744）を崩しにいくテストの2周目。登録の層の変更がバイナリでない操作を変えていないか、
// body: 'binary' を組織の直下と allowClosed に付けた定義、応答の後の R2 と D1 の整合、断る順が存在を漏らさないかを見る
/* eslint-disable db-entry/guard -- セッションの最終利用の日時を、入口を通さず D1 に直に戻すため */
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { implement } from '../src/server/operations/implement.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import {
  MAX_BYTES,
  PNG_HEAD,
  attachmentRows,
  failInsertsInto,
  nothingWritten,
  objectBytes,
  pngFile,
  textBytes,
  upload,
  type UploadOutput,
} from './attachment-helpers.ts';
import { errorCodeOf, operationInputHeader, post } from './operations/harness.ts';
import { provisionalOperations, renameWorkspace } from './operations/provisional.ts';
import { createTarget, testEnv } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const cookieName = sessionCookieName(testEnv.PUBLIC_ORIGIN);

async function workspaceName(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(id).first<{ name: string }>();
  return row?.name;
}

// 前回の利用から2時間たったセッションにする（次の呼び出しで期限と Cookie を延ばす）
async function makeSessionStale(accountId: string): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE account_id = ?')
    .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), accountId)
    .run();
}

describe('登録の層の変更は、バイナリでない操作の入力の読み方を変えない', () => {
  const app = createApp(provisionalOperations);

  test('JSON の操作に X-Operation-Input を付け、本文を JSON にしなければ 400 で、処理は動かない', async () => {
    const target = await createTarget();
    const before = await workspaceName(target.workspace.id);
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      token: target.leader.token,
      rawBody: pngFile(),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Operation-Input': operationInputHeader({ workspace_id: target.workspace.id, name: 'ヘッダーの名前' }),
      },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await workspaceName(target.workspace.id)).toBe(before);
  });

  test('JSON の操作は、X-Operation-Input があっても本文の JSON を入力にする', async () => {
    const target = await createTarget();
    const res = await post(app, renameWorkspace, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id, name: '本文の名前' },
      headers: {
        'X-Operation-Input': operationInputHeader({ workspace_id: target.otherWorkspace.id, name: 'ヘッダーの名前' }),
      },
    });
    expect(res.status).toBe(200);
    expect(await workspaceName(target.workspace.id)).toBe('本文の名前');
    expect(await workspaceName(target.otherWorkspace.id)).not.toBe('ヘッダーの名前');
  });

  test('JSON の操作の処理には binary も requestId も渡さない', async () => {
    const probe = defineOperation({
      name: 'json-context-probe',
      description: '処理が受け取る文脈の鍵を返す',
      mode: 'write',
      permission: 'member',
      workspace: true,
      input: z.object({ workspace_id: z.string() }),
      output: z.object({ keys: z.array(z.string()) }),
    });
    const probeApp = createApp([implement(probe, async (context) => ({ keys: Object.keys(context).sort() }))]);
    const target = await createTarget();
    const res = await post(probeApp, probe, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
      headers: { 'Content-Length': '999999999' },
    });
    // Content-Length を偽っても、JSON の操作は 1MiB の上限で 413 にする（binary の検査に回さない）
    expect(res.status).toBe(413);
    const ok = await post(probeApp, probe, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(ok.status).toBe(200);
    const { keys } = (await ok.json()) as { keys: string[] };
    expect(keys).not.toContain('binary');
    expect(keys).not.toContain('requestId');
  });
});

describe('body: binary を組織の直下と allowClosed の定義に付けても、本文の検査と受け渡しは同じ', () => {
  const organizationBinary = defineOperation({
    name: 'organization-binary-probe',
    description: '組織の直下の binary の操作。受け取った長さとバイトを返す',
    mode: 'write',
    permission: 'organization',
    body: 'binary',
    input: z.object({ label: z.string().min(1) }),
    output: z.object({ length: z.number(), bytes: z.array(z.number()), has_workspace: z.boolean() }),
  });
  const closedBinary = defineOperation({
    name: 'closed-binary-probe',
    description: '閉じたワークスペースでも通す binary の操作',
    mode: 'write',
    permission: 'admin',
    workspace: true,
    allowClosed: true,
    body: 'binary',
    input: z.object({ workspace_id: z.string() }),
    output: z.object({ length: z.number(), closed: z.boolean() }),
  });
  const probeApp = createApp([
    implement(organizationBinary, async (context) => {
      const { binary } = context as unknown as { binary: { body: ReadableStream<Uint8Array>; contentLength: number } };
      const bytes = new Uint8Array(await new Response(binary.body).arrayBuffer());
      return { length: binary.contentLength, bytes: [...bytes], has_workspace: 'workspace' in context };
    }),
    implement(closedBinary, async (context) => {
      const { binary } = context as unknown as { binary: { body: ReadableStream<Uint8Array>; contentLength: number } };
      await binary.body.cancel();
      return { length: binary.contentLength, closed: context.workspace.closed };
    }),
  ]);

  test('組織の直下の binary の操作は、ヘッダーの入力と本文のストリームと長さを受け取る', async () => {
    const target = await createTarget();
    const file = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await post(probeApp, organizationBinary, {
      slug: target.slug,
      token: target.bystander.token,
      body: { label: 'x' },
      file,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 5, bytes: [1, 2, 3, 4, 5], has_workspace: false });
  });

  test('組織の直下の binary の操作も、上限を超えれば 413、Content-Length が無ければ 400、ヘッダーが無ければ 400', async () => {
    const target = await createTarget();
    const over = await post(probeApp, organizationBinary, {
      slug: target.slug,
      token: target.member.token,
      body: { label: 'x' },
      contentLength: String(MAX_BYTES + 1),
    });
    expect(over.status).toBe(413);
    const missing = await post(probeApp, organizationBinary, {
      slug: target.slug,
      token: target.member.token,
      body: { label: 'x' },
      contentLength: null,
    });
    expect(missing.status).toBe(400);
    const noHeader = await post(probeApp, organizationBinary, {
      slug: target.slug,
      token: target.member.token,
      rawBody: new Uint8Array([1]),
    });
    expect(noHeader.status).toBe(400);
  });

  test('allowClosed の binary の操作は、閉じたワークスペースでも 409 にせず処理まで届く', async () => {
    const target = await createTarget({ closed: true });
    const res = await post(probeApp, closedBinary, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: target.workspace.id },
      file: new Uint8Array([9, 9]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 2, closed: true });
  });
});

describe('バイナリの操作でも、セッションの期限を延ばす Cookie は成功と失敗の両方に付く', () => {
  test('成功の 200 に延ばす Cookie が付く', async () => {
    const target = await createTarget();
    await makeSessionStale(target.member.accountId);
    const res = await upload(target);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie') ?? '').toContain(`${cookieName}=${target.member.token}`);
  });

  test('本文を読まずに断る 413 にも延ばす Cookie が付き、Max-Age=0 は付かない', async () => {
    const target = await createTarget();
    await makeSessionStale(target.member.accountId);
    const res = await upload(target, { contentLength: String(MAX_BYTES + 1) });
    expect(res.status).toBe(413);
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${cookieName}=${target.member.token}`);
    expect(cookie).not.toContain('Max-Age=0');
  });
});

describe('断る順は、組織に入れない人へ組織の有無を漏らさない', () => {
  test('入れない組織の slug と無い slug は、入力のヘッダーが無くても上限を超えていても、同じ 404', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const cases = [
      { contentLength: String(MAX_BYTES + 1) },
      { input: 'not-an-object', contentLength: '8' },
      { contentLength: '0', file: new Uint8Array(0) },
    ];
    for (const options of cases) {
      const existing = await upload(target, { person: other.member, workspaceId: other.workspace.id, ...options });
      const missing = await upload(
        { ...target, slug: 'no-such-organization-744' },
        { person: other.member, workspaceId: other.workspace.id, ...options },
      );
      expect(existing.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await existing.json()).toEqual(await missing.json());
    }
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });
});

describe('応答の後の R2 と D1 の整合', () => {
  test('宣言どおりの長さを送り終えた直後にストリームが失敗したら、500 で行も R2 のファイルも残らない', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = pngFile(56);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) controller.error(new Error('送り終えた後に切れた'));
          else {
            sent = true;
            controller.enqueue(file);
          }
        },
      },
      { highWaterMark: 0 },
    );
    const res = await upload(target, { file: stream, contentLength: String(file.byteLength) });
    // 宣言の長さが揃っていても、本文の終わりが失敗なら保存しない（put と pumping のどちらが先に決まっても）
    expect(res.status).toBe(500);
    expect(await nothingWritten(target)).toEqual({ rows: 0, objects: [] });
  });

  test('同時に上げた2つのうち片方の挿入が失敗しても、もう片方の行と R2 のファイルは消えない', async () => {
    const target = await createTarget();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const restore = await failInsertsInto(target.workspace.id);
    try {
      const good = pngFile(300);
      const [failed, succeeded] = await Promise.all([
        upload(target, { file: pngFile(200) }),
        upload(target, { person: target.admin, workspaceId: target.otherWorkspace.id, file: good }),
      ]);
      expect(failed.status).toBe(500);
      expect(succeeded.status).toBe(200);
      const body = (await succeeded.json()) as UploadOutput;
      expect(await attachmentRows(target, target.workspace.id)).toHaveLength(0);
      const [row] = await attachmentRows(target, target.otherWorkspace.id);
      expect(row?.id).toBe(body.id);
      const { objects } = await nothingWritten(target);
      expect(objects).toEqual([row!.object_key]);
      expect(await objectBytes(row!.object_key)).toEqual(good);
    } finally {
      await restore();
    }
  });

  test('同時に2つ上げると、それぞれの行のキーにそれぞれのバイトが入る', async () => {
    const target = await createTarget();
    const a = pngFile(100);
    const b = textBytes('GIF89a 同時に上げた2つめ');
    const [resA, resB] = await Promise.all([upload(target, { file: a }), upload(target, { file: b })]);
    const [outA, outB] = [(await resA.json()) as UploadOutput, (await resB.json()) as UploadOutput];
    expect([outA.content_type, outB.content_type]).toEqual(['image/png', 'image/gif']);
    const rows = await attachmentRows(target);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(await objectBytes(byId.get(outA.id)!.object_key)).toEqual(a);
    expect(await objectBytes(byId.get(outB.id)!.object_key)).toEqual(b);
    expect(byId.get(outB.id)!.size_bytes).toBe(b.byteLength);
  });

  test.each([
    ['PNG の中身を text/html と申告', pngFile(), 'text/html', 'image/png'],
    [
      'HTML の中身を image/png と申告',
      textBytes('<html><script>alert(1)</script></html>'),
      'image/png',
      'application/octet-stream',
    ],
  ])('R2 の httpMetadata の型は、行と同じ判定した型（%s）', async (_label, file, declared, expected) => {
    const target = await createTarget();
    const res = await upload(target, { file, headers: { 'Content-Type': declared } });
    expect(res.status).toBe(200);
    const [row] = await attachmentRows(target);
    expect(row?.content_type).toBe(expected);
    const head = await env.ATTACHMENTS.head(row!.object_key);
    expect(head?.httpMetadata?.contentType).toBe(expected);
  });

  test('入力に余計な organization_id、id、object_key を入れても、キーと ID は確かめた値と新しい ID で作る', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const res = await upload(target, {
      input: {
        workspace_id: target.workspace.id,
        file_name: 'a.png',
        organization_id: other.organization.id,
        id: 'fixed-id',
        object_key: `${other.organization.id}/${other.workspace.id}/fixed-id`,
      },
      file: concatHead(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadOutput;
    expect(body.id).not.toBe('fixed-id');
    const [row] = await attachmentRows(target);
    expect(row?.object_key).toBe(`${target.organization.id}/${target.workspace.id}/${body.id}`);
    expect(await nothingWritten(other)).toEqual({ rows: 0, objects: [] });
  });
});

function concatHead(): Uint8Array {
  const out = new Uint8Array(PNG_HEAD.byteLength + 4);
  out.set(PNG_HEAD);
  return out;
}
