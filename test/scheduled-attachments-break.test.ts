// #746 の独立した崩しの1周目。先行テストと異なる予算・ページ・再送の境界を確かめる。
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { cleanupAttachments, type CleanupAttachmentsOptions } from '../src/server/scheduled/cleanup-attachments.ts';
import {
  createAttachment,
  createOrganization,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';

const AT = new Date('2026-11-07T03:00:00.000Z');
const OLD = '2026-11-05T02:59:59.999Z';
const isDelete = (sqls: readonly string[]) => sqls.some((sql) => sql.startsWith('delete from "attachments"'));
const createdOrganizations: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // Workers の DB は同じファイルのテスト間で共有される。自分で作った組織だけを次の掃除の対象から外す。
  const common = commonDb(env);
  for (let index = 0; index < createdOrganizations.length; index += 50) {
    const ids = createdOrganizations.slice(index, index + 50);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ suspended_at: AT.toISOString() }).where('id', 'in', ids),
      ),
    ]);
  }
  createdOrganizations.length = 0;
  await env.ATTACHMENTS.delete('system/cleanup-attachments-cursor');
});

async function freshOrganization(overrides: Parameters<typeof createOrganization>[0] = {}) {
  const organization = await createOrganization(overrides);
  createdOrganizations.push(organization.id);
  return organization;
}

async function organizationAt(index: number) {
  return freshOrganization({ id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}` });
}

async function storedAttachment(organization: OrganizationFixture) {
  const user = await createUser(organization);
  const workspace = await createWorkspace(organization, user.id);
  const row = await createAttachment(organization, workspace.id, user.id, { created_at: OLD });
  await env.ATTACHMENTS.put(row.object_key, 'file');
  return row;
}

async function attachmentExists(organization: OrganizationFixture, id: string) {
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

function withDelete(onDelete: (keys: string[]) => Promise<void>): Env {
  const bucket = new Proxy(env.ATTACHMENTS, {
    get(target, name) {
      if (name === 'delete') return (keys: string | string[]) => onDelete(typeof keys === 'string' ? [keys] : keys);
      const member: unknown = Reflect.get(target, name);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return Object.assign({}, env, { ATTACHMENTS: bucket });
}

describe('組織のページと全体の上限', () => {
  test('空の組織が50件続いても、次のページの組織の添付を消す', async () => {
    for (let index = 1; index <= 50; index++) await organizationAt(index);
    const organization = await organizationAt(51);
    const row = await storedAttachment(organization);

    await cleanupAttachments(env, AT);

    expect(await attachmentExists(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('200件の空の組織で予算を使っても、次の実行では201件目の組織へ進む', async () => {
    for (let index = 1001; index <= 1200; index++) await organizationAt(index);
    const organization = await organizationAt(1201);
    const row = await storedAttachment(organization);
    let batches = 0;
    const observed = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (isDelete(sqls)) batches++;
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cleanupAttachments(observed, AT);
    expect(batches).toBeLessThanOrEqual(200);
    await cleanupAttachments(observed, new Date('2026-11-07T04:00:00.000Z'));

    expect(await attachmentExists(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('時間が組織の一覧の取得中に切れたら、削除の文は送らない', async () => {
    const organization = await freshOrganization();
    const row = await storedAttachment(organization);
    let clock = 0;
    let batches = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (sql.includes('from "organizations"')) clock = 20_000;
      },
      beforeBatch(sqls) {
        if (isDelete(sqls)) batches++;
      },
    });

    await cleanupAttachments(observed, AT);

    expect(batches).toBe(0);
    expect(await attachmentExists(organization, row.id)).toEqual({ id: row.id });
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });
});

describe('不正な予算で上限を外せない', () => {
  const cases: CleanupAttachmentsOptions[] = [
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 51 },
    { maxRounds: 0 },
    { maxRounds: -1 },
    { maxRounds: 21 },
    { maxRounds: Infinity },
    { timeBudgetMs: -1 },
    { timeBudgetMs: 20_001 },
    { timeBudgetMs: NaN },
    { timeBudgetMs: Infinity },
  ];

  test.each(cases)('%j は何も消さずに断る', async (options) => {
    const organization = await freshOrganization();
    const row = await storedAttachment(organization);
    let batches = 0;
    const observed = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (isDelete(sqls)) batches++;
      },
    });

    await expect(cleanupAttachments(observed, AT, options)).rejects.toThrow();

    expect(batches).toBe(0);
    expect(await attachmentExists(organization, row.id)).toEqual({ id: row.id });
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });

  test('時間の予算が0なら、未添付の行もファイルも残す', async () => {
    const organization = await freshOrganization();
    const row = await storedAttachment(organization);
    let batches = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (isDelete(sqls)) batches++;
      },
    });

    await cleanupAttachments(observed, AT, { timeBudgetMs: 0 });

    expect(batches).toBe(0);
    expect(await attachmentExists(organization, row.id)).toEqual({ id: row.id });
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });
});

describe('同時の実行と部分的な失敗', () => {
  test('同じ時刻の掃除が並行しても、各ファイルは実際に消えた行の分だけ削除する', async () => {
    const organization = await freshOrganization();
    const row = await storedAttachment(organization);
    const deleted: string[] = [];
    const observed = withDelete(async (keys) => {
      deleted.push(...keys);
      await env.ATTACHMENTS.delete(keys);
    });

    await Promise.all([cleanupAttachments(observed, AT), cleanupAttachments(observed, AT)]);

    expect(deleted.filter((key) => key === row.object_key)).toEqual([row.object_key]);
    expect(await attachmentExists(organization, row.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('次の組織ページの取得が失敗しても、それまでに消したファイルを戻さず、例外の文を出さない', async () => {
    const organizations = [];
    for (let index = 2001; index <= 2051; index++) organizations.push(await organizationAt(index));
    const first = organizations[0];
    const last = organizations[50];
    const firstRow = await storedAttachment(first);
    const lastRow = await storedAttachment(last);
    let lists = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observed = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (sql.includes('from "organizations"') && ++lists === 2) throw new Error('private-list-query');
      },
    });

    await expect(cleanupAttachments(observed, AT)).rejects.toThrow();

    expect(await attachmentExists(first, firstRow.id)).toBeUndefined();
    expect(await env.ATTACHMENTS.get(firstRow.object_key)).toBeNull();
    expect(await attachmentExists(last, lastRow.id)).toEqual({ id: lastRow.id });
    expect(await env.ATTACHMENTS.get(lastRow.object_key)).not.toBeNull();
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-list-query');
  });
});
