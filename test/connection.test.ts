// 接続の操作（一覧、登録、範囲の候補、範囲の保存）の固有の振る舞い。権限の種類ごとの許可と拒否、組織の分離は
// 一覧を回す test/operation-registry*.test.ts が確かめる。ここでは認証情報が応答と DB と履歴に平文で残らないこと、
// 取り込み元の拒否と不調、本人だけの操作、範囲の置き換え、閉じたワークスペースを見る。取り込み元は偽の GitHub（PAT）に向ける
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  connectionCreate,
  connectionList,
  connectionScopeCandidates,
  connectionScopesSave,
} from '../src/shared/operations/connection/index.ts';
import { createApp } from '../src/server/app.ts';
import { decryptCredential } from '../src/server/crypto/credential.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createFakePatGithub, fakePat, fakeRepos } from './import/fake-github-pat.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

function setup() {
  const github = createFakePatGithub();
  const app = createApp(implementedOperations, { fetcher: github.fetcher });
  return { github, app };
}

const OWNER = { type: 'User', id: 7_100_001, login: 'aoba-dev' };

async function register(
  ctx: ReturnType<typeof setup>,
  target: Target,
  person: Person,
  pat: string,
  name = 'あおばの GitHub',
) {
  return post(ctx.app, connectionCreate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, provider: 'github', name, credential: pat },
  });
}

async function rowsOf(target: Target) {
  const db = orgDb(env, target.organization.verified);
  const connections = await db.rows(
    db.statement((q) => q.selectFrom('connections').selectAll().where('workspace_id', '=', target.workspace.id)),
  );
  const scopes = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('connection_scopes as s')
        .innerJoin('connections as c', 'c.id', 's.connection_id')
        .select(['s.connection_id', 's.scope_kind', 's.source_id', 's.source_name'])
        .where('c.workspace_id', '=', target.workspace.id),
    ),
  );
  const logs = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'connection')
        .where('organization_id', '=', db.organizationId),
    ),
  );
  return { connections, scopes, logs };
}

