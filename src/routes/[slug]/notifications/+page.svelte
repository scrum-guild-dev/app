<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { notificationList, notificationRead } from '../../../shared/operations/notification.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { callOperation } from '../../../lib/api.ts';
  import EmptyState from '../../../lib/components/EmptyState.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import { formatCount } from '../../../lib/format.ts';
  import { formatDateTime } from '../../../lib/format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  type Listing = OutputOf<typeof notificationList>;
  let rows = $state<Listing['notifications']>([]);
  let next = $state<Listing['next']>(null);
  let unreadCount = $state(0);
  let unreadOnly = $state(false);
  let loading = $state(true);
  let failed = $state(false);
  let moreFailed = $state(false);
  let reading = $state<string | null>(null);
  let readFailed = $state(false);
  let ended = $state(false);
  let endNote = $state<HTMLElement>();
  let generation = 0;
  const ids = $props.id();
  const slug = $derived(data.slug);
  const visible = $derived(unreadOnly ? rows.filter((row) => row.read_at === null) : rows);

  function login(result: Parameters<typeof isUnauthenticated>[0]): boolean {
    if (!isUnauthenticated(result)) return false;
    window.location.assign(loginUrl(page.url));
    return true;
  }

  async function load(more = false): Promise<void> {
    const token = generation;
    const before = more ? next : null;
    if (more && (loading || before === null)) return;
    loading = true;
    if (more) moreFailed = false;
    else failed = false;
    try {
      const result = await callOperation(
        notificationList,
        { unread_only: unreadOnly, ...(before === null ? {} : { before }) },
        { slug },
      );
      if (token !== generation || login(result)) return;
      if (!result.ok) {
        if (more) moreFailed = true;
        else failed = true;
        return;
      }
      const seen = new Set(more ? rows.map((row) => row.id) : []);
      rows = [...(more ? rows : []), ...result.data.notifications.filter((row) => !seen.has(row.id))];
      next = result.data.next;
      unreadCount = result.data.unread_count;
      ended = more && next === null;
      if (ended) {
        await tick();
        if (token === generation) endNote?.focus();
      }
    } finally {
      if (token === generation) loading = false;
    }
  }

  $effect(() => {
    void slug;
    void unreadOnly;
    generation++;
    rows = [];
    next = null;
    unreadCount = 0;
    reading = null;
    readFailed = false;
    ended = false;
    moreFailed = false;
    void load();
    return () => {
      generation++;
    };
  });

  async function read(id: string, source: HTMLElement): Promise<void> {
    if (reading !== null || loading) return;
    const token = generation;
    reading = id;
    readFailed = false;
    try {
      const result = await callOperation(notificationRead, { id }, { slug });
      if (token !== generation || login(result)) return;
      if (!result.ok) {
        readFailed = true;
        return;
      }
      // 保存を待つ間にほかの操作へ移っていたら、その人のフォーカスを保つ。
      const restoreFocus = document.activeElement === source;
      rows = rows.map((row) => (row.id === id ? { ...row, read_at: result.data.read_at } : row));
      unreadCount = Math.max(0, unreadCount - 1);
      // 押したボタンが消えるので、次の未読の操作、なければ見出しへ戻す。
      await tick();
      if (token === generation && restoreFocus) {
        (
          document.querySelector<HTMLElement>('[data-notification-read]') ??
          document.querySelector<HTMLElement>('#content h1')
        )?.focus();
      }
    } finally {
      if (token === generation) reading = null;
    }
  }

  function text(row: Listing['notifications'][number]): string {
    return row.kind === 'attachment_quota_warning'
      ? t('notificationQuotaWarning', {
          used: t('notificationBytes', { size: formatCount(row.payload.used_bytes) }),
          quota: t('notificationBytes', { size: formatCount(row.payload.quota_bytes) }),
        })
      : t('notificationUnknown');
  }
</script>

<svelte:head><title>{t('pageTitle', { page: t('pageNotifications'), app: t('appName') })}</title></svelte:head>

<PageHead
  title={t('pageNotifications')}
  tallies={[{ icon: 'bell', label: t('notificationUnread'), count: unreadCount }]}
  focusable
/>

<div class="toolbar">
  <div class="segmented" role="radiogroup" aria-label={t('notificationFilter')}>
    <label
      ><input type="radio" name="{ids}-filter" value={false} bind:group={unreadOnly} /><span
        >{t('notificationAll')}</span
      ></label
    >
    <label
      ><input type="radio" name="{ids}-filter" value={true} bind:group={unreadOnly} /><span
        >{t('notificationUnreadOnly')}</span
      ></label
    >
  </div>
</div>

<span class="visually-hidden" role="status"
  >{loading ? t('loading') : reading !== null ? t('notificationReading') : ''}</span
>
{#if failed || moreFailed}
  <div class="callout is-warn" role="alert">
    <Icon name="alert" /><span>{t('notificationLoadFailed')}</span>
    <button
      class="btn is-sm"
      type="button"
      aria-disabled={loading}
      onclick={() => {
        if (!loading) void load(moreFailed);
      }}>{t('retry')}</button
    >
  </div>
{/if}
{#if readFailed}<div class="callout is-warn" role="alert">
    <Icon name="alert" /><span>{t('notificationReadFailed')}</span>
  </div>{/if}

{#if visible.length > 0}
  <ul class="feed">
    {#each visible as row (row.id)}
      <li class:is-unread={row.read_at === null}>
        <span class="feed-icon"><Icon name={row.kind === 'attachment_quota_warning' ? 'clip' : 'bell'} /></span>
        <span class="feed-main">
          <span class="feed-text">{text(row)}</span>
          <span class="feed-at"
            >{formatDateTime(row.created_at)}{#if row.read_at === null}・{t('notificationUnread')}{/if}</span
          >
          {#if row.kind === 'attachment_quota_warning' && data.organization?.me.is_admin}
            <span
              ><a class="btn is-sm is-quiet" href={resolve('/[slug]/admin', { slug })}>{t('notificationOpenAdmin')}</a
              ></span
            >
          {/if}
        </span>
        {#if row.read_at === null}
          <button
            class="btn is-sm is-quiet"
            type="button"
            data-notification-read
            aria-disabled={reading !== null || loading}
            onclick={(event) => read(row.id, event.currentTarget)}>{t('notificationRead')}</button
          >
        {/if}
      </li>
    {/each}
  </ul>
{:else if !loading && !failed}
  <EmptyState icon="bell" title={t(unreadOnly ? 'notificationUnreadEmpty' : 'notificationEmpty')} />
{/if}

{#if next !== null}
  <div class="form-actions">
    <button
      class="btn is-sm"
      type="button"
      aria-disabled={loading || reading !== null}
      onclick={() => {
        if (reading === null) void load(true);
      }}>{loading ? t('loading') : t('notificationMore')}</button
    >
  </div>
{:else if ended}
  <p class="action-note" tabindex="-1" bind:this={endNote}>{t('notificationEnd')}</p>
{/if}
