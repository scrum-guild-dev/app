import { now } from '../../shared/clock.ts';
import { XP_EPIC_REWARD, type EpicRewardTier } from '../../shared/experience.ts';
import { epicComplete, epicReopen } from '../../shared/operations/epic/index.ts';
import type { EpicClearConflictReason } from '../../shared/operations/epic/epic-clear.ts';
import {
  jsonList,
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, isLeaderOrAdmin, openWorkspace, throwIfClosed } from './write-guards.ts';

// エピックのクリアと取り消し（docs/data-model.md の epics、xp_grants と「書き込みの単位」）。書き方はストーリーの完了と取り消し
// （story.ts）と同じで、先に読んで断る順を決め、書く文は読んだ値を条件にした UPDATE、直前の文に結んだ履歴、
// 履歴の行を条件にした経験値の明細にする。通らなければ読み直して決め直す

type Tables = OrganizationTables;

// 同時の書き込みに負けたときにやり直す回数の上限。超えたら 409 の conflict（changed）
const MAX_ATTEMPTS = 3;

function clearConflict(reason: EpicClearConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 配下の、削除していないストーリー。ワークスペースで必ず絞る
function storiesUnder(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, epicId: string) {
  return from
    .selectFrom('stories')
    .select('stories.id')
    .where('stories.epic_id', '=', epicId)
    .where('stories.workspace_id', '=', workspaceId)
    .where('stories.deleted_at', 'is', null);
}

// クリア報酬を受け取る人の、討伐隊の行。今そのワークスペースに所属している人だけ。
// epic_party_members は workspace_id を持たないので、ワークスペースで絞ったエピックを結ぶ
function recipientRows(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, epicId: string) {
  return from
    .selectFrom('epic_party_members as p')
    .innerJoin('epics', 'epics.id', 'p.epic_id')
    .where('p.epic_id', '=', epicId)
    .where('epics.workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('memberships')
          .select('memberships.id')
          .whereRef('memberships.user_id', '=', 'p.user_id')
          .where('memberships.workspace_id', '=', workspaceId)
          .where('memberships.left_at', 'is', null),
      ),
    );
}

// 自分の履歴の行がある、という条件。経験値の付与と打ち消しは、これで自分の更新が通ったことを見る
// （履歴は直前の UPDATE が行を変えたときだけ入り、id はこの要求だけの値なので、止めた時計でも負けた要求とは一致しない）
function ownLog(from: Pick<QueryCreator<Tables>, 'selectFrom'>, workspaceId: string, logId: string) {
  return from
    .selectFrom('change_logs')
    .select('change_logs.id')
    .where('change_logs.id', '=', logId)
    .where('change_logs.workspace_id', '=', workspaceId);
}

const grantColumns = [
  'id',
  'workspace_id',
  'user_id',
  'action',
  'epic_id',
  'amount',
  'reverses_grant_id',
  'dedupe_key',
  'confirmed_at',
] as const;

// 読んだエピックの状態。クリアしたか、中止したか、依頼主、段階、クリアにした人（履歴の「前」に使う名前）、
// 配下のストーリーの件数と未完了の件数、報酬の受け取り手
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string) {
  const [epicResult, countResult, recipientResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('epics')
        .leftJoin('users as done_by', (join) =>
          join.onRef('done_by.id', '=', 'epics.completed_by').on('done_by.organization_id', '=', db.organizationId),
        )
        .select([
          'epics.reward_tier',
          'epics.requester_user_id',
          'epics.completed_at',
          'epics.completed_by',
          'epics.canceled_at',
          'done_by.name as completed_by_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select((eb) => [eb.fn.countAll<number>().as('total'), eb.fn.count<number>('stories.completed_at').as('done')])
        .where('stories.epic_id', '=', epicId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
    db.statement((q) => recipientRows(q, workspaceId, epicId).select('p.user_id').orderBy('p.user_id')),
  ] as const);
  const row = epicResult.rows[0];
  if (row === undefined) return undefined;
  const total = Number(countResult.rows[0]?.total ?? 0);
  const done = Number(countResult.rows[0]?.done ?? 0);
  return {
    // 列の CHECK が守る値
    rewardTier: row.reward_tier as EpicRewardTier,
    requesterUserId: row.requester_user_id,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    completedByName: row.completed_by_name,
    canceled: row.canceled_at !== null,
    storyCount: total,
    openCount: total - done,
    recipients: recipientResult.rows.map((r) => r.user_id),
  };
}

type EpicState = NonNullable<Awaited<ReturnType<typeof readEpic>>>;

// クリアする前に断る順。無い（404）、権限が無い（403）、中止した（409 の epic_finished）、すでにクリアした（completed）、
// 配下が無い（empty）、未完了が残っている（open_stories）。閉じたワークスペースは、409 を返す前に 409 の workspace_closed にする
async function clearableEpic(
  db: OrganizationDb,
  workspaceId: string,
  epic: EpicState | undefined,
  allowed: (epic: EpicState) => boolean,
): Promise<EpicState> {
  if (epic === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!allowed(epic)) throw new ApiError(403, 'forbidden');
  if (epic.canceled) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(409, 'epic_finished');
  }
  if (epic.completedAt !== null) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('completed');
  }
  if (epic.storyCount === 0) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('empty');
  }
  if (epic.openCount > 0) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('open_stories');
  }
  return epic;
}

