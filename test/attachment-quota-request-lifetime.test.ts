import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuotaAfterSave } from '../src/server/storage/quota-warning.ts';
import { createOrganization } from './factories.ts';

async function pausedCheck() {
  const organization = await createOrganization();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aggregates = 0;
  const observed = envWithD1Hooks(env, {
    afterQuery: async (query) => {
      if (query.includes('wiki_page_revisions')) {
        aggregates++;
        if (aggregates === 1) {
          started();
          await gate;
        }
      }
    },
  });
  return { organization, observed, release, firstStarted, aggregates: () => aggregates };
}

async function settlesSoon(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('保存後の容量確認とリクエストの寿命', () => {
  test('合流した別リクエストの確認は、最初のリクエストに属する集計の完了を待たない', async () => {
    const target = await pausedCheck();
    const first = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
    let joined: Promise<void> | undefined;
    try {
      await target.firstStarted;
      joined = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
      expect(await settlesSoon(joined), '別リクエストが待つpromiseを実行中の元リクエストへ結び付けない').toBe(true);
      expect(target.aggregates()).toBe(1);
    } finally {
      target.release();
      await first;
      await joined;
    }
  });

  test('元の集計が決着しないまま30秒を超えたら、新しいリクエストは古い合流状態を置き換えて確認する', async () => {
    const target = await pausedCheck();
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const first = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
    let replacement: Promise<void> | undefined;
    try {
      await target.firstStarted;
      clock.mockReturnValue(base + 30_001);
      replacement = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
      expect(await settlesSoon(replacement), '古いリクエストのfinallyを待たず新しい確認を完了できる').toBe(true);
      expect(target.aggregates(), '合流状態の有効期限後に新たな容量集計を行う').toBe(2);
    } finally {
      target.release();
      await first;
      await replacement;
      clock.mockRestore();
    }
  });
});