describe('connection-create', () => {
  test('有効な PAT で登録でき、応答と一覧に末尾4文字だけが出て、PAT も暗号文も出ない。範囲は空', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('register1');
    ctx.github.addAccount(pat, OWNER, fakeRepos(2));

    const res = await register(ctx, target, target.member, pat);
    expect(res.status).toBe(200);
    const text = await res.text();
    const { connection } = JSON.parse(text);
    expect(connection).toMatchObject({
      provider: 'github',
      name: 'あおばの GitHub',
      status: 'active',
      scope_mode: 'include',
      scopes: [],
      credential_last4: pat.slice(-4),
      owner_user_id: target.member.userId,
    });
    expect(text).not.toContain(pat);
    expect(text).not.toContain('ciphertext');

    const list = await post(ctx.app, connectionList, {
      slug: target.slug,
      token: target.leader.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(JSON.parse(listText).connections).toEqual([connection]);
    expect(listText).not.toContain(pat);
    expect(listText).not.toContain('ciphertext');
    expect(listText).not.toContain('sync_state');
  });

  test('DB には暗号文だけが入り、接続の ID に結んで復号でき、履歴に認証情報は出ない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('register2');
    ctx.github.addAccount(pat, OWNER, []);

    const { connection } = (await (await register(ctx, target, target.member, pat)).json()) as {
      connection: { id: string };
    };
    const { connections, scopes, logs } = await rowsOf(target);
    expect(connections).toHaveLength(1);
    const row = connections[0]!;
    expect(row.credential_ciphertext).not.toBeNull();
    expect(row.credential_ciphertext).not.toContain(pat);
    expect(JSON.stringify(row)).not.toContain(pat);
    expect(
      await decryptCredential(
        env,
        { ciphertext: row.credential_ciphertext!, keyVersion: Number(row.credential_key_version) },
        connection.id,
      ),
    ).toBe(pat);
    expect(scopes).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entity_id: connection.id, action: 'create', actor_user_id: target.member.userId });
    expect(JSON.stringify(logs)).not.toContain(pat);
  });

  test('形の違う PAT は取り込み元に問い合わせずに 400 で断られ、登録されない', async () => {
    const ctx = setup();
    const target = await createTarget();

    for (const credential of ['ghp_classic0123456789abcdefghijklmnopqrstuv', 'github_pat_short', '']) {
      const res = await register(ctx, target, target.member, credential);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
    }
    expect(ctx.github.calls).toHaveLength(0);
    expect((await rowsOf(target)).connections).toHaveLength(0);
  });

  test('知らない取り込み元の種類は 400 で断られる', async () => {
    const ctx = setup();
    const target = await createTarget();
    const res = await post(ctx.app, connectionCreate, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id, provider: 'gitlab', name: '名前', credential: fakePat('x') },
    });
    expect(res.status).toBe(400);
    expect(ctx.github.calls).toHaveLength(0);
  });

  test('取り込み元が受け付けない PAT は 400 で、登録されない', async () => {
    const ctx = setup();
    const target = await createTarget();
    // 偽の GitHub に知られていない PAT は 401
    const res = await register(ctx, target, target.member, fakePat('unknown'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { code: string }[] } };
    expect(body.error.details[0]!.code).toBe('credential_rejected');
    expect(ctx.github.calls).toHaveLength(1);
    expect((await rowsOf(target)).connections).toHaveLength(0);
  });

  test('取り込み元に届かないときは 503 で、登録されない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('down');
    ctx.github.addAccount(pat, OWNER, []);
    ctx.github.failNext({ kind: 'status', status: 502 });

    const res = await register(ctx, target, target.member, pat);
    expect(res.status).toBe(503);
    expect((await rowsOf(target)).connections).toHaveLength(0);
  });

  test('表示名の前後の空白は取り、空は 400', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('names');
    ctx.github.addAccount(pat, OWNER, []);

    const blank = await register(ctx, target, target.member, pat, '   ');
    expect(blank.status).toBe(400);
    const ok = await register(ctx, target, target.member, pat, '  あおば  ');
    expect(((await ok.json()) as { connection: { name: string } }).connection.name).toBe('あおば');
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、取り込み元にも問い合わせない', async () => {
    const ctx = setup();
    const target = await createTarget({ closed: true });
    const pat = fakePat('closed');
    ctx.github.addAccount(pat, OWNER, []);

    const res = await register(ctx, target, target.member, pat);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_closed');
    expect(ctx.github.calls).toHaveLength(0);
    expect((await rowsOf(target)).connections).toHaveLength(0);
  });
});

async function registered(ctx: ReturnType<typeof setup>, target: Target, person: Person, seed: string) {
  const pat = fakePat(seed);
  ctx.github.addAccount(pat, OWNER, [
    { id: 1001, full_name: 'aoba-dev/shop' },
    { id: 1002, full_name: 'aoba-dev/blog' },
  ]);
  const res = await register(ctx, target, person, pat);
  expect(res.status).toBe(200);
  const { connection } = (await res.json()) as { connection: { id: string } };
  return { pat, id: connection.id };
}

function candidates(ctx: ReturnType<typeof setup>, target: Target, person: Person, connectionId: string) {
  return post(ctx.app, connectionScopeCandidates, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, connection_id: connectionId },
  });
}

function save(ctx: ReturnType<typeof setup>, target: Target, person: Person, connectionId: string, ids: string[]) {
  return post(ctx.app, connectionScopesSave, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, connection_id: connectionId, source_ids: ids },
  });
}

