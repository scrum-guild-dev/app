import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { EPIC_DEFAULT_REWARD_TIER } from '../../shared/epic.ts';
import { canonicalLinkUrl, linkUrlProblem, normalizeLinkUrl, normalizeLongText } from '../../shared/story.ts';
import { epicCreate, epicGet, epicMove, epicUpdate, type EpicDetail } from '../../shared/operations/epic/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { categoryRow, readCategoryRef, refOf } from './definition-refs.ts';
import { implement } from './implement.ts';
import {
  MAX_TIES,
  moveConflict,
  placeAfter,
  placeFirst,
  placeLast,
  type MovePlan,
  type Positioned,
} from './move-position.ts';
import { epicDeletion } from './tree-delete.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// エピックのダイアログの欄。作るときの履歴に使う
const EDITABLE_FIELDS = ['title', 'body_md', 'due_on', 'link_url'] as const;

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（story-update と同じ）
const MAX_UPDATE_ATTEMPTS = 3;

type EpicRow = EpicDetail & { category_name: string | null; created_by: string };

// 削除していないエピックの、ダイアログが出す欄と、区分の名前（履歴に残す）。ワークスペースで必ず絞る
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string): Promise<EpicRow | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .leftJoin('categories', (join) =>
          join
            .onRef('categories.id', '=', 'epics.category_id')
            .onRef('categories.workspace_id', '=', 'epics.workspace_id'),
        )
        .select([
          'epics.id',
          'epics.title',
          'epics.body_md',
          'epics.due_on',
          'epics.link_url',
          'epics.category_id',
          'epics.created_by',
          'categories.name as category_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
}

function detailOf(row: EpicRow): EpicDetail {
  return {
    id: row.id,
    title: row.title,
    body_md: row.body_md,
    due_on: row.due_on,
    link_url: row.link_url,
    category_id: row.category_id,
  };
}

// 削除のボタンと確認のために、呼んだ人が削除できるか（作った人かリーダー。管理者を含む）、まとめて削除できるかと、配下の件数も返す
export const epicGetOperation = implement(epicGet, async ({ db, actor, workspace, input }) => {
  const epic = await readEpic(db, workspace.workspaceId, input.epic_id);
  if (epic === undefined) throw new ApiError(404, 'not_found');
  return { epic: detailOf(epic), ...(await epicDeletion(db, actor, workspace, epic)) };
});

export const epicCreateOperation = implement(epicCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 区分は、同じワークスペースの削除していない区分だけ。読んで名前を履歴に残し、書く文にも同じ条件を入れる
  const category = input.category_id === null ? null : await readCategoryRef(db, workspaceId, input.category_id);

  // 位置はエピックの末尾。完了と中止したエピックも並びに残っているので、それも含めた末尾に置く
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select('epics.position')
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null)
        .orderBy('epics.position', 'desc')
        .limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const epicId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const created: Record<string, [null, unknown]> = { title: [null, input.title] };
  for (const field of EDITABLE_FIELDS) {
    if (field !== 'title' && input[field] !== null) created[field] = [null, input[field]];
  }
  if (category !== null) created.category = [null, category];

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('epics')
        .columns([
          'id',
          'workspace_id',
          'title',
          'body_md',
          'due_on',
          'link_url',
          'category_id',
          'reward_tier',
          'requester_user_id',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(epicId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(input.title).as('title'),
              eb.val(input.body_md).as('body_md'),
              eb.val(input.due_on).as('due_on'),
              eb.val(input.link_url).as('link_url'),
              eb.val(category?.id ?? null).as('category_id'),
              eb.val(EPIC_DEFAULT_REWARD_TIER).as('reward_tier'),
              // 依頼主は作った人。変える操作は #65 で足す
              eb.val(actorUserId).as('requester_user_id'),
              eb.val(actorUserId).as('created_by'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId)))
            .$if(category !== null, (qb) =>
              qb.where((eb) => eb.exists(categoryRow(eb, workspaceId, category!.id).select('categories.id'))),
            ),
        ),
    ),
    // 作った行があるときだけ履歴を書く
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('epic').as('entity_type'),
              eb.val(epicId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('epics')
                  .select('epics.id')
                  .where('epics.id', '=', epicId)
                  .where('epics.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたか、区分が削除されたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return {
    epic: {
      id: epicId,
      title: input.title,
      body_md: input.body_md,
      due_on: input.due_on,
      link_url: input.link_url,
      category_id: category?.id ?? null,
    },
  };
});

