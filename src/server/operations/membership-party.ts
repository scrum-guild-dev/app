// 離脱・無効化の batch に足す討伐隊の後始末。時刻が同じ競合でも、この要求だけの所属・ユーザーの履歴があるときだけ書く。
import { uuidv7Sql, type OrganizationDb, type OrganizationTables, type QueryCreator } from '../db/index.ts';
import { changeLogColumns } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

export function removeDepartedPartyMemberStatements(
  db: OrganizationDb,
  params: { userId: string; actorUserId: string; workspaceId?: string; successLogId: string; at: Date },
) {
  const { userId, actorUserId, workspaceId, successLogId, at } = params;
  const organizationId = db.organizationId;
  // epic_party_members は workspace_id を持たない。必ず組織で絞ったワークスペースを経由する。
  // 完了・中止・削除済みのエピックと閉じたワークスペースも含め、払った報酬と依頼主は変えない。
  const epics = (q: From) => {
    let query = q
      .selectFrom('epics as e')
      .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
      .where('w.organization_id', '=', organizationId);
    if (workspaceId !== undefined) query = query.where('e.workspace_id', '=', workspaceId);
    return query;
  };
  const succeeded = (q: From) =>
    q
      .selectFrom('change_logs as success')
      .select('success.id')
      .where('success.id', '=', successLogId)
      .where('success.organization_id', '=', organizationId);

  return [
    // 消す前に、エピックごとにそのときの名前と入り方を残す（#266 の party_member と同じ形）。
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          epics(q)
            .innerJoin('epic_party_members as p', 'p.epic_id', 'e.id')
            .innerJoin('users as u', 'u.id', 'p.user_id')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.ref('e.workspace_id').as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('epic').as('entity_type'),
              eb.ref('e.id').as('entity_id'),
              eb.val('update').as('action'),
              eb
                .fn<string>('json_object', [
                  eb.val('party_member'),
                  eb.fn('json_array', [
                    eb.fn('json_object', [
                      eb.val('id'),
                      'u.id',
                      eb.val('name'),
                      'u.name',
                      eb.val('via'),
                      'p.joined_via',
                    ]),
                    eb.lit(null),
                  ]),
                ])
                .as('changes_json'),
              eb.val(at.toISOString()).as('created_at'),
            ])
            .where('p.user_id', '=', userId)
            .where('u.organization_id', '=', organizationId)
            .where((eb) => eb.exists(succeeded(q))),
        ),
    ),
    db.statement((q) =>
      q
        .deleteFrom('epic_party_members')
        .where('user_id', '=', userId)
        .where((eb) => eb.exists(epics(q).select('e.id').whereRef('e.id', '=', 'epic_party_members.epic_id')))
        .where((eb) => eb.exists(succeeded(q))),
    ),
  ];
}
