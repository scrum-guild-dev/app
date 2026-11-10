import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/server/app.ts';
import { commonDb, markAttachmentQuotaCheck } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implement } from '../src/server/operations/implement.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { createAttachment } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';

const at = new Date('2026-11-10T08:00:00.000Z');

describe('容量確認の変更待ちとdeferの合流', () => {
  test('markOnlyはすでに変更待ちなら共通行を書かず、保存世代も増やさない', async () => {
    const target = await createTarget();
    await markAttachmentQuotaCheck(env, target.organization.id, at);
    const common = commonDb(env);
    const readState = () =>
      common.first(
        common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', target.organization.id)),
      );
    const before = (await readState())!;
    const updates: string[] = [];
    const observed = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        updates.push(...sqls.filter((sql) => /^update "organizations"/.test(sql)));
      },
    });
    const definition = defineOperation({
      name: 'test-mark-only-existing-dirty',
      description: '容量拒否の変更待ちを記録する',
      mode: 'write',
      permission: 'organization',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    const operation = implement(definition, async ({ tools }) => {
      await tools.reconcileAttachmentQuota({ markOnly: true });
      return { ok: true };
    });
    const response = await post(createApp([operation]), definition, {
      slug: target.slug,
      token: target.admin.token,
      env: observed,
    });
    expect(response.status).toBe(200);
    expect(updates).toEqual([]);
    const after = (await readState())!;
    expect(after.attachment_quota_check_generation).toBe(before.attachment_quota_check_generation);
    expect(after.attachment_quota_check_pending_at).toBe(before.attachment_quota_check_pending_at);
  });

  test('同じ組織の保存が集中しても実行中の容量集計は1本に合流し、最新保存の確認を1回追随する', async () => {
    const target = await createTarget();
    const attachment = await createAttachment(target.organization, target.workspace.id, target.admin.userId!, {
      size_bytes: 700,
    });
    const common = commonDb(env);
    const definition = defineOperation({
      name: 'test-coalesced-storage-save',
      description: '容量を変える保存と変更待ちを記録する',
      mode: 'write',
      permission: 'organization',
      input: z.object({ bytes: z.number().int() }),
      output: z.object({ ok: z.boolean() }),
    });
    const operation = implement(definition, async ({ db, tools, input }) => {
      await db.batch([
        db.statement((q) =>
          q.updateTable('attachments').set({ size_bytes: input.bytes }).where('id', '=', attachment.id),
        ),
      ]);
      await tools.reconcileAttachmentQuota();
      return { ok: true };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aggregates = 0;
    const observed = envWithD1Hooks(testEnv, {
      afterQuery: async (query) => {
        if (query.includes('wiki_page_revisions')) {
          aggregates++;
          if (aggregates === 1) started();
          await gate;
        }
      },
    });
    const deferred: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const app = createApp([operation]);
    const save = (bytes: number) =>
      post(app, definition, {
        slug: target.slug,
        token: target.admin.token,
        body: { bytes },
        env: observed,
        executionCtx,
      });
    try {
      expect((await save(701)).status).toBe(200);
      await firstStarted;
      for (const bytes of [702, 703, 704, 705]) expect((await save(bytes)).status).toBe(200);
      expect(aggregates, '最初の容量集計を待つ間は同じ組織の別集計を開始しない').toBe(1);
      const dirty = await common.first(
        common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', target.organization.id)),
      );
      expect(dirty?.attachment_quota_check_pending_at).not.toBeNull();
      release();
      await Promise.all(deferred);
      expect(aggregates).toBe(2);
      const done = await common.first(
        common.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', target.organization.id)),
      );
      expect(done?.attachment_quota_check_pending_at).toBeNull();
    } finally {
      release();
      await Promise.all(deferred);
    }
  });
});
