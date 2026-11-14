<script lang="ts">
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import type { organizationInfo } from '../../../shared/operations/organization/index.ts';
  import { formatCount, quotaSize } from '../../format.ts';
  import { planLabel } from '../../plan-terms.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Icon from '../Icon.svelte';

  // プランの節の中身（PlanSetting.svelte が読んだ plan を出す）。変える操作は持たない。
  // 変えるのは運用者（docs/requirements.md の「組織と運用者」）なので、問い合わせの案内を出す。自分用はプランが固定なので、容量を足す案内だけにする
  type Plan = NonNullable<OutputOf<typeof organizationInfo>['plan']>;
  let { plan, kind }: { plan: Plan; kind: 'team' | 'personal' } = $props();

  const contract = $derived(plan.contract);
  const extras = $derived(
    contract === null
      ? []
      : [
          { size: 10, units: contract.extra_10gb_units },
          { size: 50, units: contract.extra_50gb_units },
        ].filter((extra) => extra.units > 0),
  );
  function sizeText(bytes: number): string {
    const quota = quotaSize(bytes);
    return t(quota.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: quota.size });
  }
</script>

<dl class="props">
  <div>
    <dt>{t('orgPlanTermsLabel')}</dt>
    <dd>
      {#if contract === null && kind === 'team'}<span class="chip">{t('operatorPlanNone')}</span>
      {:else}{planLabel({ kind, contract }, t)}{/if}
    </dd>
  </div>
  {#if contract !== null}
    <div>
      <dt>{t('orgPlanExtraLabel')}</dt>
      <dd>
        {#if extras.length === 0}{t('orgPlanExtraNone')}
        {:else}{extras
            .map((extra) => t('orgPlanExtraUnits', { size: extra.size, units: formatCount(extra.units) }))
            .join('、')}{/if}
      </dd>
    </div>
  {/if}
  <div>
    <dt>{t('orgPlanMemberLimitLabel')}</dt>
    <dd>{t('orgPlanMemberLimit', { count: formatCount(plan.member_limit) })}</dd>
  </div>
  <div>
    <dt>{t('orgPlanQuotaLabel')}</dt>
    <dd>{sizeText(plan.attachment_quota_bytes)}</dd>
  </div>
</dl>
{#if kind === 'personal'}<p class="props-note">{t('orgPlanPersonalNote', { organization: t('organization') })}</p>
{:else if contract === null}<p class="props-note">{t('orgPlanNoneNote')}</p>{/if}
<div class="callout is-info">
  <Icon name="mail" /><span>{t(kind === 'personal' ? 'orgPlanContactPersonal' : 'orgPlanContact')}</span>
</div>
