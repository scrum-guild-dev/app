<script lang="ts">
  import type { z } from 'zod';
  import { organizationPlanUpdate, type organizationContract } from '../../shared/operations/operator/index.ts';
  import {
    billingIntervals,
    contractLimits,
    PLAN_LIMITS,
    teamPlans,
    type BillingInterval,
    type OrganizationPlan,
    type TeamPlan,
  } from '../../shared/organization-plan.ts';
  import { callOperation } from '../api.ts';
  import { invalidateAll } from '$app/navigation';
  import { formatCount, quotaSize } from '../format.ts';
  import { isUnauthenticated } from '../login-redirect.ts';
  import { planLabel } from '../plan-terms.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // チーム用の組織の契約（プランと支払いの周期）を変えるダイアログ（design/kit.js の changePlan）。運用の画面だけが使う。
  // 今の契約を選んだ状態で開く。未契約なら、今の人数の上限がビジネスの値以上ならビジネス、それ以外はチームを、月払いで選ぶ。
  // 今と同じ契約のままでは「変える」を押しても無視する（サーバーは何も書かずに今の値を返す）。
  // 開いたときの契約（未契約なら null）を expected に添えて送り、開いた後に別の運用者が変えていればサーバーが 409 で断る。
  // 変えた後の上限は契約から決まる（追加容量の口数は残す）。変えた後の上限を出し、今の人数が上限を超えるとき、今の合計が容量を超えるときは
  // 注意を出す。未契約の組織の上限（51人以上の個別の値など）より下がるときは、契約を付けると値で決め直せなくなることも注意する。
  // 契約を変えるときだけ、お試し中の組織にはお試しが終わることを添える。停止中の組織には停止したままであることを添える。
  // 上限を値で変えられなくなる注記は、未契約の組織にだけ出す（契約のある組織は、もう値で変えられない）。
  // 書かれたか分からない失敗（5xx、通信の切れ）は、変わっていることもあると伝え、閉じたときに一覧を読み直す。
  // 開いた後に消す予定日を過ぎた（409 の purge_due）ときは、閉じて呼び出し側に渡す。
  // 送っている間の扱いと、結果の渡し方（onfinish、generation）は OrganizationQuotaDialog と同じ
  type Outcome = 'done' | 'state_changed' | 'purge_due' | 'unavailable' | 'unauthenticated';
  type Contract = z.infer<typeof organizationContract>;
  type Target = {
    slug: string;
    name: string;
    contract: Contract | null;
    member_limit: number;
    attachment_quota_bytes: number;
    attachment_used_bytes: number;
    used: number;
    trial: boolean;
    suspended: boolean;
  };
  let { onfinish }: { onfinish: (outcome: Outcome) => void } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<Target | null>(null);
  let plan = $state<TeamPlan>('team');
  let interval = $state<BillingInterval>('monthly');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  // 書かれたか分からない失敗の後は、閉じたときに一覧を読み直す
  let reloadOnClose = false;
  let generation = 0;

  const ids = $props.id();
  const formId = `${ids}-form`;
  const planLabelId = `${ids}-plan`;
  const intervalLabelId = `${ids}-interval`;
  const unchangedHintId = `${ids}-unchanged`;

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });

  // 選び直したら、前の失敗の文は今の選択に当たらないので消す
  function choose(): void {
    submitError = null;
  }

  function sizeText(bytes: number): string {
    const quota = quotaSize(bytes);
    return t(quota.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: quota.size });
  }
  function usageText(bytes: number): string {
    return bytes < 1024 ** 2 ? t('storageByteSize', { size: formatCount(bytes) }) : sizeText(bytes);
  }

  const isTeamPlan = (value: OrganizationPlan): value is TeamPlan => (teamPlans as readonly string[]).includes(value);

  export function show(
    organization: {
      slug: string;
      name: string;
      contract: Contract | null;
      seats: { used: number; limit: number };
      attachment_quota_bytes: number;
      attachment_used_bytes: number;
      trial_ends_on: string | null;
      suspended_at: string | null;
    },
    trigger?: HTMLElement | null,
  ): void {
    generation++;
    target = {
      slug: organization.slug,
      name: organization.name,
      contract: organization.contract,
      member_limit: organization.seats.limit,
      attachment_quota_bytes: organization.attachment_quota_bytes,
      attachment_used_bytes: organization.attachment_used_bytes,
      used: organization.seats.used,
      trial: organization.trial_ends_on !== null,
      suspended: organization.suspended_at !== null,
    };
    const { contract } = organization;
    if (contract !== null && isTeamPlan(contract.plan)) {
      plan = contract.plan;
      interval = contract.billing_interval;
    } else {
      plan = organization.seats.limit >= PLAN_LIMITS.business.member_limit ? 'business' : 'team';
      interval = contract?.billing_interval ?? 'monthly';
    }
    reloadOnClose = false;
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  // 変えた後の上限。追加容量の口数は今の契約のまま
  const next = $derived(
    contractLimits({
      plan,
      extra_10gb_units: target?.contract?.extra_10gb_units ?? 0,
      extra_50gb_units: target?.contract?.extra_50gb_units ?? 0,
    }),
  );
  const unchanged = $derived(
    target !== null &&
      target.contract !== null &&
      target.contract.plan === plan &&
      target.contract.billing_interval === interval,
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (target === null || submitting || unchanged) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    try {
      const { contract } = target;
      const result = await callOperation(organizationPlanUpdate, {
        slug: target.slug,
        plan,
        billing_interval: interval,
        expected: contract === null ? null : { plan: contract.plan, billing_interval: contract.billing_interval },
      });
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('done');
      } else if (isUnauthenticated(result)) {
        onfinish('unauthenticated');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に変えられていた（自分用に変わることは無いが、同じく読み直した一覧を見てもらう）
        open = false;
        onfinish('state_changed');
      } else if (result.status === 409 && result.error?.code === 'purge_due') {
        // 開いた後に消す予定日を過ぎた。一覧を読み直すと、その行の操作が理由の注記に替わる
        open = false;
        onfinish('purge_due');
      } else if (result.status === 404 || result.status === 403) {
        open = false;
        onfinish('unavailable');
      } else if (result.status === 0 || result.status >= 500) {
        // 書けた後に応答だけが失われたこともある。閉じたら一覧を読み直す
        submitError = t('operatorPlanFailedUnknown');
        reloadOnClose = true;
      } else {
        submitError = t('operatorPlanFailed');
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('operatorChanging') : '');
  const text = $derived(
    target === null
      ? ''
      : t('operatorPlanText', {
          name: target.name,
          terms: planLabel({ kind: 'team', contract: target.contract }, t),
          used: target.used,
          limit: target.member_limit,
          quota: sizeText(target.attachment_quota_bytes),
          storage: usageText(target.attachment_used_bytes),
        }),
  );
  const planNames = $derived({ team: t('planTeam'), business: t('planBusiness') });
  const intervalNames = $derived({ monthly: t('billingMonthly'), yearly: t('billingYearly') });
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('operatorPlanTitle')}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <!-- 組織の名前は自由に付けられるので、長い名前や区切りのない名前でも折り返す -->
    <p class="wrap-anywhere">{text}</p>
    <div class="form-fields">
      <div class="field">
        <span class="field-label" id={planLabelId}>{t('operatorPlanChoices')}</span>
        <div class="choice-list" role="radiogroup" aria-labelledby={planLabelId}>
          {#each teamPlans as value (value)}
            <label class="choice">
              <input type="radio" name="{ids}-plan" {value} bind:group={plan} onchange={choose} />
              <div>
                <b>{planNames[value]}</b><span
                  >{t('operatorQuotaTierValue', {
                    members: PLAN_LIMITS[value].member_limit,
                    quota: sizeText(PLAN_LIMITS[value].attachment_quota_bytes),
                  })}</span
                >
              </div>
            </label>
          {/each}
        </div>
      </div>
      <div class="field">
        <span class="field-label" id={intervalLabelId}>{t('operatorPlanIntervalChoices')}</span>
        <div class="choice-list" role="radiogroup" aria-labelledby={intervalLabelId}>
          {#each billingIntervals as value (value)}
            <label class="choice">
              <input type="radio" name="{ids}-interval" {value} bind:group={interval} onchange={choose} />
              <div><b>{intervalNames[value]}</b></div>
            </label>
          {/each}
        </div>
      </div>
      {#if unchanged}
        <span class="field-hint" id={unchangedHintId}>{t('operatorPlanUnchangedHint')}</span>
      {:else}
        <p class="field-hint">
          {t('operatorPlanAfter', { members: next.member_limit, quota: sizeText(next.attachment_quota_bytes) })}
        </p>
      {/if}
      {#if target !== null && target.contract === null && (next.member_limit < target.member_limit || next.attachment_quota_bytes < target.attachment_quota_bytes)}
        <div class="callout is-warn">
          <Icon name="alert" /><span
            >{t('operatorPlanLimitsLower', {
              members: target.member_limit,
              quota: sizeText(target.attachment_quota_bytes),
            })}</span
          >
        </div>
      {/if}
      {#if target !== null && !unchanged && target.used > next.member_limit}
        <div class="callout is-warn">
          <Icon name="alert" /><span>{t('operatorPlanSeatsOver', { used: target.used, limit: next.member_limit })}</span
          >
        </div>
      {/if}
      {#if target !== null && !unchanged && next.attachment_quota_bytes < target.attachment_used_bytes}
        <div class="callout is-warn"><Icon name="alert" /><span>{t('operatorStorageBelowUsage')}</span></div>
      {/if}
      {#if target?.trial && !unchanged}
        <p class="field-hint">{t('operatorPlanTrialNote')}</p>
      {/if}
      {#if target?.suspended}
        <p class="field-hint">{t('operatorPlanSuspendedNote', { organization: t('organization') })}</p>
      {/if}
      {#if target?.contract === null}
        <p class="field-hint">{t('operatorPlanNote')}</p>
      {/if}
      <p class="field-hint">{t('operatorPlanHistoryNote', { organization: t('organization') })}</p>
    </div>
    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || unchanged}
      aria-describedby={unchanged ? unchangedHintId : undefined}
    >
      {submitting ? t('operatorChanging') : t('operatorChangeSubmit')}
    </button>
  {/snippet}
</Dialog>