// 書く欄。タイトルは空にできないので、欄ごとに型を分ける
type UpdatedFields = {
  title?: string;
  body_md?: string | null;
  due_on?: string | null;
  link_url?: string | null;
  category_id?: string | null;
};

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く。区分の履歴は {id, name} で残す
// （next は送られた区分の名前。区分を外すときと送られないときは null）
function diffOf(current: EpicRow, input: UpdatedFields, nextCategory: { id: string; name: string } | null) {
  const values: UpdatedFields = {};
  const changes: Record<string, [unknown, unknown]> = {};
  if (input.title !== undefined && input.title !== current.title) {
    values.title = input.title;
    changes.title = [current.title, input.title];
  }
  for (const field of ['body_md', 'due_on', 'link_url'] as const) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    values[field] = next;
    changes[field] = [current[field], next];
  }
  if (input.category_id !== undefined && input.category_id !== current.category_id) {
    values.category_id = input.category_id;
    changes.category = [refOf(current.category_id, current.category_name), nextCategory];
  }
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

// 書き方は story-update と同じ（src/server/operations/story.ts）。読んだ値からの差を、読んだ値のままなら、という条件つきで書き、
// 通らなかったら読み直して差を作り直す。履歴だけは、直前の UPDATE に結ぶ（previousStatementChanged）
export const epicUpdateOperation = implement(epicUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readEpic(db, workspaceId, epicId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    // 振る区分は、同じワークスペースの削除していない区分だけ（無ければ 404）。書く文にも同じ条件を入れる
    const nextCategory =
      input.category_id == null || input.category_id === current.category_id
        ? null
        : await readCategoryRef(db, workspaceId, input.category_id);
    const { values, changes, isEmpty } = diffOf(current, input, nextCategory);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { epic: detailOf(current) };
    }

    // 書き始める前の値が今と違う欄があれば、何も書かずに今の値を返す
    const stale = staleFields(current, values, input.expected);
    if (Object.keys(stale).length > 0) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'conflict', { reason: 'stale', current: stale });
    }

    const at = now();
    const updatedAt = at.toISOString();
    const mergeTarget = await readMergeTarget(db, workspaceId, epicId, actorUserId, changes, at);
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', epicId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // まとめる行が、読んだときのまま、かつ、まだこのエピックの最新の履歴の行（変わっていたら何も書かず、読み直してやり直す）
              ...(mergeTarget === undefined
                ? []
                : [
                    eb.exists(
                      q
                        .selectFrom('change_logs')
                        .select('change_logs.id')
                        .where('change_logs.id', '=', mergeTarget.id)
                        .where('change_logs.organization_id', '=', organizationId)
                        .where('change_logs.changes_json', '=', mergeTarget.changesJson),
                    ),
                    eb.not(
                      eb.exists(
                        q
                          .selectFrom('change_logs')
                          .select('change_logs.id')
                          .where('change_logs.organization_id', '=', organizationId)
                          .where('change_logs.entity_type', '=', 'epic')
                          .where('change_logs.entity_id', '=', epicId)
                          .where((newer) =>
                            newer.or([
                              newer('change_logs.created_at', '>', mergeTarget.createdAt),
                              newer.and([
                                newer('change_logs.created_at', '=', mergeTarget.createdAt),
                                newer('change_logs.id', '>', mergeTarget.id),
                              ]),
                            ]),
                          ),
                      ),
                    ),
                  ]),
              // 書く欄が、読んだときの値のまま
              ...(values.title === undefined ? [] : [eb('title', 'is', current.title)]),
              ...(values.body_md === undefined ? [] : [eb('body_md', 'is', current.body_md)]),
              ...(values.due_on === undefined ? [] : [eb('due_on', 'is', current.due_on)]),
              ...(values.link_url === undefined ? [] : [eb('link_url', 'is', current.link_url)]),
              ...(values.category_id === undefined ? [] : [eb('category_id', 'is', current.category_id)]),
              ...(nextCategory === null
                ? []
                : [eb.exists(categoryRow(q, workspaceId, nextCategory.id).select('categories.id'))]),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」）。
      // まとめる行があれば（同じ人が数分以内に同じ欄だけを続けて直した）、行を足さずにその行の「後」の値と時刻を書き換える（「前」は最初のまま）。
      // まとめる行が読んだときのままであることは、上の主文の条件に入れてあるので、主文が通った後のこの文は必ず当たる
      mergeTarget !== undefined
        ? db.statement((q) =>
            q
              .updateTable('change_logs')
              .set({
                changes_json: JSON.stringify({
                  [mergeTarget.field]: [mergeTarget.before, changes[mergeTarget.field]?.[1]],
                }),
                created_at: updatedAt,
              })
              .where('id', '=', mergeTarget.id)
              .where('organization_id', '=', organizationId)
              .where(previousStatementChanged),
          )
        : db.statement((q) =>
            q
              .insertInto('change_logs')
              .columns(changeLogColumns)
              .expression(
                q
                  .selectNoFrom((eb) => [
                    eb.val(uuidv7(at)).as('id'),
                    eb.val(organizationId).as('organization_id'),
                    eb.val(workspaceId).as('workspace_id'),
                    eb.val(actorUserId).as('actor_user_id'),
                    eb.val('epic').as('entity_type'),
                    eb.val(epicId).as('entity_id'),
                    eb.val('update').as('action'),
                    eb.val(JSON.stringify(changes)).as('changes_json'),
                    eb.val(updatedAt).as('created_at'),
                  ])
                  .where(previousStatementChanged),
              ),
          ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readEpic(db, workspaceId, epicId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { epic: detailOf(updated) };
    }
    // 閉じていれば 409 の workspace_closed。無ければ 404。区分が削除されていれば、次の周の読み取りが 404 にする。
    // どれでもなければ、別の要求が先に同じ欄を変えたので、読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readEpic(db, workspaceId, epicId)) === undefined) throw new ApiError(404, 'not_found');
  }
  throw new ApiError(409, 'conflict');
});