// クリアする。UPDATE の条件は、同じワークスペースの削除していない、クリアも中止もしていないエピック、閉じていないワークスペース、
// 読んだ段階のまま、依頼主かリーダー、配下の削除していないストーリーが1件以上あり未完了が無いこと、
// 討伐隊の今所属している人が読んだ人の外に増えていないこと。通らなかったら、読み直して決め直す（受け取り手が変わっただけなら、やり直す）
export const epicCompleteOperation = implement(epicComplete, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const leader = isLeaderOrAdmin(actor, workspace);

  // 履歴に残す自分の名前
  const user = await db.first(
    db.statement((q) =>
      q.selectFrom('users').select('name').where('id', '=', userId).where('organization_id', '=', organizationId),
    ),
  );
  if (user === undefined) throw new ApiError(404, 'not_found');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const epic = await clearableEpic(
      db,
      workspaceId,
      await readEpic(db, workspaceId, epicId),
      (e) => leader || e.requesterUserId === userId,
    );

    const at = now();
    const completedAt = at.toISOString();
    const logId = uuidv7(at);
    const { recipients, rewardTier } = epic;
    const amount = XP_EPIC_REWARD[rewardTier];
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ completed_at: completedAt, completed_by: userId, updated_at: completedAt })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where('canceled_at', 'is', null)
          // 読んだ段階のまま（払う額がずれないように）
          .where('reward_tier', '=', rewardTier)
          .$if(!leader, (qb) => qb.where('requester_user_id', '=', userId))
          .where((eb) =>
            eb.and([
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.exists(storiesUnder(q, workspaceId, epicId)),
              eb.not(eb.exists(storiesUnder(q, workspaceId, epicId).where('stories.completed_at', 'is', null))),
              eb.not(
                eb.exists(
                  recipientRows(q, workspaceId, epicId)
                    .select('p.user_id')
                    // 受け取り手が多くても bind の上限に当たらないよう、一覧は1つの値で渡す
                    .where('p.user_id', 'not in', jsonList(recipients)),
                ),
              ),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(logId).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(userId).as('actor_user_id'),
                eb.val('epic').as('entity_type'),
                eb.val(epicId).as('entity_id'),
                eb.val('complete').as('action'),
                eb
                  .val(
                    JSON.stringify({
                      completed_at: [null, completedAt],
                      completed_by: [null, { id: userId, name: user.name }],
                    }),
                  )
                  .as('changes_json'),
                eb.val(completedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      // 受け取り手に1人1行ずつ。書くときにも、討伐隊にいて今所属していることを確かめる
      ...recipients.map((recipient) => {
        // 回のキー。止めた時計（DEV_NOW）で、クリア、取り消し、クリアを同じ時刻に流しても付け直せるよう、この要求の履歴の ID も含める
        const dedupeKey = `epic_reward:${epicId}:${recipient}:${completedAt}:${logId}`;
        return db.statement((q) =>
          q
            .insertInto('xp_grants')
            .columns(grantColumns)
            .expression(
              q
                .selectNoFrom((eb) => [
                  eb.val(uuidv7(at)).as('id'),
                  eb.val(workspaceId).as('workspace_id'),
                  eb.val(recipient).as('user_id'),
                  eb.val('epic_reward').as('action'),
                  eb.val(epicId).as('epic_id'),
                  eb.val(amount).as('amount'),
                  eb.val(null).as('reverses_grant_id'),
                  eb.val(dedupeKey).as('dedupe_key'),
                  eb.val(completedAt).as('confirmed_at'),
                ])
                .where((eb) =>
                  eb.and([
                    eb.exists(ownLog(eb, workspaceId, logId)),
                    eb.exists(
                      recipientRows(eb, workspaceId, epicId).select('p.user_id').where('p.user_id', '=', recipient),
                    ),
                    eb.not(
                      eb.exists(
                        eb
                          .selectFrom('xp_grants')
                          .select('xp_grants.id')
                          .where('xp_grants.workspace_id', '=', workspaceId)
                          .where('xp_grants.dedupe_key', '=', dedupeKey),
                      ),
                    ),
                  ]),
                ),
            ),
        );
      }),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      // 付けた人数は、付与の文が実際に行を足した数（読んでから書くまでに討伐隊を抜けた人には付かない）
      const granted = results.slice(2).filter((result) => (result.changes ?? 0) > 0).length;
      return { epic_id: epicId, completed_at: completedAt, reward_xp: amount, recipient_count: granted };
    }
    // 閉じていれば 409 の workspace_closed。そうでなければ読み直して決め直す（上の順）。それでも断る理由が無ければ、やり直す
    await throwIfClosed(db, workspaceId);
  }
  throw clearConflict('changed');
});

