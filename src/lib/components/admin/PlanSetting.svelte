<script lang="ts">
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { organizationInfo } from '../../../shared/operations/organization/index.ts';
  import { callOperation } from '../../api.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Setting from '../Setting.svelte';
  import PlanDetails from './PlanDetails.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  // プランの節（admin.html）。容量の節と同じく、組織の枠が持つ値を使わず、管理画面へ入るたびと組織が替わるたびに
  // organization を include_plan:true で読み直す（運用者が契約を変えた後に開き直すと、新しい契約が出る）。
  // 組織の種類は契約に関わらず変わらないので、枠の値を受け取る
  type Plan = NonNullable<OutputOf<typeof organizationInfo>['plan']>;
  let { slug, kind }: { slug: string; kind: 'team' | 'personal' } = $props();
  const currentSlug = $derived(slug);
  let plan = $state<Plan | null>(null);
  const section = new SectionLoad<Plan>(
    async () => {
      const result = await callOperation(organizationInfo, { include_plan: true }, { slug: currentSlug });
      if (!result.ok) return result;
      // 枠を読んだ後に管理者の権限を失っていたときも、契約を出さない
      if (result.data.plan === null) return { ok: false, status: 404, error: null };
      return { ok: true, data: result.data.plan };
    },
    (data) => (plan = data),
  );
  section.attach(
    () => currentSlug,
    () => (plan = null),
  );
</script>

<Setting title={t('orgPlanTitle')} description={t('orgPlanDesc')}>
  <SectionBoundary {section} failedTitle={t('orgPlanLoadFailed')} refreshFailedText={t('orgPlanRefreshFailed')}>
    {#if plan !== null}<PlanDetails {plan} {kind} />{/if}
  </SectionBoundary>
</Setting>
