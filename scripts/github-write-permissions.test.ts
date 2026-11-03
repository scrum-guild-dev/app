import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

type User = { login?: string | null; type?: string | null };
type Resolve = (users: readonly User[], lookup: (login: string) => Promise<unknown>) => Promise<ReadonlySet<string>>;

async function resolver(): Promise<Resolve> {
  const module = await import('./github-write-permissions.ts');
  assert.equal(typeof module.resolveWriteUsers, 'function');
  return module.resolveWriteUsers;
}

const response = (login: string, permission: unknown, type = 'User') => ({ permission, user: { login, type } });

describe('GitHub API で確認したリポジトリの書き込み権限', () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    test(`${permission} の人を確認済みの集合に入れる`, async () => {
      const resolve = await resolver();
      const calls: string[] = [];
      const result = await resolve([{ login: 'aoba', type: 'User' }], async (login) => {
        calls.push(login);
        return response(login, permission);
      });
      assert.deepEqual([...result], ['aoba']);
      assert.deepEqual(calls, ['aoba']);
    });
  }

  for (const permission of ['read', 'triage', 'none', '', 'owner', 'Write', null, undefined, true, {}, ['admin']]) {
    test(`不十分または不正な権限 ${JSON.stringify(permission)} は確認済みにしない`, async () => {
      const resolve = await resolver();
      const result = await resolve([{ login: 'aoba', type: 'User' }], async () => response('aoba', permission));
      assert.deepEqual([...result], []);
    });
  }

  test('API の失敗を区分で補わず、ほかの人の確認は続ける', async () => {
    const resolve = await resolver();
    const result = await resolve(
      [
        { login: 'aoba', type: 'User' },
        { login: 'kaede', type: 'User' },
      ],
      async (login) => {
        if (login === 'aoba') throw new Error('API unavailable');
        return response(login, 'write');
      },
    );
    assert.deepEqual([...result], ['kaede']);
  });

  test('対象と違うユーザーや Bot の応答、欠けた応答を採用しない', async () => {
    const resolve = await resolver();
    for (const raw of [
      response('kaede', 'admin'),
      response('aoba', 'admin', 'Bot'),
      { permission: 'admin' },
      null,
      [],
    ]) {
      const result = await resolve([{ login: 'aoba', type: 'User' }], async () => raw);
      assert.deepEqual([...result], [], JSON.stringify(raw));
    }
  });

  test('User 型でないものとパスやシェルの断片を API に渡さない', async () => {
    const resolve = await resolver();
    const calls: string[] = [];
    const users: User[] = [
      {},
      { login: null, type: 'User' },
      { login: '', type: 'User' },
      { login: 'aoba', type: 'Bot' },
      { login: 'kaede' },
      { login: '../admin', type: 'User' },
      { login: 'aoba/permission', type: 'User' },
      { login: 'aoba$(touch injected)', type: 'User' },
      { login: 'aoba\nadmin', type: 'User' },
      { login: 'github-actions[bot]', type: 'Bot' },
    ];
    const result = await resolve(users, async (login) => {
      calls.push(login);
      return response(login, 'admin');
    });
    assert.deepEqual([...result], []);
    assert.deepEqual(calls, []);
  });

  test('login は大文字小文字で別人にせず、同じ人を一度だけ確認する', async () => {
    const resolve = await resolver();
    const calls: string[] = [];
    const result = await resolve(
      [
        { login: 'AoBa', type: 'User' },
        { login: 'aoba', type: 'User' },
      ],
      async (login) => {
        calls.push(login.toLowerCase());
        return response('aoba', 'write');
      },
    );
    assert.deepEqual([...result], ['aoba']);
    assert.deepEqual(calls, ['aoba']);
  });
});
