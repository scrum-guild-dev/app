import { now } from '../../shared/clock.ts';
import { PERSONAL_ORGANIZATION_NAME } from '../../shared/organization-kind.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import { createPersonalOrganization } from '../../shared/operations/organization/index.ts';
import { ApiError } from '../errors.ts';
import { abandon, writeFirstAdmin } from './create-my-organization.ts';
import { implement } from './implement.ts';
import { invalid } from './operator-nominee.ts';

// 順は create-my-organization と同じ（docs/data-model.md の「書き込みの単位」）:
//   1. slug の形を確かめる  2. 最も早いログインを読む  3. organizations を書く（自分用の上限と slug の重なりはこの文が確かめる）
//   4. 組織の DB に管理者の users と change_logs を書く。4 が失敗したら 3 の行を消す
// 名前は固定の「自分用」で、入力から受け取らない。作った人が管理者の1人だけになる
export const createPersonalOrganizationOperation = implement(
  createPersonalOrganization,
  async ({ db, accountId, account, input }) => {
    const problem = slugProblem(input.slug);
    if (problem !== undefined) {
      throw invalid(
        'slug',
        problem === 'format' ? 'slug_format' : 'slug_reserved',
        problem === 'format' ? 'slug の形に合わない' : 'アプリが使う名前は slug にできない',
      );
    }

    const login = await db.first(
      db.statement((q) =>
        q
          .selectFrom('account_logins')
          .select(['login_provider', 'login_subject', 'login_name'])
          .where('account_id', '=', accountId)
          .orderBy('created_at')
          .orderBy('login_provider')
          .orderBy('login_subject')
          .limit(1),
      ),
    );
    if (login === undefined) throw new Error('組織を作るアカウントのログインが無い');

    const createdAt = now();
    const name = PERSONAL_ORGANIZATION_NAME;
    const created = await account.createPersonalOrganization({ slug: input.slug, name, now: createdAt });
    if (created === 'slug_taken') throw new ApiError(409, 'conflict', { reason: 'slug_taken' });
    if (created === 'personal_limit') throw new ApiError(409, 'conflict', { reason: 'personal_limit' });

    try {
      await writeFirstAdmin(created, { slug: input.slug, name, createdAt, kind: 'personal' }, { accountId, login });
    } catch (err) {
      await abandon(account, created.organizationId, createPersonalOrganization.name);
      throw err;
    }
    return { slug: input.slug, name };
  },
);
