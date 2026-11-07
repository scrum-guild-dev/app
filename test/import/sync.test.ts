// 取り込み元に依らない同期の仕組み（src/server/import/sync.ts）。GitHub ではない偽の取り込み元を差し、
// 同期の関数を直に呼ぶ。取り込み元の通信は fetcher に偽物を差さず、ImportSource の実装そのものを偽にする
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../../src/server/db/index.ts';
import { encryptCredential } from '../../src/server/crypto/credential.ts';
import { syncConnection } from '../../src/server/import/sync.ts';
import {
  ImportSourceError,
  type FetchPageInput,
  type ImportItem,
  type ImportSource,
  type ImportSourceFailure,
} from '../../src/server/import/source.ts';
import {
  createConnection,
  createConnectionScope,
  createMembership,
  createOrganization,
  createRepository,
  createUser,
  createWorkspace,
  uuidv7,
} from '../factories.ts';

const SECRET = 'fake-secret-ZZZ-0001';

function item(n: number, overrides: Partial<ImportItem> = {}): ImportItem {
  return {
    kind: 'issue',
    sourceId: `src-${n}`,
    reviewerSourceId: '',
    key: `fake/box#${n}`,
    url: `https://fake.example/box/${n}`,
    title: `項目 ${n}`,
    containerId: '501',
    containerName: 'fake/box',
    status: 'open',
    dueOn: null,
    updatedAt: '2026-11-01T00:00:00.000Z',
    isDone: false,
    ...overrides,
  };
}

type Page = { items: ImportItem[]; next: string | null };

// 範囲 ID ごとの頁の並びを返す偽の取り込み元。cursor は頁の番号の文字列
function fakeSource(pages: Record<string, Page[]>, hooks: { fail?: ImportSourceFailure; candidates?: string[] } = {}) {
  const calls: FetchPageInput[] = [];
  const source: ImportSource = {
    kind: 'github',
    scopeKind: 'repository',
    parseSettings: () => ({}),
    isCredentialShape: () => true,
    credentialLast4: (credential) => credential.slice(-4),
    verifyCredential: async () => ({ kind: 'user', id: '1', name: 'fake' }),
    listScopeCandidates: async () =>
      (hooks.candidates ?? Object.keys(pages)).map((id) => ({ id, name: `scope-${id}` })),
    async fetchPage(input) {
      calls.push(input);
      if (hooks.fail !== undefined) {
        throw new ImportSourceError(hooks.fail, `${SECRET} https://leak.example/${SECRET}`);
      }
      const index = input.cursor === null ? 0 : Number(input.cursor);
      const page = pages[input.scope.id]?.[index];
      if (page === undefined) return { items: [], next: null };
      return { items: page.items, next: page.next };
    },
  };
  return { source, calls };
}

async function setup() {
  const organization = await createOrganization();
  const owner = await createUser(organization, { name: '星野 澪' });
  const workspace = await createWorkspace(organization, owner.id);
  await createMembership(organization, workspace.id, owner.id);
  const connectionId = uuidv7();
  const real = await encryptCredential(env, SECRET, connectionId);
  const connection = await createConnection(organization, workspace.id, owner.id, {
    id: connectionId,
    credential_ciphertext: real.ciphertext,
    credential_key_version: real.keyVersion,
    credential_last4: SECRET.slice(-4),
  });
  await createConnectionScope(organization, connection.id, { source_id: '501', source_name: 'fake/box' });
  return { organization, owner, workspace, connection, db: orgDb(env, organization.verified) };
}

async function tasksOf(db: ReturnType<typeof orgDb>, workspaceId: string) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['id', 'title', 'tray', 'is_imported', 'assignee_user_id', 'repository_id', 'position', 'created_by'])
        .where('workspace_id', '=', workspaceId)
        .orderBy('position')
        .orderBy('id'),
    ),
  );
}

async function sourcesOf(db: ReturnType<typeof orgDb>, workspaceId: string) {
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('task_sources')
        .select(['task_id', 'source_id', 'source_key', 'connection_id', 'is_source_done'])
        .where('workspace_id', '=', workspaceId),
    ),
  );
}

async function connectionOf(db: ReturnType<typeof orgDb>, id: string) {
  const row = await db.first(db.statement((q) => q.selectFrom('connections').selectAll().where('id', '=', id)));
  return row!;
}

