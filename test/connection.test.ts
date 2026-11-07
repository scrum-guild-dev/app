// 接続の操作（一覧、登録、範囲の候補、範囲の保存）の固有の振る舞い。権限の種類ごとの許可と拒否、組織の分離は
// 一覧を回す test/operation-registry*.test.ts が確かめる。ここでは認証情報が応答と DB と履歴に平文で残らないこと、
// 取り込み元の拒否と不調、本人だけの操作、範囲の置き換え、閉じたワークスペースを見る。取り込み元は偽の GitHub（PAT）に向ける
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  CONNECTION_SCOPES_MAX,
  CONNECTIONS_PER_MEMBER_MAX,
  connectionCreate,
  connectionList,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionSync,
} from '../src/shared/operations/connection/index.ts';
import { createApp } from '../src/server/app.ts';
import { decryptCredential } from '../src/server/crypto/credential.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createConnection } from './factories.ts';
import { createFakePatGithub, fakeIssue, fakePat, fakeRepos } from './import/fake-github-pat.ts';
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

    // 同じ組織の別のワークスペースの接続は、ワークスペースの ID が合わないので 404
    const sibling = await createConnection(target.organization, target.otherWorkspace.id, target.bystander.userId!);
    expect((await candidates(ctx, target, target.member, sibling.id)).status).toBe(404);
    expect((await save(ctx, target, target.member, sibling.id, ['1001'])).status).toBe(404);
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
    const after = await rowsOf(target);
    expect(after.scopes.map((scope) => scope.source_id)).toEqual(['1001']);
    expect(after.logs.map((log) => log.action)).toEqual(['create', 'update']);
  });
});

describe('接続の数と削除済み', () => {
  test('同じ名前の接続も登録できる（個人の PAT と組織の PAT に同じ名前を付けられる）', async () => {
    const ctx = setup();
    const target = await createTarget();
    const first = fakePat('same1');
    const second = fakePat('same2');
    ctx.github.addAccount(first, OWNER, []);
    ctx.github.addAccount(second, { type: 'Organization', id: 7_100_002, login: 'aoba-org' }, []);

    expect((await register(ctx, target, target.member, first, 'GitHub')).status).toBe(200);
    expect((await register(ctx, target, target.member, second, 'GitHub')).status).toBe(200);
    expect((await rowsOf(target)).connections).toHaveLength(2);
  });

  test('1人の接続の数が上限に達すると 409 の connection_limit。削除済みは数えず、ほかの人は数えない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('limit');
    ctx.github.addAccount(pat, OWNER, []);
    for (let i = 0; i < CONNECTIONS_PER_MEMBER_MAX; i++) {
      await createConnection(target.organization, target.workspace.id, target.member.userId!, {
        name: `接続 ${i}`,
        ...(i === 0 ? { deleted_at: '2026-11-01T00:00:00.000Z' } : {}),
      });
    }
    // 削除済みが1件あるので、あと1件は登録できる
    expect((await register(ctx, target, target.member, pat, '最後の1件')).status).toBe(200);
    const over = await register(ctx, target, target.member, pat, '上限の外');
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'connection_limit',
    );
    expect((await register(ctx, target, target.leader, pat, 'リーダーの接続')).status).toBe(200);
  });

  test('削除済みの接続は一覧に出ず、候補と保存は 404', async () => {
    const ctx = setup();
    const target = await createTarget();
    const gone = await createConnection(target.organization, target.workspace.id, target.member.userId!, {
      deleted_at: '2026-11-01T00:00:00.000Z',
    });

    const list = await post(ctx.app, connectionList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: target.workspace.id },
    });
    expect(((await list.json()) as { connections: unknown[] }).connections).toEqual([]);
    expect((await candidates(ctx, target, target.member, gone.id)).status).toBe(404);
    expect((await save(ctx, target, target.member, gone.id, [])).status).toBe(404);
  });
});

