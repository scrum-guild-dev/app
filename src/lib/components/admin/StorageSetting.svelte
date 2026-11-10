<script lang="ts">
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { organizationInfo } from '../../../shared/operations/organization/index.ts';
  import { callOperation } from '../../api.ts';
  import { formatCount } from '../../format.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  type Storage = NonNullable<OutputOf<typeof organizationInfo>['storage']>;
  let { slug }: { slug: string } = $props();
  const currentSlug = $derived(slug);
  let storage = $state<Storage | null>(null);
  const section = new SectionLoad<Storage>(
    async () => {
      const result = await callOperation(organizationInfo, { include_storage: true }, { slug: currentSlug });
      if (!result.ok) return result;
      // 枠を読んだ後に管理者の権限を失っていたときも、枠に残った内訳を出さない。
      if (result.data.storage === null) return { ok: false, status: 404, error: null };
      return { ok: true, data: result.data.storage };
    },
    (data) => (storage = data),
  );
  // 枠の保持済みデータを使わず、管理画面へ入るたびと組織が替わるたびに読み直す。
  section.attach(
    () => currentSlug,
    () => (storage = null),
  );
  const ratio = $derived(storage === null ? 0 : storage.used_bytes / storage.quota_bytes);
  function usageText(bytes: number): string {
    if (bytes < 1024 ** 2) return t('storageByteSize', { size: formatCount(bytes) });
    // 上限の直前の9.99GBを10GBに丸め、満杯と見間違えないよう小数1桁で切り捨てる。
    const unit = bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
    return t(unit === 1024 ** 3 ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', {
      size: formatCount(Math.floor((bytes / unit) * 10) / 10),
    });
  }
</script>

<Setting title={t('storageTitle')} description={t('storageDescription', { workspace: t('workspace') })}>
  <SectionBoundary {section} failedTitle={t('storageLoadFailed')} refreshFailedText={t('storageRefreshFailed')}>
    {#if storage !== null}
      <div class="meter" class:is-warn={ratio > 0.8} class:is-full={ratio >= 1}>
        <div class="meter-top">
          <span class="meter-num"
            >{usageText(storage.used_bytes)} <small>/ {usageText(storage.quota_bytes)}</small></span
          >
          <span class="props-note">{t('storageExactBytes', { bytes: formatCount(storage.used_bytes) })}</span>
          {#if ratio >= 1}<span class="chip is-danger"><Icon name="alert" />{t('storageMeterFull')}</span>
          {:else if ratio > 0.8}<span class="chip is-warn"><Icon name="alert" />{t('storageMeterWarning')}</span>{/if}
        </div>
        <meter
          class="visually-hidden"
          min="0"
          max={storage.quota_bytes}
          value={Math.min(storage.used_bytes, storage.quota_bytes)}
          aria-label={t('storageTitle')}
        ></meter>
        <div class="meter-bar" aria-hidden="true"><span style:width={`${Math.min(100, ratio * 100)}%`}></span></div>
        <span class="props-note">{t('storageThresholdNote', { admin: t('admin') })}</span>
      </div>
      {#if ratio >= 1}
        <div class="callout is-danger">
          <Icon name="alert" /><span>{t('storageFull', { workspace: t('workspace'), leader: t('leader') })}</span>
        </div>
      {:else if ratio > 0.8}
        <div class="callout is-warn">
          <Icon name="alert" /><span>{t('storageWarning', { workspace: t('workspace'), leader: t('leader') })}</span>
        </div>
      {/if}
      <p class="field-hint">{t('storageRetention', { workspace: t('workspace') })}</p>
      <div class="table-wrap">
        <table class="table is-stacked">
          <thead><tr><th>{t('storageBreakdown')}</th><th class="is-num">{t('storageUsed')}</th></tr></thead>
          <tbody>
            <tr
              ><td class="is-name wrap-anywhere">{t('storageOrganizationWiki')}</td><td
                class="is-num"
                data-label={t('storageUsed')}>{usageText(storage.organization_wiki_bytes)}</td
              ></tr
            >
            {#each storage.workspaces as workspace (workspace.id)}
              <tr
                ><td class="is-name wrap-anywhere"
                  >{workspace.name}{#if workspace.closed_at !== null}
                    <span class="chip">{t('storageWorkspaceClosed')}</span>{/if}</td
                ><td class="is-num" data-label={t('storageUsed')}>{usageText(workspace.used_bytes)}</td></tr
              >
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </SectionBoundary>
</Setting>