describe('connection-scope-candidates', () => {
  test('登録した本人には保存した認証情報で候補を返し、PAT は応答に出ない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { pat, id } = await registered(ctx, target, target.member, 'cand1');

    const res = await candidates(ctx, target, target.member, id);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).candidates).toEqual([
      { id: '1001', name: 'aoba-dev/shop' },
      { id: '1002', name: 'aoba-dev/blog' },
    ]);
    expect(text).not.toContain(pat);
    // 取り込み元には、復号した PAT で問い合わせる
    expect(ctx.github.calls.at(-1)!.headers['authorization']).toBe(`Bearer ${pat}`);
  });

  test('ほかのメンバーは 403、リーダーと管理者の本人でない呼び出しも 403。取り込み元に問い合わせない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'cand2');
    const before = ctx.github.calls.length;

    for (const person of [target.leader, target.admin]) {
      const res = await candidates(ctx, target, person, id);
      expect(res.status).toBe(403);
    }
    expect(ctx.github.calls).toHaveLength(before);
  });

  test('別の組織の接続の ID は 404、別のワークスペースの接続も 404', async () => {
    const ctx = setup();
    const target = await createTarget();
    const other = await createTarget();
    const foreign = await registered(ctx, other, other.member, 'cand3');

    expect((await candidates(ctx, target, target.member, foreign.id)).status).toBe(404);
    expect((await candidates(ctx, target, target.member, 'no-such-connection')).status).toBe(404);
  });

  test('保存した認証情報を取り込み元が受け付けなくなったら 409 の credential_rejected', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'cand4');
    // 新しい偽の GitHub に差し替えず、次の1回を 401 にする
    ctx.github.failNext({ kind: 'status', status: 401 });

    const res = await candidates(ctx, target, target.member, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'credential_rejected',
    );
  });
});

describe('connection-scopes-save', () => {
  test('登録した直後は空で、保存すると置き換わる。名前は取り込み元の候補から引く', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'save1');
    expect((await rowsOf(target)).scopes).toHaveLength(0);

    const first = await save(ctx, target, target.member, id, ['1001', '1002']);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { connection: { scopes: unknown[] } }).connection.scopes).toEqual([
      { id: '1002', name: 'aoba-dev/blog' },
      { id: '1001', name: 'aoba-dev/shop' },
    ]);

    const second = await save(ctx, target, target.member, id, ['1002', '1002']);
    expect(second.status).toBe(200);
    const { scopes, connections, logs } = await rowsOf(target);
    expect(scopes).toEqual([
      { connection_id: id, scope_kind: 'github_repo', source_id: '1002', source_name: 'aoba-dev/blog' },
    ]);
    expect(connections[0]!.scope_mode).toBe('include');
    expect(logs.map((log) => log.action)).toEqual(['create', 'update', 'update']);

    const cleared = await save(ctx, target, target.member, id, []);
    expect(cleared.status).toBe(200);
    expect((await rowsOf(target)).scopes).toHaveLength(0);
  });

  test('候補に無い ID は 400 で、今の範囲は変わらない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'save2');
    await save(ctx, target, target.member, id, ['1001']);

    const res = await save(ctx, target, target.member, id, ['1001', '9999']);
    expect(res.status).toBe(400);
    expect((await rowsOf(target)).scopes.map((scope) => scope.source_id)).toEqual(['1001']);
  });

  test('ほかのメンバーは 403 で、範囲は変わらない。別の組織の接続は 404', async () => {
    const ctx = setup();
    const target = await createTarget();
    const other = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'save3');
    const foreign = await registered(ctx, other, other.member, 'save4');

    expect((await save(ctx, target, target.leader, id, ['1001'])).status).toBe(403);
    expect((await save(ctx, target, target.member, foreign.id, ['1001'])).status).toBe(404);
    expect((await rowsOf(target)).scopes).toHaveLength(0);
    expect((await rowsOf(other)).scopes).toHaveLength(0);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、範囲は変わらない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'save5');
    await save(ctx, target, target.member, id, ['1001']);

    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', db.organizationId),
      ),
    ]);

    const res = await save(ctx, target, target.member, id, ['1002']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_closed');
    expect((await rowsOf(target)).scopes.map((scope) => scope.source_id)).toEqual(['1001']);
  });
});
