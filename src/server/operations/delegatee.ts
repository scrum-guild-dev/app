import { DELEGATEES_PER_ORGANIZATION } from '../../shared/operations/organization/delegatee.ts';
import { now } from '../../shared/clock.ts';
import {
  delegateeCreate,
  delegateeDelete,
  delegateeList,
  delegateeUpdate,
} from '../../shared/operations/organization/index.ts';
import {
  previousStatementChanged,
  uuidv7Sql,
  type OrganizationDb,
  type OrganizationSummary,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns } from './write-guards.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// 書き込みだけを自分用に限る。読み取りは組織の種類で断らない。
export function assertPersonalOrganization(organization: OrganizationSummary): void {
  if (organization.kind !== 'personal') throw new ApiError(409, 'conflict', { reason: 'team_organization' });
}

export function liveDelegatees(from: From, organizationId: string) {
  return from.selectFrom('delegatees').where('organization_id', '=', organizationId).where('deleted_at', 'is', null);
}

function sameName(from: From, organizationId: string, name: string, exceptId: string | null = null) {
  return liveDelegatees(from, organizationId)
    .select('id')
    .where('name', '=', name)
    .$if(exceptId !== null, (qb) => qb.where('id', '!=', exceptId!));
}

function rosterLog(
  db: OrganizationDb,
  params: { id: string; actorUserId: string; delegateeId: string; action: string; changes: unknown; at: Date },
) {
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(params.id).as('id'),
            eb.val(db.organizationId).as('organization_id'),
            eb.val(null).as('workspace_id'),
            eb.val(params.actorUserId).as('actor_user_id'),
            eb.val('delegatee').as('entity_type'),
            eb.val(params.delegateeId).as('entity_id'),
            eb.val(params.action).as('action'),
            eb.val(JSON.stringify(params.changes)).as('changes_json'),
            eb.val(params.at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

export const delegateeListOperation = implement(delegateeList, async ({ db }) => ({
  delegatees: await db.rows(
    db.statement((q) =>
      liveDelegatees(q, db.organizationId)
        .select(['id', 'name'])
        .orderBy('name')
        .orderBy('id')
        .limit(DELEGATEES_PER_ORGANIZATION),
    ),
  ),
}));

export const delegateeCreateOperation = implement(delegateeCreate, async ({ db, actor, organization, input }) => {
  assertPersonalOrganization(organization);
  const actorUserId = actorUserIdOf(actor);
  const at = now();
  const id = uuidv7(at);
  const stamp = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('delegatees')
        .columns(['id', 'organization_id', 'name', 'created_at', 'updated_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(id).as('id'),
              eb.val(db.organizationId).as('organization_id'),
              eb.val(input.name).as('name'),
              eb.val(stamp).as('created_at'),
              eb.val(stamp).as('updated_at'),
            ])
            .where((eb) => eb.not(eb.exists(sameName(q, db.organizationId, input.name))))
            .where((eb) =>
              eb(
                liveDelegatees(q, db.organizationId).select(eb.fn.countAll<number>().as('count')),
                '<',
                DELEGATEES_PER_ORGANIZATION,
              ),
            ),
        ),
    ),
    rosterLog(db, {
      id: uuidv7(at),
      actorUserId,
      delegateeId: id,
      action: 'create',
      changes: { name: [null, input.name] },
      at,
    }),
  ]);
  if ((results[0]?.changes ?? 0) === 0) {
    const duplicate = await db.first(db.statement((q) => sameName(q, db.organizationId, input.name)));
    throw new ApiError(409, 'conflict', { reason: duplicate === undefined ? 'limit' : 'duplicate_name' });
  }
  return { delegatee: { id, name: input.name } };
});

export const delegateeUpdateOperation = implement(delegateeUpdate, async ({ db, actor, organization, input }) => {
  assertPersonalOrganization(organization);
  const actorUserId = actorUserIdOf(actor);
  const id = input.delegatee_id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await db.first(
      db.statement((q) => liveDelegatees(q, db.organizationId).select(['id', 'name']).where('id', '=', id)),
    );
    if (current === undefined) throw new ApiError(404, 'not_found');
    if (current.name === input.name) return { delegatee: current };
    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('delegatees')
          .set({ name: input.name, updated_at: at.toISOString() })
          .where('id', '=', id)
          .where('organization_id', '=', db.organizationId)
          .where('deleted_at', 'is', null)
          .where('name', '=', current.name)
          .where((eb) => eb.not(eb.exists(sameName(q, db.organizationId, input.name, id)))),
      ),
      rosterLog(db, {
        id: uuidv7(at),
        actorUserId,
        delegateeId: id,
        action: 'update',
        changes: { name: [current.name, input.name] },
        at,
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { delegatee: { id, name: input.name } };
    if ((await db.first(db.statement((q) => sameName(q, db.organizationId, input.name, id)))) !== undefined) {
      throw new ApiError(409, 'conflict', { reason: 'duplicate_name' });
    }
  }
  throw new ApiError(409, 'conflict');
});

// 対象の数によらず4文。完了したタスクは残し、未完了なら削除済み・閉じたワークスペースも外す。
// この要求が書いた名簿の履歴の ID で後続の文を条件づけ、同じ時計での再削除でも履歴を二重にしない。
export const delegateeDeleteOperation = implement(delegateeDelete, async ({ db, actor, organization, input }) => {
  assertPersonalOrganization(organization);
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const id = input.delegatee_id;
  const at = now();
  const stamp = at.toISOString();
  const logId = uuidv7(at);
  const deletedHere = (from: From) =>
    from.selectFrom('change_logs').select('id').where('id', '=', logId).where('organization_id', '=', organizationId);
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('delegatees')
        .set({ deleted_at: stamp, updated_at: stamp })
        .where('id', '=', id)
        .where('organization_id', '=', organizationId)
        .where('deleted_at', 'is', null),
    ),
    rosterLog(db, {
      id: logId,
      actorUserId,
      delegateeId: id,
      action: 'delete',
      changes: { deleted_at: [null, stamp] },
      at,
    }),
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('tasks as t')
            .innerJoin('workspaces as w', 'w.id', 't.workspace_id')
            .innerJoin('delegatees as d', 'd.id', 't.delegatee_id')
            .select((eb) => [
              uuidv7Sql(at).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.ref('t.workspace_id').as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.ref('t.id').as('entity_id'),
              eb.val('update').as('action'),
              eb
                .fn<string>('json_object', [
                  eb.val('delegatee'),
                  eb.fn('json_array', [
                    eb.fn('json_object', [eb.val('id'), eb.ref('d.id'), eb.val('name'), eb.ref('d.name')]),
                    eb.lit(null),
                  ]),
                ])
                .as('changes_json'),
              eb.val(stamp).as('created_at'),
            ])
            .where('w.organization_id', '=', organizationId)
            .where('d.organization_id', '=', organizationId)
            .where('t.delegatee_id', '=', id)
            .where('t.completed_at', 'is', null)
            .where((eb) => eb.exists(deletedHere(q))),
        ),
    ),
    db.statement((q) =>
      q
        .updateTable('tasks')
        .set({ delegatee_id: null, updated_at: stamp })
        .where('delegatee_id', '=', id)
        .where('completed_at', 'is', null)
        .where((eb) =>
          eb.and([
            eb.exists(
              eb
                .selectFrom('workspaces')
                .select('id')
                .whereRef('workspaces.id', '=', 'tasks.workspace_id')
                .where('organization_id', '=', organizationId),
            ),
            eb.exists(deletedHere(q)),
          ]),
        ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) throw new ApiError(404, 'not_found');
  return { delegatee_id: id };
});
