<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { callOperation } from '../api.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { shouldRefreshTokenNotice } from '../token-notice-navigation.ts';
  import { tokenNoticeSeen, tokenNotice } from '../../shared/operations/session/token-notice.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';

  type Notice = OutputOf<typeof tokenNotice>;
  type InitialNotice = Notice | null | Promise<Notice | null>;
  let { notice, slug }: { notice: InitialNotice; slug: string } = $props();
  // 初回と枠の再読込は load の結果を使う。通知だけの再読込は、その初期値に結んで別に持つ。
  let fetched = $state.raw<{ initial: InitialNotice; data: Notice | null } | null>(null);
  let resolved = $state.raw<{ initial: InitialNotice; data: Notice | null } | null>(null);
  const initialValue = $derived(
    notice instanceof Promise ? (resolved?.initial === notice ? resolved.data : undefined) : notice,
  );
  const current = $derived(fetched !== null && fetched.initial === notice ? fetched.data : initialValue);
  $effect(() => {
    const initial = notice;
    let active = true;
    if (initial instanceof Promise) {
      void initial.then((data) => {
        if (active) resolved = { initial, data };
      });
    }
    return () => {
      active = false;
    };
  });
  let acknowledged = $state<string | null>(null);
  let saving = $state(false);
  let failed = $state(false);
  let retrying = $state(false);
  let updateFailed = $state(false);
  let confirmButton = $state<HTMLButtonElement>();
  let active = true;
  let request = 0;
  let clearContentFocus: (() => void) | undefined;
  onDestroy(() => {
    active = false;
    request++;
    clearContentFocus?.();
  });

  const latest = $derived(current?.latest ?? null);
  const visible = $derived(latest !== null && (acknowledged === null || latest.created_at > acknowledged));

  // 初回と別の組織からの移動は load の結果を使う。同じ組織へ戻る再マウントも読み直す。
  afterNavigate(({ type, from, to }) => {
    if (
      shouldRefreshTokenNotice(
        { type, fromSlug: from?.params?.slug, fromPath: from?.url?.pathname, toPath: to?.url?.pathname },
        slug,
      )
    ) {
      void refresh();
    }
  });

  async function refresh(beforeApply?: () => void): Promise<void> {
    const serial = ++request;
    const initial = notice;
    const result = await callOperation(tokenNotice, {});
    if (!active || serial !== request || notice !== initial) return;
    beforeApply?.();
    if (result.ok) {
      fetched = { initial, data: result.data };
      updateFailed = false;
    } else {
      // 読めていた発行は消さない。確認の成功と、最新の知らせを読めたかは別に扱う。
      updateFailed = true;
    }
  }

  // 普段の本文をクリック可能なフォーカス先にしない。確認で移す間だけ属性を借り、離れたら戻す。
  function focusContent(): void {
    clearContentFocus?.();
    const content = document.getElementById('content');
    if (content === null || !content.isConnected) return;
    const previous = content.getAttribute('tabindex');
    const cleanup = () => {
      content.removeEventListener('blur', cleanup);
      // ほかの処理が属性を変えていたら、その値を保つ。
      if (content.getAttribute('tabindex') === '-1') {
        if (previous === null) content.removeAttribute('tabindex');
        else content.setAttribute('tabindex', previous);
      }
      if (clearContentFocus === cleanup) clearContentFocus = undefined;
    };
    clearContentFocus = cleanup;
    content.setAttribute('tabindex', '-1');
    content.addEventListener('blur', cleanup, { once: true });
    content.focus({ preventScroll: true });
    if (document.activeElement !== content) cleanup();
  }

  async function confirm(): Promise<void> {
    if (saving || latest === null) return;
    const shownAt = latest.created_at;
    saving = true;
    failed = false;
    const result = await callOperation(tokenNoticeSeen, { created_at: shownAt });
    if (!active) return;
    if (result.ok) {
      showToast(t('tokenNoticeSaved'), 'check');
      let restoreFocus = false;
      // 表示した後に増えた発行まで隠さない。枠や本文を読み直さず、通知だけを確かめ直す。
      await refresh(() => {
        restoreFocus = document.activeElement === confirmButton;
      });
      if (!active) return;
      // より新しい再取得が先行した場合も、今ボタンに残るフォーカスだけを対象にする。
      restoreFocus ||= document.activeElement === confirmButton;
      acknowledged = shownAt;
      saving = false;
      await tick();
      if (
        active &&
        restoreFocus &&
        !visible &&
        (document.activeElement === document.body || document.activeElement === confirmButton)
      ) {
        focusContent();
      }
    } else {
      saving = false;
      failed = true;
    }
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

{#if current === undefined}
  <div class="shell-notice" role="status">{t('tokenNoticeLabel')}: {t('loading')}</div>
{:else if current === null}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body"><p role="alert">{t('tokenNoticeLoadFailed')}</p></div>
    <div class="token-notice-actions">
      <button class="btn" type="button" aria-disabled={retrying} onclick={retry}
        >{t(retrying ? 'retrying' : 'retry')}</button
      >
    </div>
  </section>
{:else if visible || updateFailed}
  <section class="token-notice" aria-label={t('tokenNoticeLabel')}>
    <div class="token-notice-body">
      {#if visible && latest !== null}
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
      {/if}
      {#if updateFailed}<p class="field-error" role="alert">{t('tokenNoticeUpdateFailed')}</p>{/if}
      {#if failed}<p class="field-error" role="alert">{t('tokenNoticeSeenFailed')}</p>{/if}
      <span class="visually-hidden" role="status">{saving ? t('tokenNoticeSaving') : ''}</span>
    </div>
    <div class="token-notice-actions">
      <a class="btn" href={resolve('/[slug]/me#api-tokens', { slug })}>{t('tokenNoticeSettings')}</a>
      {#if visible}
        <button class="btn" type="button" bind:this={confirmButton} aria-disabled={saving} onclick={confirm}
          >{t(saving ? 'tokenNoticeSaving' : 'tokenNoticeSeen')}</button
        >
      {/if}
      {#if updateFailed}
        <button class="btn" type="button" aria-disabled={retrying} onclick={retry}
          >{t(retrying ? 'retrying' : 'retry')}</button
        >
      {/if}
    </div>
  </section>
{/if}