describe('取り込みの同期', () => {
  test('未完了の項目が受信箱のタスクとして入り、担当は接続の登録者になる', async () => {
    const { owner, workspace, connection, db } = await setup();
    const { source } = fakeSource({ '501': [{ items: [item(1), item(2, { isDone: true }), item(3)], next: null }] });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toEqual({ outcome: 'success', imported: 2, more: false });

    const tasks = await tasksOf(db, workspace.id);
    expect(tasks.map((t) => t.title)).toEqual(['項目 1', '項目 3']);
    for (const task of tasks) {
      expect(task).toMatchObject({ tray: 'inbox', is_imported: 1, assignee_user_id: owner.id, created_by: null });
    }
    const sources = await sourcesOf(db, workspace.id);
    expect(sources.map((s) => s.source_id).sort()).toEqual(['src-1', 'src-3']);
    expect(sources.every((s) => s.connection_id === connection.id && s.is_source_done === 0)).toBe(true);
    expect(new Set(sources.map((s) => s.task_id))).toEqual(new Set(tasks.map((t) => t.id)));

    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'active', consecutive_failures: 0, last_error_message: null });
    expect(after.last_success_at).not.toBeNull();
    expect(after.sync_state_json).toBe('{}');
  });

  test('受信箱の末尾に並べ、結んだリポジトリがあれば repository_id も書く', async () => {
    const { organization, workspace, connection, db } = await setup();
    const repo = await createRepository(organization, workspace.id, {
      provider: 'github',
      source_container_id: '501',
      source_container_name: 'fake/box',
    });
    const { source } = fakeSource({
      '501': [{ items: [item(1), item(2, { containerId: '999', containerName: 'fake/other' })], next: null }],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    const first = await tasksOf(db, workspace.id);
    expect(first.map((t) => t.repository_id)).toEqual([repo.id, null]);

    const { source: more } = fakeSource({ '501': [{ items: [item(4)], next: null }] });
    await syncConnection(env, db, workspace.id, connection.id, { source: more });
    const all = await tasksOf(db, workspace.id);
    expect(all.map((t) => t.title)).toEqual(['項目 1', '項目 2', '項目 4']);
  });

  test('タイトルは見えない文字を除き、200字で切る。何も残らなければキーを使う', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({
      '501': [
        {
          items: [
            item(1, { title: ' 修正​ する\n続き‮ ' }),
            item(2, { title: 'あ'.repeat(300) }),
            item(3, { title: '​​' }),
          ],
          next: null,
        },
      ],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    const titles = (await tasksOf(db, workspace.id)).map((t) => t.title);
    expect(titles).toContain('修正 する 続き');
    expect(titles).toContain('あ'.repeat(200));
    expect(titles).toContain('fake/box#3');
  });

  test('2回同期しても二重に入らない', async () => {
    const { workspace, connection, db } = await setup();
    const pages = { '501': [{ items: [item(1), item(2)], next: null }] };
    const { source } = fakeSource(pages);
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toMatchObject({ imported: 2 });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source })).toMatchObject({ imported: 0 });
    expect(await tasksOf(db, workspace.id)).toHaveLength(2);
    expect(await sourcesOf(db, workspace.id)).toHaveLength(2);
  });

  test('並行して同期しても、同じ項目が二重に入らず、片方だけの行も残らない', async () => {
    const { workspace, connection, db } = await setup();
    const pages = { '501': [{ items: [item(1), item(2), item(3)], next: null }] };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        syncConnection(env, db, workspace.id, connection.id, { source: fakeSource(pages).source }),
      ),
    );
    const imported = results.reduce((sum, r) => sum + (r.outcome === 'success' ? r.imported : 0), 0);
    expect(imported).toBe(3);
    const tasks = await tasksOf(db, workspace.id);
    const sources = await sourcesOf(db, workspace.id);
    expect(tasks).toHaveLength(3);
    expect(sources).toHaveLength(3);
    expect(new Set(sources.map((s) => s.task_id))).toEqual(new Set(tasks.map((t) => t.id)));
  });

  test('同じ頁の中の同じ項目も1件にまとめ、レビュー依頼はレビュアーごとに分ける', async () => {
    const { workspace, connection, db } = await setup();
    const review = (reviewer: string) =>
      item(9, { kind: 'review_request', reviewerSourceId: reviewer, sourceId: 'pr-9', key: 'fake/box#9' });
    const { source } = fakeSource({
      '501': [{ items: [item(1), item(1), review('u1'), review('u2'), review('u1')], next: null }],
    });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toMatchObject({ outcome: 'success', imported: 3 });
    expect(await sourcesOf(db, workspace.id)).toHaveLength(3);
  });

  test('範囲が空の接続は、取り込み元に問い合わせず何も入れない', async () => {
    const { organization, owner, workspace, db } = await setup();
    const empty = await createConnection(organization, workspace.id, owner.id, { name: '範囲なし' });
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    const result = await syncConnection(env, db, workspace.id, empty.id, { source });
    expect(result).toEqual({ outcome: 'no_scope' });
    expect(calls).toHaveLength(0);
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
    expect((await connectionOf(db, empty.id)).last_success_at).toBeNull();
  });

  test('除外を挙げる接続は、候補から除外を引いた範囲を取る', async () => {
    const { organization, owner, workspace, db } = await setup();
    const connectionId = uuidv7();
    const sealed = await encryptCredential(env, SECRET, connectionId);
    const connection = await createConnection(organization, workspace.id, owner.id, {
      id: connectionId,
      scope_mode: 'exclude',
      credential_ciphertext: sealed.ciphertext,
      credential_key_version: sealed.keyVersion,
      credential_last4: 'e-01',
    });
    await createConnectionScope(organization, connection.id, { source_id: '502', source_name: 'scope-502' });
    const { source, calls } = fakeSource({
      '501': [{ items: [item(1)], next: null }],
      '502': [{ items: [item(2)], next: null }],
      '503': [{ items: [item(3, { containerId: '503' })], next: null }],
    });
    await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(calls.map((call) => call.scope.id)).toEqual(['501', '503']);
    expect((await sourcesOf(db, workspace.id)).map((s) => s.source_id).sort()).toEqual(['src-1', 'src-3']);
  });

  test('上限で止めたときに続きの位置を保存し、次の同期で残りを入れる', async () => {
    const { workspace, connection, db } = await setup();
    const pages = {
      '501': [
        { items: [item(1), item(2)], next: '1' },
        { items: [item(3)], next: '2' },
        { items: [item(4)], next: null },
      ],
    };
    const first = fakeSource(pages);
    const r1 = await syncConnection(env, db, workspace.id, connection.id, { source: first.source, maxPages: 2 });
    expect(r1).toEqual({ outcome: 'success', imported: 3, more: true });
    expect(first.calls.map((call) => call.cursor)).toEqual([null, '1']);
    expect(JSON.parse((await connectionOf(db, connection.id)).sync_state_json)).toEqual({
      resume: { scope: '501', cursor: '2' },
    });

    const second = fakeSource(pages);
    const r2 = await syncConnection(env, db, workspace.id, connection.id, { source: second.source, maxPages: 2 });
    expect(r2).toEqual({ outcome: 'success', imported: 1, more: false });
    expect(second.calls.map((call) => call.cursor)).toEqual(['2']);
    expect((await tasksOf(db, workspace.id)).map((t) => t.title)).toEqual(['項目 1', '項目 2', '項目 3', '項目 4']);
    expect((await connectionOf(db, connection.id)).sync_state_json).toBe('{}');
  });

  test('認証の失敗で接続が停止になり、エラーの文に認証情報が含まれない', async () => {
    const { workspace, connection, db } = await setup();
    const { source } = fakeSource({}, { fail: 'unauthorized' });
    const result = await syncConnection(env, db, workspace.id, connection.id, { source });
    expect(result).toEqual({ outcome: 'auth_failed', imported: 0 });
    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'stopped', stopped_reason: 'auth_failed' });
    expect(after.last_error_message).toBeTruthy();
    expect(after.last_error_at).not.toBeNull();
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain('leak.example');

    // 止まった接続は、次の同期で取り込み元に問い合わせない
    const next = fakeSource({ '501': [{ items: [item(1)], next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: next.source })).toEqual({
      outcome: 'stopped',
    });
    expect(next.calls).toHaveLength(0);
  });

  test.each<ImportSourceFailure>(['forbidden', 'unavailable'])(
    '%s の失敗は止めず、エラーと失敗の回数と固定の文を書く。次の成功で戻る',
    async (failure) => {
      const { workspace, connection, db } = await setup();
      const bad = fakeSource({}, { fail: failure });
      expect(await syncConnection(env, db, workspace.id, connection.id, { source: bad.source })).toEqual({
        outcome: 'error',
        imported: 0,
      });
      await syncConnection(env, db, workspace.id, connection.id, { source: bad.source });
      const failed = await connectionOf(db, connection.id);
      expect(failed).toMatchObject({ status: 'error', stopped_reason: null, consecutive_failures: 2 });
      expect(failed.last_error_message).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain(SECRET);
      expect(JSON.stringify(failed)).not.toContain('leak.example');

      const good = fakeSource({ '501': [{ items: [item(1)], next: null }] });
      await syncConnection(env, db, workspace.id, connection.id, { source: good.source });
      expect(await connectionOf(db, connection.id)).toMatchObject({
        status: 'active',
        consecutive_failures: 0,
        last_error_message: null,
        last_error_at: null,
      });
    },
  );

  test('想定外の例外も固定の文で書く。復号できない認証情報は止めずにエラーにする', async () => {
    const { organization, owner, workspace, db } = await setup();
    const throwing: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        throw new Error(`boom ${SECRET}`);
      },
    };
    const connection = await createConnection(organization, workspace.id, owner.id, {
      credential_ciphertext: 'AAAA',
      credential_key_version: 1,
      credential_last4: 'AAAA',
    });
    await createConnectionScope(organization, connection.id);
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: throwing })).toEqual({
      outcome: 'error',
      imported: 0,
    });
    const after = await connectionOf(db, connection.id);
    expect(after).toMatchObject({ status: 'error', consecutive_failures: 1 });
    expect(after.last_error_message).not.toContain(SECRET);
  });

  test('形の違う項目や進まない続きの位置は断り、何も入れない', async () => {
    const { workspace, connection, db } = await setup();
    const bad = fakeSource({ '501': [{ items: [item(1), item(2, { dueOn: '2026-02-30' })], next: null }] });
    expect(await syncConnection(env, db, workspace.id, connection.id, { source: bad.source })).toMatchObject({
      outcome: 'error',
    });
    const stuck = fakeSource({ '501': [{ items: [item(1)], next: '0' }] });
    stuck.source.fetchPage = async () => ({ items: [], next: '0' });
    await syncConnection(env, db, workspace.id, connection.id, { source: stuck.source });
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
  });

  test('別の組織の接続には触れない。別のワークスペースの接続も同じ', async () => {
    const mine = await setup();
    const theirs = await setup();
    const { source, calls } = fakeSource({ '501': [{ items: [item(1)], next: null }] });

    // 別の組織の入口から、自分の組織の接続を指す
    expect(await syncConnection(env, theirs.db, mine.workspace.id, mine.connection.id, { source })).toEqual({
      outcome: 'not_found',
    });
    // 同じ組織でも、別のワークスペースの ID では見つからない
    const other = await createWorkspace(mine.organization, mine.owner.id);
    expect(await syncConnection(env, mine.db, other.id, mine.connection.id, { source })).toEqual({
      outcome: 'not_found',
    });
    expect(calls).toHaveLength(0);

    await syncConnection(env, mine.db, mine.workspace.id, mine.connection.id, { source });
    expect(await tasksOf(mine.db, mine.workspace.id)).toHaveLength(1);
    expect(await tasksOf(theirs.db, theirs.workspace.id)).toHaveLength(0);
    expect(await sourcesOf(theirs.db, theirs.workspace.id)).toHaveLength(0);
    expect((await connectionOf(theirs.db, theirs.connection.id)).last_success_at).toBeNull();
  });

  test('同期の最中に止まった接続には、成功も取り込みも書かない', async () => {
    const { workspace, connection, db } = await setup();
    const stopMidway: ImportSource = {
      ...fakeSource({}).source,
      async fetchPage() {
        await db.run(
          db.statement((q) =>
            q
              .updateTable('connections')
              .set({ status: 'stopped', stopped_reason: 'leader' })
              .where('id', '=', connection.id),
          ),
        );
        return { items: [item(1)], next: null };
      },
    };
    await syncConnection(env, db, workspace.id, connection.id, { source: stopMidway });
    expect(await tasksOf(db, workspace.id)).toHaveLength(0);
    expect(await connectionOf(db, connection.id)).toMatchObject({ status: 'stopped', stopped_reason: 'leader' });
  });
});