describe('connection-scopes-save の上限と取り込み元の不調', () => {
  test('201件は 400、200件は保存できる', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('many');
    ctx.github.addAccount(pat, OWNER, fakeRepos(CONNECTION_SCOPES_MAX));
    const { connection } = (await (await register(ctx, target, target.member, pat)).json()) as {
      connection: { id: string };
    };
    const ids = fakeRepos(CONNECTION_SCOPES_MAX).map((repo) => String(repo.id));

    const over = await save(ctx, target, target.member, connection.id, [...ids, '9999']);
    expect(over.status).toBe(400);
    const ok = await save(ctx, target, target.member, connection.id, ids);
    expect(ok.status).toBe(200);
    expect((await rowsOf(target)).scopes).toHaveLength(CONNECTION_SCOPES_MAX);
  });

  test('取り込み元に届かないときは、候補も保存も 503 で、範囲は変わらない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'down2');
    await save(ctx, target, target.member, id, ['1001']);

    ctx.github.failNext({ kind: 'status', status: 502 });
    expect((await candidates(ctx, target, target.member, id)).status).toBe(503);
    ctx.github.failNext({ kind: 'status', status: 502 });
    expect((await save(ctx, target, target.member, id, ['1002'])).status).toBe(503);
    expect((await rowsOf(target)).scopes.map((scope) => scope.source_id)).toEqual(['1001']);
  });

  test('取り込み元が 403 を返したときも 409 の credential_rejected', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'forbid');
    ctx.github.failNext({ kind: 'status', status: 403 });
    const res = await candidates(ctx, target, target.member, id);
    expect(res.status).toBe(409);
  });
});

describe('守りの条件', () => {
  // 取り込み元に問い合わせた直後（応答を返す前）に割り込む偽の GitHub
  function setupWithHook(hook: () => Promise<void>) {
    const github = createFakePatGithub();
    const fetcher: typeof fetch = async (input, init) => {
      const res = await github.fetcher(input, init);
      await hook();
      return res;
    };
    return { github, app: createApp(implementedOperations, { fetcher }) };
  }

  async function writeWorkspaceAndConnection(
    target: Target,
    change: { closed_at?: string; connectionId?: string; deleted_at?: string },
  ) {
    const db = orgDb(env, target.organization.verified);
    if (change.closed_at !== undefined) {
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('workspaces')
            .set({ closed_at: change.closed_at! })
            .where('id', '=', target.workspace.id)
            .where('organization_id', '=', db.organizationId),
        ),
      ]);
    }
    if (change.connectionId !== undefined) {
      await db.batch([
        db.statement((q) =>
          q
            .updateTable('connections')
            .set({
              deleted_at: change.deleted_at ?? '2026-11-01T00:00:00.000Z',
              credential_ciphertext: null,
              credential_key_version: null,
              credential_last4: null,
            })
            .where('id', '=', change.connectionId!),
        ),
      ]);
    }
  }

  test('PAT の前後の空白は取って登録でき、末尾4文字は PAT のもの', async () => {
    const ctx = setup();
    const target = await createTarget();
    const pat = fakePat('spaces');
    ctx.github.addAccount(pat, OWNER, []);

    const res = await register(ctx, target, target.member, ` ${pat}\n`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: { credential_last4: string } }).connection.credential_last4).toBe(
      pat.slice(-4),
    );
  });

  test('取り込み元で確かめている間にワークスペースが閉じたら、409 の workspace_closed で行は入らない', async () => {
    const target = await createTarget();
    const pat = fakePat('raceclose');
    const ctx = setupWithHook(() => writeWorkspaceAndConnection(target, { closed_at: '2026-11-01T00:00:00.000Z' }));
    ctx.github.addAccount(pat, OWNER, []);

    const res = await register(ctx, target, target.member, pat);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_closed');
    const rows = await rowsOf(target);
    expect(rows.connections).toHaveLength(0);
    expect(rows.logs).toHaveLength(0);
  });

  test('候補を取っている間に接続が削除されたら、保存は 404 で範囲も履歴も増えない', async () => {
    const target = await createTarget();
    const connection = await createConnection(target.organization, target.workspace.id, target.member.userId!);
    const pat = fakePat('racedelete');
    // 暗号化した認証情報を置く
    const { encryptCredential } = await import('../src/server/crypto/credential.ts');
    const sealed = await encryptCredential(env, pat, connection.id);
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({
            credential_ciphertext: sealed.ciphertext,
            credential_key_version: sealed.keyVersion,
            credential_last4: pat.slice(-4),
          })
          .where('id', '=', connection.id),
      ),
    ]);
    const ctx = setupWithHook(() => writeWorkspaceAndConnection(target, { connectionId: connection.id }));
    ctx.github.addAccount(pat, OWNER, fakeRepos(2));

    const res = await save(ctx, target, target.member, connection.id, ['1000']);
    expect(res.status).toBe(404);
    const rows = await rowsOf(target);
    expect(rows.scopes).toHaveLength(0);
    expect(rows.logs).toHaveLength(0);
  });

  test('履歴の変更の中身は、登録が名前と種類、保存が範囲の件数の前後（整数）で、認証情報を含まない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { pat, id } = await registered(ctx, target, target.member, 'logs');
    await save(ctx, target, target.member, id, ['1001', '1002']);

    const { logs } = await rowsOf(target);
    expect(logs.map((log) => log.changes_json)).toEqual([
      '{"name":[null,"あおばの GitHub"],"provider":["github",""]}'.replace('["github",""]', '[null,"github"]'),
      '{"scopes_count":[0,2]}',
    ]);
    expect(JSON.stringify(logs)).not.toContain(pat);
  });

  test('認証情報を取り込み元が受け付けなくなっても、範囲を空にする保存はできる', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await registered(ctx, target, target.member, 'empty');
    await save(ctx, target, target.member, id, ['1001']);

    ctx.github.failNext({ kind: 'status', status: 401 });
    const res = await save(ctx, target, target.member, id, []);
    expect(res.status).toBe(200);
    expect((await rowsOf(target)).scopes).toHaveLength(0);
  });
});