// 続けて直した分を1行にまとめる間（story-update と同じ。docs/data-model.md の「続けて直した分のまとめ」）
const HISTORY_MERGE_WINDOW_MS = 5 * 60 * 1000;
const MERGEABLE_FIELDS = EDITABLE_FIELDS;

// expected は入力の検証で正規化されて届く。正規化の決まりより前に保存された値とも比べられるよう、今の値も同じに正規化して比べる
function normalizedForCompare(field: (typeof MERGEABLE_FIELDS)[number], value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field === 'title') return value.trim();
  if (field === 'body_md') return normalizeLongText(value);
  if (field === 'link_url') {
    const link = normalizeLinkUrl(value);
    return link === null || linkUrlProblem(link) !== null ? link : canonicalLinkUrl(link);
  }
  // due_on は正規化の決まりが無い。欄を足したら、epicUpdate の expected と、ここの正規化の要否を決める（足し忘れは型で落ちる）
  field satisfies 'due_on';
  return value;
}

// 書き始める前の値（expected）が、サーバーの今の値と違う欄。書く欄だけを見る（送った値が今の値と同じなら、書かないので断らない）
function staleFields(current: EpicRow, values: UpdatedFields, expected: UpdatedFields | undefined) {
  const stale: Record<string, unknown> = {};
  if (expected === undefined) return stale;
  for (const field of MERGEABLE_FIELDS) {
    if (values[field] === undefined || expected[field] === undefined) continue;
    if (expected[field] !== normalizedForCompare(field, current[field])) stale[field] = current[field];
  }
  return stale;
}

