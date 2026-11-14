// 運用者の組織の契約の変更（docs/data-model.md の「書き込みの単位」の契約の変更）。
// 共通の DB の organization_contracts と organizations を1回の batch() で書き（どちらも共通の表）、続けて組織の DB の change_logs に
// 運用者の操作として残す。2つの DB への書き込みは別の batch() で書く。履歴を書けなくても成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import { isPurgeDue, organizationPlanUpdate, utcDateOf } from '../../shared/operations/operator/index.ts';
import { contractLimits } from '../../shared/organization-plan.ts';
import { commonDb, purgeDueInDatabase, purgeNotDue, type CommonTables, type ExpressionBuilder } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { logOperatorChange } from './operator-change-log.ts';
import { contractOf } from './organization-contract.ts';

type CommonDb = ReturnType<typeof commonDb>;

// slug の組織と、その契約（無ければ null）。組織が無ければ 404（別の組織と存在しないものを分けない）。
// purge_on は organizations だけが持つ列なので、purgeDueInDatabase の式は結合した文でも organizations の列を指す
async function readOrganizationWithContract(db: CommonDb, slug: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('organizations')
        .leftJoin('organization_contracts', 'organization_contracts.organization_id', 'organizations.id')
        .select([
          'organizations.id',
          'organizations.kind',
          'organizations.member_limit',
          'organizations.attachment_quota_bytes',
          'organizations.attachment_quota_warned_at',
          'organizations.trial_ends_on',
          'organizations.suspended_at',
          'organizations.purge_on',
          purgeDueInDatabase().as('due_in_database'),
          'organization_contracts.plan',
          'organization_contracts.billing_interval',
          'organization_contracts.extra_10gb_units',
          'organization_contracts.extra_50gb_units',
        ])
        .where('organizations.slug', '=', slug),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return { ...row, contract: contractOf(row) };
}

