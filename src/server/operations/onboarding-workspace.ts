import { now } from '../../shared/clock.ts';
import { onboardingWorkspacePrepare } from '../../shared/operations/workspace/onboarding-workspace-prepare.ts';
import { DEFAULT_ONBOARDING_WORKSPACE_NAME } from '../../shared/workspace.ts';
import { type Insertable, type OrganizationDb, type OrganizationTables } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { newWorkspaceRows } from './workspace-rows.ts';
import { actorUserIdOf } from './write-guards.ts';

function reusableWorkspace(db: OrganizationDb, userId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces as w')
        .innerJoin('memberships as m', 'm.workspace_id', 'w.id')
        .select('w.id')
        .where('w.organization_id', '=', db.organizationId)
        .where('w.closed_at', 'is', null)
        .where('m.user_id', '=', userId)
        .where('m.role', '=', 'leader')
        .where('m.left_at', 'is', null)
        .orderBy('w.name')
        .orderBy('w.id')
        .limit(1),
    ),
  );
}

// 先頭の workspaces だけが「まだ1つも無い」を判定する。後続はこの要求のIDの行が
// 実際に入った場合だけ書く。同じbatchなので、並行した要求の後続行が混ざらない。
function initialRow<T extends keyof OrganizationTables>(
  db: OrganizationDb,
  table: T,
  row: Insertable<OrganizationTables[T]>,
  workspaceId: string,
  userId: string,
) {
  const entries = Object.entries(row).filter(
    (entry): entry is [string, string | number | null] => entry[1] !== undefined,
  );
  return db.statement((q) =>
    q
      .insertInto(table)
      .columns(entries.map(([column]) => column) as never)
      .expression(
        q
          .selectNoFrom((eb) => entries.map(([column, value]) => eb.val(value).as(column)))
          .where((eb) =>
            table === 'workspaces'
              ? eb.and([
                  eb.not(
                    eb.exists(
                      eb.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId),
                    ),
                  ),
                  eb.exists(
                    eb
                      .selectFrom('users')
                      .select('id')
                      .where('organization_id', '=', db.organizationId)
                      .where('id', '=', userId)
                      .where('is_admin', '=', 1)
                      .where('disabled_at', 'is', null)
                      .where('login_subject', 'is not', null),
                  ),
                ])
              : eb.exists(
                  eb
                    .selectFrom('workspaces')
                    .select('id')
                    .where('organization_id', '=', db.organizationId)
                    .where('id', '=', workspaceId),
                ),
          ),
      ),
  );
}

export const onboardingWorkspacePrepareOperation = implement(
  onboardingWorkspacePrepare,
  async ({ db, actor, organization, input }) => {
    if (organization.kind !== 'team') throw new ApiError(409, 'conflict');
    const userId = actorUserIdOf(actor);
    const existing = await reusableWorkspace(db, userId);
    if (existing) return { workspace_id: existing.id };
    const leader = await db.first(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select(['id', 'name'])
          .where('organization_id', '=', db.organizationId)
          .where('id', '=', userId)
          .where('is_admin', '=', 1)
          .where('disabled_at', 'is', null)
          .where('login_subject', 'is not', null),
      ),
    );
    if (!leader) throw new ApiError(404, 'not_found');
    const rows = newWorkspaceRows({
      at: now(),
      organizationId: db.organizationId,
      actorUserId: userId,
      leader,
      name: DEFAULT_ONBOARDING_WORKSPACE_NAME,
      timezone: input.timezone,
    });
    try {
      await db.batch([
        initialRow(db, 'workspaces', rows.workspace, rows.workspaceId, userId),
        initialRow(db, 'workspace_point_rates', rows.rate, rows.workspaceId, userId),
        ...rows.columns.map((row) => initialRow(db, 'board_columns', row, rows.workspaceId, userId)),
        initialRow(db, 'detail_fields', rows.detailField, rows.workspaceId, userId),
        initialRow(db, 'memberships', rows.membership, rows.workspaceId, userId),
        ...rows.logs.map((row) => initialRow(db, 'change_logs', row, rows.workspaceId, userId)),
      ]);
    } catch (error) {
      // D1への書き込み後に応答だけ失った場合も、再読で成功を確認できる。
      const committed = await reusableWorkspace(db, userId);
      if (committed) return { workspace_id: committed.id };
      throw error;
    }
    const prepared = await reusableWorkspace(db, userId);
    if (prepared) return { workspace_id: prepared.id };
    throw new ApiError(409, 'conflict');
  },
);