// 取り消す前に断る順。無い（404）、権限が無い（403）、中止した（409 の epic_finished）、クリアしていない（not_completed）
async function reopenableEpic(
  db: OrganizationDb,
  workspaceId: string,
  epic: EpicState | undefined,
  allowed: (epic: EpicState) => boolean,
): Promise<EpicState> {
  if (epic === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (!allowed(epic)) throw new ApiError(403, 'forbidden');
  if (epic.canceled) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(409, 'epic_finished');
  }
  if (epic.completedAt === null) {
    await throwIfClosed(db, workspaceId);
    throw clearConflict('not_completed');
  }
  return epic;
}

export const epicReopenOperation = implement(epicReopen, async ({ db, actor, workspace, input }) => {
  const userId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const leader = isLeaderOrAdmin(actor, workspace);

  const epic = await reopenableEpic(
    db,
    workspaceId,
    await readEpic(db, workspaceId, epicId),
    (e) => leader || e.requesterUserId === userId,
  );
  const completedAt = epic.completedAt!;

  // 打ち消す付与。このエピックの、打ち消されていないクリア報酬。クリアした日時が読んだ値のままなら（書く文の条件）、
  // 読んでから書くまでに新しい付与は入らない（入るのは、取り消してからもう一度クリアしたときだけ）
  const grants = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('xp_grants as g')
        .select(['g.id', 'g.user_id', 'g.amount'])
        .where('g.epic_id', '=', epicId)
        .where('g.workspace_id', '=', workspaceId)
        .where('g.action', '=', 'epic_reward')
        .where('g.reverses_grant_id', 'is', null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('xp_grants as r')
                .select('r.id')
                .whereRef('r.reverses_grant_id', '=', 'g.id')
                .where('r.workspace_id', '=', workspaceId),
            ),
          ),
        )
        .orderBy('g.id'),
    ),
  );

  const at = now();
  const reopenedAt = at.toISOString();
  const logId = uuidv7(at);
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('epics')
        .set({ completed_at: null, completed_by: null, updated_at: reopenedAt })
        .where('id', '=', epicId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where('completed_at', '=', completedAt)
        .where('canceled_at', 'is', null)
        .$if(!leader, (qb) => qb.where('requester_user_id', '=', userId))
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
    // 直前の UPDATE が行を変えたときだけ
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(logId).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(userId).as('actor_user_id'),
              eb.val('epic').as('entity_type'),
              eb.val(epicId).as('entity_id'),
              eb.val('reopen').as('action'),
              eb
                .val(
                  JSON.stringify({
                    completed_at: [completedAt, null],
                    completed_by: [
                      epic.completedBy === null ? null : { id: epic.completedBy, name: epic.completedByName ?? '' },
                      null,
                    ],
                  }),
                )
                .as('changes_json'),
              eb.val(reopenedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
    // 打ち消しの明細。元の行を指し、負の値を足す
    ...grants.map((grant) =>
      db.statement((q) =>
        q
          .insertInto('xp_grants')
          .columns(grantColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(grant.user_id).as('user_id'),
                eb.val('epic_reward').as('action'),
                eb.val(epicId).as('epic_id'),
                eb.val(-grant.amount).as('amount'),
                eb.val(grant.id).as('reverses_grant_id'),
                eb.val(`reversal:${grant.id}`).as('dedupe_key'),
                eb.val(reopenedAt).as('confirmed_at'),
              ])
              .where((eb) =>
                eb.and([
                  eb.exists(ownLog(eb, workspaceId, logId)),
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('xp_grants')
                        .select('xp_grants.id')
                        .where('xp_grants.reverses_grant_id', '=', grant.id)
                        .where('xp_grants.workspace_id', '=', workspaceId),
                    ),
                  ),
                ]),
              ),
          ),
      ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、消えたか、別の要求が先に取り消したか、中止したか、
    // 取り消してからもう一度クリアされた（クリアした日時が変わった）
    await throwIfClosed(db, workspaceId);
    await reopenableEpic(
      db,
      workspaceId,
      await readEpic(db, workspaceId, epicId),
      (e) => leader || e.requesterUserId === userId,
    );
    throw clearConflict('changed');
  }
  return { epic_id: epicId };
});
