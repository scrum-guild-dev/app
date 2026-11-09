import type { z } from 'zod';
import { now } from '../../shared/clock.ts';
import { favoriteList, favoriteSet } from '../../shared/operations/favorite.ts';
import type { OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement, type ContextOf } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

type Kind = z.output<typeof favoriteSet.input>['target_type'];
type Context = Pick<ContextOf<typeof favoriteSet>, 'db' | 'actor'>;
const columns = { task: 'task_id', story: 'story_id', epic: 'epic_id', wiki_page: 'wiki_page_id' } as const;
const kinds = ['task', 'story', 'epic', 'wiki_page'] as const;
const LIMIT = 20;

// 組織内の本人を確かめる。書く文でも、途中の無効化・権限変更を同じ条件で検査する。
function viewer(q: QueryCreator<OrganizationTables>, { db, actor }: Context) {
  return q
    .selectFrom('users as viewer')
    .select('viewer.id')
    .where('viewer.id', '=', actorUserIdOf(actor))
    .where('viewer.organization_id', '=', db.organizationId)
    .where('viewer.account_id', '=', actor.accountId)
    .where('viewer.disabled_at', 'is', null);
}
function readableWorkspaces(q: QueryCreator<OrganizationTables>, context: Context, hideClosed: boolean) {
  let query = q
    .selectFrom('workspaces as allowed_workspace')
    .select('allowed_workspace.id')
    .where('allowed_workspace.organization_id', '=', context.db.organizationId)
    .where((eb) =>
      eb.and([
        eb.exists(viewer(q, context)),
        eb.or([
          eb.exists(viewer(q, context).where('viewer.is_admin', '=', 1)),
          eb(
            'allowed_workspace.id',
            'in',
            q
              .selectFrom('memberships')
              .select('memberships.workspace_id')
              .where('memberships.user_id', '=', actorUserIdOf(context.actor))
              .where('memberships.left_at', 'is', null),
          ),
        ]),
      ]),
    );
  if (hideClosed) query = query.where('allowed_workspace.closed_at', 'is', null);
  return query;
}
function visibleTargets(
  q: QueryCreator<OrganizationTables>,
  context: Context,
  kind: Kind,
  ids: string[],
  hideClosed: boolean,
) {
  const workspaces = readableWorkspaces(q, context, hideClosed);
  if (kind === 'wiki_page') {
    return q
      .selectFrom('wiki_pages as target')
      .select(['target.id as target_id', 'target.title', 'target.workspace_id'])
      .where('target.id', 'in', ids)
      .where('target.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('target.organization_id', '=', context.db.organizationId),
            eb('target.workspace_id', 'is', null),
            eb.exists(
              viewer(q, context).where((inner) =>
                inner.or([
                  inner('viewer.is_admin', '=', 1),
                  inner.exists(
                    inner
                      .selectFrom('memberships as active_membership')
                      .innerJoin(
                        'workspaces as active_workspace',
                        'active_workspace.id',
                        'active_membership.workspace_id',
                      )
                      .select('active_membership.id')
                      .where('active_membership.user_id', '=', actorUserIdOf(context.actor))
                      .where('active_membership.left_at', 'is', null)
                      .where('active_workspace.organization_id', '=', context.db.organizationId),
                  ),
                ]),
              ),
            ),
          ]),
          eb('target.workspace_id', 'in', workspaces),
        ]),
      );
  }
  const entity =
    kind === 'task'
      ? q
          .selectFrom('tasks')
          .select(['id as target_id', 'title', 'workspace_id'])
          .where('id', 'in', ids)
          .where('deleted_at', 'is', null)
          .as('target')
      : kind === 'story'
        ? q
            .selectFrom('stories')
            .select(['id as target_id', 'title', 'workspace_id'])
            .where('id', 'in', ids)
            .where('deleted_at', 'is', null)
            .as('target')
        : q
            .selectFrom('epics')
            .select(['id as target_id', 'title', 'workspace_id'])
            .where('id', 'in', ids)
            .where('deleted_at', 'is', null)
            .as('target');
  return q
    .selectFrom(entity)
    .select(['target.target_id', 'target.title', 'target.workspace_id'])
    .where('target.workspace_id', 'in', workspaces);
}
function ownFavorites(q: QueryCreator<OrganizationTables>, db: OrganizationDb, userId: string) {
  return q
    .selectFrom('favorites')
    .innerJoin('users as owner', 'owner.id', 'favorites.user_id')
    .where('favorites.user_id', '=', userId)
    .where('owner.organization_id', '=', db.organizationId);
}

