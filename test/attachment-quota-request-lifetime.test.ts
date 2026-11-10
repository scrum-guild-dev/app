import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { reconcileAttachmentQuotaAfterSave } from '../src/server/storage/quota-warning.ts';
import { createOrganization } from './factories.ts';

afterEach(() => vi.restoreAllMocks());

async function pausedCheck(pauseReplacement = false) {
  const organization = await createOrganization();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let releaseReplacement!: () => void;
  let replacementStarted!: () => void;
  const replacementGate = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    replacementStarted = resolve;
  });
  let aggregates = 0;
  const observed = envWithD1Hooks(env, {
    afterQuery: async (query) => {
      if (query.includes('wiki_page_revisions')) {
        aggregates++;
        if (aggregates === 1) {
          started();
          await gate;
        } else if (aggregates === 2 && pauseReplacement) {
          replacementStarted();
          await replacementGate;
        }
      }
    },
  });
  return {
    organization,
    observed,
    release,
    firstStarted,
    releaseReplacement,
    secondStarted,
    aggregates: () => aggregates,
  };
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

  test('29,999msでは合流し、元の集計が未完了でも30,000msちょうどで古い合流状態を置き換える', async () => {
    const target = await pausedCheck();
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const first = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
    let replacement: Promise<void> | undefined;
    try {
      await target.firstStarted;
      clock.mockReturnValue(base + 29_999);
      const joined = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
      expect(await settlesSoon(joined), '有効期限の直前は元の集計を待たず合流する').toBe(true);
      expect(target.aggregates(), '有効期限の直前に別の容量集計を起こさない').toBe(1);
      clock.mockReturnValue(base + 30_000);
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

  test('期限切れの旧ownerが完了しても、停止中のreplacementの合流状態を消さない', async () => {
    const target = await pausedCheck(true);
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const first = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
    let replacement: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    try {
      await target.firstStarted;
      clock.mockReturnValue(base + 30_000);
      replacement = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
      await target.secondStarted;
      expect(target.aggregates()).toBe(2);
      // replacementも実際のD1集計後で止めたまま、旧ownerだけfinallyまで進める。
      target.release();
      await first;
      clock.mockReturnValue(base + 30_001);
      third = reconcileAttachmentQuotaAfterSave(target.observed, target.organization.id);
      expect(await settlesSoon(third), '第三の要求は実行中のreplacementへ待たずに合流する').toBe(true);
      expect(target.aggregates(), '旧ownerのfinallyが新しいownerの印を消して第三の集計を起こさない').toBe(2);
    } finally {
      target.release();
      target.releaseReplacement();
      await first;
      await replacement;
      await third;
    }
  });
});