type MergeTarget = {
  id: string;
  createdAt: string;
  changesJson: string;
  field: (typeof MERGEABLE_FIELDS)[number];
  before: unknown;
};

// 履歴を足す代わりに書き換える行。同じ人が、同じエピックで、同じ1つの欄だけを直した直前の行が、間の中にあるときだけ。
// 直前の行は、そのエピックの最新の履歴の行（間に別の履歴が挟まっていればまとめない）
async function readMergeTarget(
  db: OrganizationDb,
  workspaceId: string,
  epicId: string,
  actorUserId: string | null,
  changes: Record<string, [unknown, unknown]>,
  at: Date,
): Promise<MergeTarget | undefined> {
  const keys = Object.keys(changes);
  const field = MERGEABLE_FIELDS.find((name) => name === keys[0]);
  if (actorUserId === null || keys.length !== 1 || field === undefined) return undefined;
  const latest = await db.first(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['id', 'actor_user_id', 'action', 'changes_json', 'created_at'])
        .where('organization_id', '=', db.organizationId)
        .where('workspace_id', '=', workspaceId)
        .where('entity_type', '=', 'epic')
        .where('entity_id', '=', epicId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1),
    ),
  );
  if (latest === undefined || latest.action !== 'update' || latest.actor_user_id !== actorUserId) return undefined;
  // 間の起点は、行を最初に書いた時刻（ID の UUIDv7 の先頭48ビット）。ID が UUIDv7 でない行は、時刻と読めないのでまとめない
  const idHex = latest.id.replaceAll('-', '');
  if (idHex.length !== 32 || idHex[12] !== '7') return undefined;
  const firstWrittenAt = Number.parseInt(idHex.slice(0, 12), 16);
  const elapsed = at.getTime() - firstWrittenAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > HISTORY_MERGE_WINDOW_MS) return undefined;
  const latestAt = Date.parse(latest.created_at);
  if (Number.isNaN(latestAt) || at.getTime() < latestAt) return undefined;
  let logged: unknown;
  try {
    logged = JSON.parse(latest.changes_json);
  } catch {
    return undefined;
  }
  if (typeof logged !== 'object' || logged === null || Array.isArray(logged)) return undefined;
  const entries = Object.entries(logged);
  const pair = entries[0]?.[1];
  if (entries.length !== 1 || entries[0]?.[0] !== field || !Array.isArray(pair) || pair.length !== 2) return undefined;
  // 今の値と、履歴の「後」が合っているときだけ（合わなければ、間に別の経路が書いている）
  if (JSON.stringify(pair[1]) !== JSON.stringify(changes[field]?.[0])) return undefined;
  // 元の値へ戻す変更は、まとめると「前」と「後」が同じ行が残るので、まとめずに別の行にする
  if (JSON.stringify(pair[0]) === JSON.stringify(changes[field]?.[1])) return undefined;
  return { id: latest.id, createdAt: latest.created_at, changesJson: latest.changes_json, field, before: pair[0] };
}

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// 並べる範囲（ワークスペースの削除していないエピック。完了と中止したエピックも含む）から、移すエピックを除いたもの
function siblingEpics(from: From, workspaceId: string, epicId: string) {
  return from
    .selectFrom('epics')
    .where('epics.workspace_id', '=', workspaceId)
    .where('epics.deleted_at', 'is', null)
    .where('epics.id', '!=', epicId);
}

// 移すエピック。削除していないもの（完了と中止を含む）
function movingEpic(db: OrganizationDb, workspaceId: string, epicId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .select('epics.id')
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
}

