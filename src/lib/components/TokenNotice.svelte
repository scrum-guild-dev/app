<script lang="ts">
  import { onDestroy } from 'svelte';
  import { resolve } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { callOperation } from '../api.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { tokenNoticeSeen, tokenNotice } from '../../shared/operations/session/token-notice.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';

  type Notice = OutputOf<typeof tokenNotice>;
  let { notice, slug }: { notice: Notice | null; slug: string } = $props();
  // 初回と枠の再読込は load の結果を使う。通知だけの再読込は、その初期値に結んで別に持つ。
  let fetched = $state.raw<{ initial: Notice | null; data: Notice | null } | null>(null);
  const current = $derived(fetched !== null && fetched.initial === notice ? fetched.data : notice);
  let acknowledged = $state<string | null>(null);
  let saving = $state(false);
  let failed = $state(false);
  let retrying = $state(false);
  let active = true;
  let request = 0;
  let initialNavigation = true;
  onDestroy(() => {
    active = false;
    request++;
  });

  const latest = $derived(current?.latest ?? null);
  const visible = $derived(latest !== null && (acknowledged === null || latest.created_at > acknowledged));

  // 初回は load が読んだので重ねて取らない。組織内の経路移動では通知だけを読む。
  afterNavigate(({ from, to }) => {
    if (initialNavigation) {
      initialNavigation = false;
      return;
    }
    if (from?.url.pathname !== to?.url.pathname) void refresh();
  });

  async function refresh(beforeApply?: () => void): Promise<void> {
    const serial = ++request;
    const initial = notice;
    const result = await callOperation(tokenNotice, {});
    if (!active || serial !== request || notice !== initial) return;
    beforeApply?.();
    fetched = { initial, data: result.ok ? result.data : null };
  }

  async function confirm(): Promise<void> {
    if (saving || latest === null) return;
    const shownAt = latest.created_at;
    saving = true;
    failed = false;
    const result = await callOperation(tokenNoticeSeen, { created_at: shownAt });
    if (!active) return;
    if (result.ok) {
      await refresh();
      if (!active) return;
      acknowledged = shownAt;
    } else failed = true;
    saving = false;
  }

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await refresh();
    } finally {
      if (active) retrying = false;
    }
  }
</script>

{#if current === null}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body"><p>{t('tokenNoticeLoadFailed')}</p></div>
    <div class="token-notice-actions">
      <button class="btn" type="button" aria-disabled={retrying} onclick={retry}>{t('retry')}</button>
    </div>
  </section>
{:else if visible && latest !== null}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body">
      <p class="token-notice-title">{t('tokenNoticeTitle', { count: current.count })}</p>
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
