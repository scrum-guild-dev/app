// #746 の崩し2周目。R2 に保存する進捗の故障と、次回への引き継ぎを確かめる。
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { cleanupAttachments } from '../src/server/scheduled/cleanup-attachments.ts';
import {
  createAttachment,
  createOrganization,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';

const AT = new Date('2026-11-09T00:00:00.000Z');
const CURSOR = 'system/cleanup-attachments-cursor';
const organizations: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const common = commonDb(env);
  if (organizations.length > 0) {
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ suspended_at: AT.toISOString() }).where('id', 'in', organizations),
      ),
    ]);
  }
  organizations.length = 0;
  await env.ATTACHMENTS.delete(CURSOR);
});

async function freshOrganization(index: number) {
  const organization = await createOrganization({
    id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
  });
  organizations.push(organization.id);
  return organization;
}

async function storedAttachment(organization: OrganizationFixture) {
  const user = await createUser(organization);
  const workspace = await createWorkspace(organization, user.id);
  const row = await createAttachment(organization, workspace.id, user.id, {
    created_at: '2026-11-07T23:59:59.999Z',
  });
  await env.ATTACHMENTS.put(row.object_key, 'file');
  return row;
}

async function hasAttachment(organization: OrganizationFixture, id: string) {
  const db = orgDb(env, organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', id)
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId),
        ),
    ),
  );
}

function withBucket(intercept: (property: PropertyKey) => unknown, base: Env = env): Env {
  const bucket = new Proxy(env.ATTACHMENTS, {
    get(target, property) {
      const intercepted = intercept(property);
      if (intercepted !== undefined) return intercepted;
      const member: unknown = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return Object.assign({}, base, { ATTACHMENTS: bucket });
}

describe('進捗の読み書きの故障', () => {
  test('進捗を読めなければ添付の削除を始めず、キーと例外の文を出さない', async () => {
    const organization = await freshOrganization(3001);
    const row = await storedAttachment(organization);
    let deletes = 0;
    const database = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (sqls.some((sql) => sql.startsWith('delete from "attachments"'))) deletes++;
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observed = withBucket(
      (property) =>
        property === 'get'
          ? async (key: string) => {
              if (key === CURSOR) throw new Error(`private-cursor-read ${CURSOR}`);
              return env.ATTACHMENTS.get(key);
            }
          : undefined,
      database,
    );

    await expect(cleanupAttachments(observed, AT)).rejects.toThrow();

    expect(deletes).toBe(0);
    expect(await hasAttachment(organization, row.id)).toEqual({ id: row.id });
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-cursor-read');
    expect(JSON.stringify(error.mock.calls)).not.toContain(CURSOR);
  });

  test('進捗の保存が失敗しても削除した添付は戻らず、再実行できる', async () => {
    const organization = await freshOrganization(3002);
    const row = await storedAttachment(organization);
    await env.ATTACHMENTS.put(CURSOR, '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observed = withBucket((property) =>
      property === 'put'
        ? async (key: string) => {
            if (key === CURSOR) throw new Error(`private-cursor-write ${CURSOR}`);
            throw new Error('想定外の書き込み');
          }
        : undefined,
    );

    await expect(cleanupAttachments(observed, AT)).rejects.toThrow();

    expect(await hasAttachment(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe('');
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-cursor-write');
    expect(JSON.stringify(error.mock.calls)).not.toContain(CURSOR);
    await cleanupAttachments(env, AT);
    expect(await hasAttachment(organization, row.id)).toBeUndefined();
  });

  test('進捗の保存が終わるまで掃除全体の完了を返さない', async () => {
    const organization = await freshOrganization(3003);
    const row = await storedAttachment(organization);
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const observed = withBucket((property) =>
      property === 'put'
        ? async (key: string, value: string) => {
            if (key === CURSOR) {
              entered();
              await released;
            }
            return env.ATTACHMENTS.put(key, value);
          }
        : undefined,
    );
    const running = cleanupAttachments(observed, AT).finally(() => {
      settled = true;
    });
    try {
      await entering;
      expect(settled).toBe(false);
      expect(await hasAttachment(organization, row.id)).toBeUndefined();
      expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    } finally {
      release();
      await running;
    }
    expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe('');
  });
});

describe('進捗の境界と巻き戻り', () => {
  test('64バイトを超える進捗は先頭からやり直し、対象を読み飛ばさない', async () => {
    const organization = await freshOrganization(3004);
    const row = await storedAttachment(organization);
    await env.ATTACHMENTS.put(CURSOR, 'z'.repeat(65));

    await cleanupAttachments(env, AT);

    expect(await hasAttachment(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe('');
  });

  test('最後の組織が既に無い進捗でも、走査末尾を越えたら先頭へ戻れる', async () => {
    const organization = await freshOrganization(3005);
    const row = await storedAttachment(organization);
    await env.ATTACHMENTS.put(CURSOR, 'ffffffff-ffff-7fff-8fff-ffffffffffff');

    await cleanupAttachments(env, AT);
    expect(await hasAttachment(organization, row.id)).toEqual({ id: row.id });
    expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe('');
    await cleanupAttachments(env, AT);

    expect(await hasAttachment(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('進捗の読み込み中に時間を使い切ったら、進捗を飛ばさず次の回で消す', async () => {
    const organization = await freshOrganization(3006);
    const row = await storedAttachment(organization);
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = withBucket((property) =>
      property === 'get'
        ? async (key: string) => {
            const object = await env.ATTACHMENTS.get(key);
            if (key === CURSOR) clock = 20_000;
            return object;
          }
        : undefined,
    );

    await cleanupAttachments(observed, AT);
    expect(await hasAttachment(organization, row.id)).toEqual({ id: row.id });
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
    clock = 0;
    await cleanupAttachments(env, AT);

    expect(await hasAttachment(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('組織の途中で時間切れになっても、後ろの組織と残りの行が再実行で消える', async () => {
    const a = await freshOrganization(3007);
    const b = await freshOrganization(3008);
    const rowsA = [await storedAttachment(a), await storedAttachment(a)];
    const rowB = await storedAttachment(b);
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = withBucket((property) =>
      property === 'delete'
        ? async (keys: string[]) => {
            await env.ATTACHMENTS.delete(keys);
            clock = 20_000;
          }
        : undefined,
    );

    await cleanupAttachments(observed, AT, { limit: 1 });
    expect(await hasAttachment(b, rowB.id)).toEqual({ id: rowB.id });
    expect(await (await env.ATTACHMENTS.get(CURSOR))?.text()).toBe(a.id);
    clock = 0;
    await cleanupAttachments(env, AT, { limit: 1 });
    expect(await hasAttachment(b, rowB.id)).toBeUndefined();
    clock = 0;
    await cleanupAttachments(env, AT, { limit: 1 });

    for (const row of rowsA) {
      expect(await hasAttachment(a, row.id)).toBeUndefined();
      expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    }
    expect(await env.ATTACHMENTS.get(rowB.object_key)).toBeNull();
  });
});