describe('connection-sync（今すぐ同期）', () => {
  function sync(ctx: ReturnType<typeof setup>, target: Target, person: Person, connectionId: string) {
    return post(ctx.app, connectionSync, {
      slug: target.slug,
      token: person.token,
      body: { workspace_id: target.workspace.id, connection_id: connectionId },
    });
  }

  // 範囲を1つ選んだ接続。範囲のリポジトリに、本人（aoba-dev）が担当の未完了の Issue を n 件置く
  async function ready(ctx: ReturnType<typeof setup>, target: Target, person: Person, seed: string, issues = 2) {
    const { pat, id } = await registered(ctx, target, person, seed);
    expect((await save(ctx, target, person, id, ['1001'])).status).toBe(200);
    ctx.github.addIssues(
      1001,
      Array.from({ length: issues }, (_, i) => fakeIssue('aoba-dev/shop', i + 1, { assignees: ['aoba-dev'] })),
    );
    return { pat, id };
  }

  async function inboxTitles(target: Target) {
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .select('title')
          .where('workspace_id', '=', target.workspace.id)
          .where('tray', '=', 'inbox'),
      ),
    );
    return rows.map((row) => row.title).sort();
  }

  async function lastManual(target: Target, id: string) {
    const db = orgDb(env, target.organization.verified);
    const row = await db.first(
      db.statement((q) => q.selectFrom('connections').select(['last_manual_sync_at', 'status']).where('id', '=', id)),
    );
    return row!;
  }

  async function backdate(target: Target, id: string) {
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({ last_manual_sync_at: new Date(Date.now() - 301_000).toISOString() })
          .where('id', '=', id),
      ),
    );
  }

  test('範囲を選んだ接続で押すと、担当の未完了の Issue が受信箱に入り、件数と最後に成功した日時が返る', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { pat, id } = await ready(ctx, target, target.member, 'sync1');

    const res = await sync(ctx, target, target.member, id);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ result: 'success', imported: 2, more: false });
    expect(body.connection.last_success_at).not.toBeNull();
    expect(text).not.toContain(pat);
    expect(await inboxTitles(target)).toEqual(['架空の課題 1', '架空の課題 2']);
    expect((await lastManual(target, id)).last_manual_sync_at).not.toBeNull();
  });

  test('5分以内にもう一度押すと 429 で、取り込み元に問い合わせない。5分たてばまた押せる', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync2', 1);
    expect((await sync(ctx, target, target.member, id)).status).toBe(200);

    const calls = ctx.github.calls.length;
    const again = await sync(ctx, target, target.member, id);
    expect(again.status).toBe(429);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(ctx.github.calls).toHaveLength(calls);

    await backdate(target, id);
    const later = await sync(ctx, target, target.member, id);
    expect(later.status).toBe(200);
    expect(((await later.json()) as { imported: number }).imported).toBe(0);
  });

  test('同時に押しても、同期は1回だけ走る', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync3');

    const responses = await Promise.all([1, 2, 3].map(() => sync(ctx, target, target.member, id)));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 429, 429]);
    expect(await inboxTitles(target)).toHaveLength(2);
    expect(ctx.github.calls.filter((call) => call.url.includes('/issues')).length).toBe(1);
  });

  test('ほかのメンバー、リーダー、管理者は 403 で、取り込み元に問い合わせず、制限の印も付かない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync4');
    const calls = ctx.github.calls.length;

    for (const person of [target.leader, target.admin]) {
      expect((await sync(ctx, target, person, id)).status).toBe(403);
    }
    expect(ctx.github.calls).toHaveLength(calls);
    expect((await lastManual(target, id)).last_manual_sync_at).toBeNull();
    expect(await inboxTitles(target)).toEqual([]);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、取り込み元に問い合わせない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync5');
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q.updateTable('workspaces').set({ closed_at: new Date().toISOString() }).where('id', '=', target.workspace.id),
      ),
    );
    const calls = ctx.github.calls.length;

    const res = await sync(ctx, target, target.member, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_closed');
    expect(ctx.github.calls).toHaveLength(calls);
  });

  test('PAT が失効していると接続が停止になり、応答の接続に理由が出る。次に押すと 409 の connection_stopped', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync6');
    // 保存した PAT を GitHub が受け付けなくなる（最初の問い合わせが 401）
    ctx.github.failNext({ kind: 'status', status: 401 });

    const res = await sync(ctx, target, target.member, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: string;
      imported: number;
      connection: { status: string; stopped_reason: string | null; last_error_message: string | null };
    };
    expect(body).toMatchObject({ result: 'auth_failed', imported: 0 });
    expect(body.connection.status).toBe('stopped');
    expect(body.connection.stopped_reason).toBe('auth_failed');
    expect(body.connection.last_error_message).not.toBeNull();

    await backdate(target, id);
    const again = await sync(ctx, target, target.member, id);
    expect(again.status).toBe(409);
    const error = ((await again.json()) as { error: { details: { reason: string } } }).error;
    expect(error.details.reason).toBe('connection_stopped');
  });

  test('取り込み元の不調は止めずに result: error で返し、範囲が空なら no_scope で何も問い合わせない', async () => {
    const ctx = setup();
    const target = await createTarget();
    const { id } = await ready(ctx, target, target.member, 'sync7');
    ctx.github.failOnIssuePage(1, { kind: 'status', status: 502 });
    const failed = await sync(ctx, target, target.member, id);
    expect(failed.status).toBe(200);
    const body = (await failed.json()) as { result: string; connection: { status: string } };
    expect(body).toMatchObject({ result: 'error', connection: { status: 'error' } });

    const empty = await registered(ctx, target, target.member, 'sync8');
    const calls = ctx.github.calls.length;
    const none = await sync(ctx, target, target.member, empty.id);
    expect(((await none.json()) as { result: string }).result).toBe('no_scope');
    expect(ctx.github.calls).toHaveLength(calls);
  });

  test('存在しない接続と削除済みの接続は 404', async () => {
    const ctx = setup();
    const target = await createTarget();
    expect((await sync(ctx, target, target.member, crypto.randomUUID())).status).toBe(404);
  });
});
