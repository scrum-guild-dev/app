import { now } from '../../shared/clock.ts';
import { accountProfileSave, onboardingStatus } from '../../shared/operations/session/onboarding.ts';
import type { CommonDb } from '../db/index.ts';
import { implement } from './implement.ts';

// 組織を作る前の名前にも使う。組織の中の表とは結合しない。
export function readAccountProfile(db: CommonDb, accountId: string) {
  return db.first(
    db.statement((q) => q.selectFrom('account_profiles').select(['name', 'title']).where('account_id', '=', accountId)),
  );
}

export const accountProfileSaveOperation = implement(accountProfileSave, async ({ db, accountId, input }) => {
  const at = now().toISOString();
  await db.batch([
    db.statement((q) =>
      q
        .insertInto('account_profiles')
        .values({ account_id: accountId, ...input, created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('account_id').doUpdateSet({ ...input, updated_at: at })),
    ),
  ]);
  return input;
});

export const onboardingStatusOperation = implement(onboardingStatus, async ({ db, accountId, account }) => {
  const [profile, personal] = await Promise.all([
    readAccountProfile(db, accountId),
    db.first(
      db.statement((q) =>
        q
          .selectFrom('organizations')
          .select('slug')
          .where('created_by_account_id', '=', accountId)
          .where('kind', '=', 'personal'),
      ),
    ),
  ]);
  if (personal === undefined) return { profile: profile ?? null, personal: null };
  // 停止・無効な自分用も存在は返す。入れるかは既存の組織一覧の判定に揃える。
  const { organizations } = await account.organizations();
  return {
    profile: profile ?? null,
    personal: {
      slug: personal.slug,
      available: organizations.some(
        (organization) => organization.kind === 'personal' && organization.slug === personal.slug,
      ),
    },
  };
});
