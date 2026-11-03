<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resolve } from '$app/paths';
  import { invalidate } from '$app/navigation';
  import { callOperation } from '../api.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { tokenNoticeSeen, tokenNotice } from '../../shared/operations/session/token-notice.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';

  let { notice, slug }: { notice: OutputOf<typeof tokenNotice> | null; slug: string } = $props();
  let acknowledged = $state<string | null>(null);
  let saving = $state(false);
  let failed = $state(false);
  let retrying = $state(false);
  let active = true;
  onDestroy(() => {
    active = false;
  });

  const latest = $derived(notice?.latest ?? null);
  const visible = $derived(latest !== null && (acknowledged === null || latest.created_at > acknowledged));

  async function confirm(): Promise<void> {
    if (saving || latest === null) return;
    const shownAt = latest.created_at;
    saving = true;
    failed = false;
    const result = await callOperation(tokenNoticeSeen, { created_at: shownAt });
    if (!active) return;
    saving = false;
    if (result.ok) {
      acknowledged = shownAt;
      // 表示した後に増えた発行まで隠さない。最新の読み取りは再び帯を出せる。
      await invalidate('app:token-notice');
    } else failed = true;
  }

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await invalidate('app:token-notice');
    } finally {
      if (active) retrying = false;
    }
  }
</script>

{#if notice === null}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body"><p>{t('tokenNoticeLoadFailed')}</p></div>
    <div class="token-notice-actions">
      <button class="btn" type="button" aria-disabled={retrying} onclick={retry}>{t('retry')}</button>
    </div>
  </section>
{:else if visible && latest !== null}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body">
      <p class="token-notice-title">{t('tokenNoticeTitle', { count: notice.count })}</p>
      <p>
        {t('tokenNoticeLatest', {
          name: latest.name,
          scope: t(latest.scope === 'read' ? 'apiTokenScopeRead' : 'apiTokenScopeWrite'),
        })}
        / <time class="mono" datetime={latest.created_at}>{formatDateTime(latest.created_at)}</time>
        {#if latest.revoked}
          / {t('tokenNoticeRevoked')}{/if}
      </p>
      <p>{t('tokenNoticeHint')}</p>
      {#if failed}<p class="field-error" role="alert">{t('tokenNoticeSeenFailed')}</p>{/if}
      <span class="visually-hidden" role="status">{saving ? t('tokenNoticeSaving') : ''}</span>
    </div>
    <div class="token-notice-actions">
      <a class="btn" href={resolve('/[slug]/me#api-tokens', { slug })}>{t('tokenNoticeSettings')}</a>
      <button class="btn" type="button" aria-disabled={saving} onclick={confirm}>{t('tokenNoticeSeen')}</button>
    </div>
  </section>
{/if}
