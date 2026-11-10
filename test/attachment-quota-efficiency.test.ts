// #740: 通常の組織の枠と、変化のない定期確認に全量集計・書き込みを持ち込まない。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implement } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { reconcileAttachmentQuota } from '../src/server/storage/quota-warning.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import { AT, createAttachment, createOrganization, createUser, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';
import { generatedStream, recordingBucket, upload } from './attachment-helpers.ts';
import { errorCodeOf } from './operations/harness.ts';

const at = new Date('2026-11-10T08:00:00.000Z');
const readsStorage = (query: string) => /\b(wiki_pages|wiki_page_revisions|attachments)\b/i.test(query);
const writesOrganization = (query: string) => /^\s*update\s+["`]?organizations["`]?\b/i.test(query);
const app = createApp(implementedOperations);

describe('容量を確かめる処理の負荷', () => {
  test('定期処理は通知済み・再送待ち・変更待ちがすべて空の組織の容量を読まない', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 1000 });
    const admin = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, admin.id);
    await createAttachment(organization, workspace.id, admin.id, { size_bytes: 900 });
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    const queries: string[] = [];
    const observed = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        queries.push(sql);
      },
      beforeBatch: (sqls) => {
        queries.push(...sqls);
      },
    });
    await attachmentQuotaWarningJob(observed, at);
    expect(queries.filter(readsStorage)).toEqual([]);
    const db = orgDb(env, organization.verified);
    expect(
      await db.rows(db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id))),
    ).toEqual([]);
  });

  for (const includeStorage of [undefined, false]) {
    test(`管理者が容量を要求しない組織の枠（include_storage=${String(includeStorage)}）は容量を読まない`, async () => {
      const target = await createTarget();
      const queries: string[] = [];
      const observed = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          queries.push(sql);
        },
        beforeBatch: (sqls) => {
          queries.push(...sqls);
        },
      });
      const response = await post(app, organizationInfo, {
        slug: target.slug,
        token: target.admin.token,
        body: includeStorage === undefined ? {} : { include_storage: includeStorage },
        env: observed,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ storage: null });
      expect(queries.filter(readsStorage)).toEqual([]);
    });
  }

  test('明示的に容量を要求した管理者だけに集計を返し、一般メンバーの要求では集計しない', async () => {
    const target = await createTarget();
    await createAttachment(target.organization, target.workspace.id, target.member.userId!, { size_bytes: 17 });
    for (const [person, allowed] of [
      [target.admin, true],
      [target.member, false],
    ] as const) {
      const queries: string[] = [];
      const observed = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          queries.push(sql);
        },
        beforeBatch: (sqls) => {
          queries.push(...sqls);
        },
      });
      const response = await post(app, organizationInfo, {
        slug: target.slug,
        token: person.token,
        body: { include_storage: true },
        env: observed,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { storage: unknown };
      if (allowed) {
        expect(result.storage).toMatchObject({ used_bytes: 17 });
        expect(queries.some(readsStorage)).toBe(true);
      } else {
        expect(result.storage).toBeNull();
        expect(queries.filter(readsStorage)).toEqual([]);
      }
    }
  });

  test('80%未満かつ通知状態がすべて空なら、確認を繰り返しても共通の組織行を書かない', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 1000 });
    const updates: string[] = [];
    const observed = envWithD1Hooks(env, {
      beforeBatch: (sqls) => {
        updates.push(...sqls.filter(writesOrganization));
      },
      afterQuery: async (sql) => {
        if (writesOrganization(sql)) updates.push(sql);
      },
    });
    await reconcileAttachmentQuota(observed, organization.id, at);
    await reconcileAttachmentQuota(observed, organization.id, at);
    expect(updates).toEqual([]);
  });

  test('保存後の道具は変更待ちの記録まで待つが、重い容量集計の完了でHTTP応答を待たせない', async () => {
    const target = await createTarget();
    const definition = defineOperation({
      name: 'test-quota-defer',
      description: '保存後の通知を確かめる',
      mode: 'write',
      permission: 'organization',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    const operation = implement(definition, async ({ tools }) => {
      await tools.reconcileAttachmentQuota();
      return { ok: true };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (readsStorage(sql)) await gate;
      },
    });
    const deferred: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const pendingResponse = post(createApp([operation]), definition, {
      slug: target.slug,
      token: target.admin.token,
      env: observed,
      executionCtx,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        pendingResponse,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
      expect(response, '容量集計を待たずに保存の応答が返る').not.toBeNull();
      expect(response?.status).toBe(200);
      expect(deferred.length).toBeGreaterThan(0);
      const common = commonDb(env);
      const state = await common.first(
        common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', target.organization.id)),
      );
      expect(state).toMatchObject({ attachment_quota_check_pending_at: expect.any(String) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
      await pendingResponse;
      await Promise.all(deferred);
    }
  });

  test('変更待ちがある組織は定期処理で通知され、完了後は変更待ちが空になる', async () => {
    const organization = await createOrganization({ attachment_quota_bytes: 1000 });
    const admin = await createUser(organization, { is_admin: 1 });
    const workspace = await createWorkspace(organization, admin.id);
    await createAttachment(organization, workspace.id, admin.id, { size_bytes: 900 });
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_check_pending_at: AT }).where('id', '=', organization.id),
      ),
    ]);
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    await attachmentQuotaWarningJob(testEnv, at);
    const db = orgDb(env, organization.verified);
    const rows = await db.rows(
      db.statement((q) => q.selectFrom('notifications').selectAll().where('user_id', '=', admin.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('attachment_quota_warning');
    const state = await common.first(
      common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', organization.id)),
    );
    expect(state).toMatchObject({ attachment_quota_check_pending_at: null });
  });

  for (const marker of [
    'attachment_quota_warned_at',
    'attachment_quota_warning_pending_at',
    'attachment_quota_check_pending_at',
  ] as const) {
    test(`${marker} がある組織で容量を超える添付は本文もR2も読む前に断る`, async () => {
      const target = await createTarget();
      const common = commonDb(env);
      await common.batch([
        common.statement((q) =>
          q
            .updateTable('organizations')
            .set({ attachment_quota_bytes: 1000, [marker]: AT })
            .where('id', '=', target.organization.id),
        ),
      ]);
      await createAttachment(target.organization, target.workspace.id, target.member.userId!, { size_bytes: 995 });
      const recording = recordingBucket();
      const body = generatedStream(16);
      const response = await upload(target, { env: recording.env, file: body.stream, contentLength: '16' });
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
      expect(body.pulls()).toBe(0);
      expect(recording.calls.filter((call) => call.method === 'put')).toEqual([]);
    });
  }

  test('通知の印がすべて空の通常の添付には、R2に書く前の新たな容量集計を増やさない', async () => {
    const target = await createTarget();
    const recording = recordingBucket();
    const beforePut: string[] = [];
    const collect = (sql: string) => {
      if (!recording.calls.some((call) => call.method === 'put') && readsStorage(sql)) beforePut.push(sql);
    };
    const observed = envWithD1Hooks(recording.env, {
      afterQuery: async (sql) => {
        collect(sql);
      },
      beforeBatch: (sqls) => {
        sqls.forEach(collect);
      },
    });
    const response = await upload(target, { env: observed });
    expect(response.status).toBe(200);
    expect(beforePut).toEqual([]);
    expect(recording.calls.filter((call) => call.method === 'put')).toHaveLength(1);
  });

  test('添付単体が組織の上限を超えるなら通知の印がなくても容量を集計せず本文とR2の前に断る', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 1000 }).where('id', '=', target.organization.id),
      ),
    ]);
    const recording = recordingBucket();
    const queries: string[] = [];
    const observed = envWithD1Hooks(recording.env, {
      afterQuery: async (sql) => {
        queries.push(sql);
      },
      beforeBatch: (sqls) => {
        queries.push(...sqls);
      },
    });
    const body = generatedStream(1001);
    const response = await upload(target, { env: observed, file: body.stream, contentLength: '1001' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
    expect(body.pulls()).toBe(0);
    expect(recording.calls.filter((call) => call.method === 'put')).toEqual([]);
    expect(queries.filter(readsStorage)).toEqual([]);
  });

  test('印のない組織で原子的な容量判定に断られたらR2を片付け変更待ちだけを記録し、次の要求は本文の前に断る', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 1000 }).where('id', '=', target.organization.id),
      ),
    ]);
    await createAttachment(target.organization, target.workspace.id, target.member.userId!, { size_bytes: 995 });
    const first = recordingBucket();
    const firstResponse = await upload(target, { env: first.env });
    expect(firstResponse.status).toBe(409);
    expect(await errorCodeOf(firstResponse)).toBe('attachment_quota_exceeded');
    const puts = first.calls.filter((call) => call.method === 'put');
    const deletes = first.calls.filter((call) => call.method === 'delete');
    expect(puts).toHaveLength(1);
    expect(deletes.map((call) => call.key)).toEqual(puts.map((call) => call.key));
    expect(await first.bucket.get(String(puts[0]!.key))).toBeNull();
    const state = await common.first(
      common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', target.organization.id)),
    );
    expect(state).toMatchObject({
      attachment_quota_check_pending_at: expect.any(String),
      attachment_quota_warned_at: null,
      attachment_quota_warning_pending_at: null,
    });
    const second = recordingBucket();
    const body = generatedStream(16);
    const secondResponse = await upload(target, { env: second.env, file: body.stream, contentLength: '16' });
    expect(secondResponse.status).toBe(409);
    expect(await errorCodeOf(secondResponse)).toBe('attachment_quota_exceeded');
    expect(body.pulls()).toBe(0);
    expect(second.calls.filter((call) => call.method === 'put')).toEqual([]);
  });
});