export const favoriteListOperation = implement(favoriteList, async (context) => {
  const { db, actor } = context;
  const userId = actorUserIdOf(actor);
  // 保存行は最大20件。先に本人の行だけ引き、種類ごとの問い合わせで現在見える対象を解決する。
  const stored = await db.rows(
    db.statement((q) =>
      ownFavorites(q, db, userId)
        .select([
          'favorites.id',
          'favorites.workspace_id',
          'favorites.task_id',
          'favorites.story_id',
          'favorites.epic_id',
          'favorites.wiki_page_id',
          'favorites.created_at',
        ])
        .orderBy('favorites.created_at', 'desc')
        .orderBy('favorites.id', 'desc')
        .limit(LIMIT),
    ),
  );
  const resolved = new Map<string, { title: string; workspace_id: string | null }>();
  await Promise.all(
    kinds.map(async (kind) => {
      const ids = stored.flatMap((row) => (row[columns[kind]] === null ? [] : [row[columns[kind]]!]));
      if (ids.length === 0) return;
      const rows = await db.rows(db.statement((q) => visibleTargets(q, context, kind, ids, true)));
      for (const row of rows) resolved.set(`${kind}:${row.target_id}`, row);
    }),
  );
  return {
    favorites: stored.flatMap((row) => {
      const kind = kinds.find((candidate) => row[columns[candidate]] !== null)!;
      const id = row[columns[kind]]!;
      const target = resolved.get(`${kind}:${id}`);
      return target === undefined
        ? []
        : [
            {
              id: row.id,
              target_type: kind,
              target_id: id,
              workspace_id: target.workspace_id,
              title: target.title,
              created_at: row.created_at,
            },
          ];
    }),
  };
});

export const favoriteSetOperation = implement(favoriteSet, async (context) => {
  const { db, actor, input } = context;
  const userId = actorUserIdOf(actor);
  const column = columns[input.target_type];
  const existing = () =>
    db.first(
      db.statement((q) =>
        ownFavorites(q, db, userId).select('favorites.id').where(`favorites.${column}`, '=', input.target_id),
      ),
    );
  const target = () =>
    db.first(db.statement((q) => visibleTargets(q, context, input.target_type, [input.target_id], false)));
  if (!input.is_favorite) {
    // 非表示になった本人の印も外せる。未登録の対象は読める場合だけ冪等な成功を返す。
    if ((await existing()) === undefined && (await target()) === undefined) throw new ApiError(404, 'not_found');
    await db.batch([
      db.statement((q) =>
        q
          .deleteFrom('favorites')
          .where('user_id', '=', userId)
          .where(column, '=', input.target_id)
          .where('user_id', 'in', viewer(q, context)),
      ),
    ]);
    return { is_favorite: false };
  }
  const at = now();
  // 挿入と結果の判定を同じトランザクションに置く。コミット直後の解除・追加で結果を取り違えない。
  const [inserted, visible, stored, usage] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('favorites')
        .columns(['id', 'user_id', 'workspace_id', 'task_id', 'story_id', 'epic_id', 'wiki_page_id', 'created_at'])
        .expression(
          q
            .selectFrom(visibleTargets(q, context, input.target_type, [input.target_id], false).as('visible'))
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(userId).as('user_id'),
              'visible.workspace_id',
              eb.val(input.target_type === 'task' ? input.target_id : null).as('task_id'),
              eb.val(input.target_type === 'story' ? input.target_id : null).as('story_id'),
              eb.val(input.target_type === 'epic' ? input.target_id : null).as('epic_id'),
              eb.val(input.target_type === 'wiki_page' ? input.target_id : null).as('wiki_page_id'),
              eb.val(at.toISOString()).as('created_at'),
            ])
            .where((eb) =>
              eb(
                ownFavorites(q, db, userId).select((count) => count.fn.countAll<number>().as('used')),
                '<',
                LIMIT,
              ),
            ),
        )
        .onConflict((conflict) => conflict.doNothing()),
    ),
    db.statement((q) => visibleTargets(q, context, input.target_type, [input.target_id], false)),
    db.statement((q) =>
      ownFavorites(q, db, userId).select('favorites.id').where(`favorites.${column}`, '=', input.target_id),
    ),
    db.statement((q) => ownFavorites(q, db, userId).select((eb) => eb.fn.countAll<number>().as('used'))),
  ] as const);
  if (inserted.changes > 0) return { is_favorite: true };
  if (visible.rows.length === 0) throw new ApiError(404, 'not_found');
  if (stored.rows.length > 0) return { is_favorite: true };
  const used = Number(usage.rows[0]?.used ?? 0);
  if (used >= LIMIT) throw new ApiError(409, 'favorite_limit', { used, limit: LIMIT });
  // 同じ batch の通常の結果では到達しない防御分岐。上限未満を上限超過として扱わない。
  throw new ApiError(409, 'conflict');
});