// 順: 1. 組織を slug で引く（無ければ 404）。解約で消す予定日を過ぎた組織（Worker の now() の UTC の日付か、D1 の date('now') の
//    どちらかで purge_on が今日より前）は 409 の purge_due（消している途中で契約の行を足さないため。境目は再開と同じ）。
//    自分用は 409（プランはパーソナルに固定）。今の契約が送った値と同じなら何も書かずに返す
// 2. 今の契約が画面の見ていた前の契約（expected。未契約なら null）と違えば 409（確認を開いた後に別の運用者が変えた）
// 3. 共通の DB に1回の batch() で書く
//    - 契約: 未契約なら行を足し（同時に足した別の運用者が先なら何も足さない）、契約があれば読んだ契約（プラン、支払いの周期、
//      追加容量の口数）のままであることを条件に書き換える。どちらも、組織が読んだときの上限のままで、消す予定日を過ぎた解約の停止で
//      ないことを条件にする。追加容量の口数は変えない
//    - organizations: 人数と添付ファイルの上限を契約から決まる値にし、お試しの期限を空にする（有料のプランにしたらお試しを終える）。
//      この batch() が書いた契約の行（プラン、支払いの周期、更新日時がこの値）があるときだけ書く。契約が書けずに 409 で返すときに、
//      上限だけが変わらないようにするため。添付ファイルの上限を上げたら、容量の通知の日時を空に戻す（80% の通知をやり直す）
// 4. 契約が書けていなければ（読んだ後に別の運用者が先に変えた）409
// 5. 組織の DB の change_logs に、契約の組と変わった列の前後の値で残す（失敗しても成功として返す）
export const organizationPlanUpdateOperation = implement(organizationPlanUpdate, async ({ db, operator, input }) => {
  const at = now();
  const current = await readOrganizationWithContract(db, input.slug);
  const due =
    current.suspended_at !== null && (isPurgeDue(current.purge_on, at) || Number(current.due_in_database) === 1);
  if (due) throw new ApiError(409, 'purge_due');
  if (current.kind === 'personal') throw new ApiError(409, 'conflict', { reason: 'personal_organization' });
  const { contract } = current;
  if (contract !== null && contract.plan === input.plan && contract.billing_interval === input.billing_interval) {
    return {
      slug: input.slug,
      contract,
      member_limit: current.member_limit,
      attachment_quota_bytes: current.attachment_quota_bytes,
      trial_ends_on: current.trial_ends_on,
    };
  }
  const { expected } = input;
  const matchesExpected =
    expected === null
      ? contract === null
      : contract !== null && contract.plan === expected.plan && contract.billing_interval === expected.billing_interval;
  if (!matchesExpected) throw new ApiError(409, 'conflict');

  const next = {
    plan: input.plan,
    billing_interval: input.billing_interval,
    extra_10gb_units: contract?.extra_10gb_units ?? 0,
    extra_50gb_units: contract?.extra_50gb_units ?? 0,
  };
  const limits = contractLimits(next);
  const raised = limits.attachment_quota_bytes > current.attachment_quota_bytes;
  const stamp = at.toISOString();
  const today = utcDateOf(at);
  // 契約を書く文の条件。組織が、読んだときの上限のままで、消す予定日を過ぎた解約の停止でないこと。
  // 読んだ後に別の運用者が上限を値で変えていたら書かない（履歴の前の値と、通知の日時を戻すかの判断を、読んだ値で決めているため）。
  // 読んだ後に日付が変わっても、消している途中の組織には足さない
  const organizationAsRead = (eb: ExpressionBuilder<CommonTables, 'organizations'>) =>
    eb.and([
      eb('organizations.id', '=', current.id),
      eb('organizations.member_limit', '=', current.member_limit),
      eb('organizations.attachment_quota_bytes', '=', current.attachment_quota_bytes),
      eb.or([eb('organizations.suspended_at', 'is', null), purgeNotDue(today)]),
    ]);

  const [written] = await db.batch([
    contract === null
      ? db.statement((q) =>
          q
            .insertInto('organization_contracts')
            .columns([
              'organization_id',
              'plan',
              'billing_interval',
              'extra_10gb_units',
              'extra_50gb_units',
              'created_at',
              'updated_at',
            ])
            .expression((eb) =>
              eb
                .selectFrom('organizations')
                .select([
                  'organizations.id',
                  eb.val(next.plan).as('plan'),
                  eb.val(next.billing_interval).as('billing_interval'),
                  eb.val(next.extra_10gb_units).as('extra_10gb_units'),
                  eb.val(next.extra_50gb_units).as('extra_50gb_units'),
                  eb.val(stamp).as('created_at'),
                  eb.val(stamp).as('updated_at'),
                ])
                .where(organizationAsRead),
            )
            .onConflict((oc) => oc.column('organization_id').doNothing()),
        )
      : db.statement((q) =>
          q
            .updateTable('organization_contracts')
            .set({ plan: next.plan, billing_interval: next.billing_interval, updated_at: stamp })
            .where('organization_id', '=', current.id)
            .where('plan', '=', contract.plan)
            .where('billing_interval', '=', contract.billing_interval)
            .where('extra_10gb_units', '=', contract.extra_10gb_units)
            .where('extra_50gb_units', '=', contract.extra_50gb_units)
            .where((eb) =>
              eb.exists(eb.selectFrom('organizations').select('organizations.id').where(organizationAsRead)),
            ),
        ),
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({
          member_limit: limits.member_limit,
          attachment_quota_bytes: limits.attachment_quota_bytes,
          trial_ends_on: null,
          ...(raised ? { attachment_quota_warned_at: null, attachment_quota_warning_pending_at: null } : {}),
          updated_at: stamp,
        })
        .where('id', '=', current.id)
        .where('kind', '=', 'team')
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('organization_contracts')
              .select('organization_contracts.organization_id')
              .where('organization_contracts.organization_id', '=', current.id)
              .where('organization_contracts.plan', '=', next.plan)
              .where('organization_contracts.billing_interval', '=', next.billing_interval)
              .where('organization_contracts.updated_at', '=', stamp),
          ),
        ),
    ),
  ]);
  if (written.changes === 0) throw new ApiError(409, 'conflict');

  // 契約のプランと支払いの周期は、片方だけが変わっても組で残す（履歴の文に前後の契約を出すため）。ほかは変わった列だけ
  const changes: Record<string, readonly [unknown, unknown]> = {
    plan: [contract?.plan ?? null, next.plan],
    billing_interval: [contract?.billing_interval ?? null, next.billing_interval],
  };
  if (current.member_limit !== limits.member_limit) changes.member_limit = [current.member_limit, limits.member_limit];
  if (current.attachment_quota_bytes !== limits.attachment_quota_bytes) {
    changes.attachment_quota_bytes = [current.attachment_quota_bytes, limits.attachment_quota_bytes];
  }
  if (current.trial_ends_on !== null) changes.trial_ends_on = [current.trial_ends_on, null];
  if (raised && current.attachment_quota_warned_at !== null) {
    changes.attachment_quota_warned_at = [current.attachment_quota_warned_at, null];
  }
  await logOperatorChange(operator, {
    operation: organizationPlanUpdate.name,
    organizationId: current.id,
    action: 'update',
    changes,
    at,
  });
  return {
    slug: input.slug,
    contract: next,
    member_limit: limits.member_limit,
    attachment_quota_bytes: limits.attachment_quota_bytes,
    trial_ends_on: null,
  };
});