// 移すエピックの新しい位置と、読んだ直前の行を決める。考え方はストーリーの移動（story.ts の planStoryMove）と同じ
async function planEpicMove(
  db: OrganizationDb,
  workspaceId: string,
  epicId: string,
  afterId: string | null | undefined,
): Promise<{ plan: MovePlan; after: Positioned | null }> {
  const columns = ['epics.id', 'epics.position'] as const;
  if (afterId === undefined) {
    const last = await db.first(
      db.statement((q) =>
        siblingEpics(q, workspaceId, epicId)
          .select(columns)
          .orderBy('epics.position', 'desc')
          .orderBy('epics.id', 'desc')
          .limit(1),
      ),
    );
    return { plan: placeLast(last), after: null };
  }
  if (afterId === null) {
    const first = await db.first(
      db.statement((q) =>
        siblingEpics(q, workspaceId, epicId).select(columns).orderBy('epics.position').orderBy('epics.id').limit(1),
      ),
    );
    return { plan: placeFirst(first), after: null };
  }
  const after = await db.first(
    db.statement((q) => siblingEpics(q, workspaceId, epicId).select(columns).where('epics.id', '=', afterId)),
  );
  if (after === undefined) throw new ApiError(404, 'not_found');
  const [ties, next] = await db.batch([
    db.statement((q) =>
      siblingEpics(q, workspaceId, epicId)
        .select(columns)
        .where('epics.position', '=', after.position)
        .where('epics.id', '>', after.id)
        .orderBy('epics.id')
        .limit(MAX_TIES + 1),
    ),
    db.statement((q) =>
      siblingEpics(q, workspaceId, epicId)
        .select(columns)
        .where('epics.position', '>', after.position)
        .orderBy('epics.position')
        .orderBy('epics.id')
        .limit(1),
    ),
  ] as const);
  return { plan: placeAfter(after, ties.rows, next.rows[0]), after };
}

// エピックを並べ替える。書き方はストーリーの移動（story.ts の storyMoveOperation）と同じで、直前の行が読んだ値の位置にあることを
// 書く文の条件にし、通らなければ 409 の conflict（changed）にする。親が無いので履歴は残さない
export const epicMoveOperation = implement(epicMove, async ({ db, workspace, input }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const afterId = input.after_epic_id;
  if (afterId === epicId) throw new ApiError(400, 'invalid_input');

  if ((await movingEpic(db, workspaceId, epicId)) === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const { plan, after } = await planEpicMove(db, workspaceId, epicId, afterId);

  const updatedAt = now().toISOString();
  // 自分の更新が通った、という条件。振り直しはこれを自分の条件に持つ
  const moved = (from: From) =>
    from
      .selectFrom('epics')
      .select('epics.id')
      .where('epics.id', '=', epicId)
      .where('epics.workspace_id', '=', workspaceId)
      .where('epics.position', '=', plan.position)
      .where('epics.updated_at', '=', updatedAt);

  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('epics')
        .set({ position: plan.position, updated_at: updatedAt })
        .where('id', '=', epicId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
        // 直前の行が、今も読んだ値の位置にある
        .$if(after !== null, (qb) =>
          qb.where((eb) =>
            eb.exists(
              siblingEpics(q, workspaceId, epicId)
                .select('epics.id')
                .where('epics.id', '=', after!.id)
                .where('epics.position', '=', after!.position),
            ),
          ),
        ),
    ),
    ...plan.renumber.map((row) =>
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ position: row.to, updated_at: updatedAt })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('position', '=', row.from)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(moved(q))),
      ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに、閉じたか、エピックか直前の行が消えたか、別の要求が先に直前の行を動かした
    await throwIfClosed(db, workspaceId);
    if ((await movingEpic(db, workspaceId, epicId)) === undefined) throw new ApiError(404, 'not_found');
    if (afterId != null) await planEpicMove(db, workspaceId, epicId, afterId);
    throw moveConflict('changed');
  }
  return { epic_id: epicId };
});
