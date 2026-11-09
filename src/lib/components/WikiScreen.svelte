<script module lang="ts">
  // 最上段への遷移はページ部品が替わるため、復旧要求は部品の外で保持する。
  let recovery = $state({
    failure: '',
    path: '',
    destination: null as string | null,
    busy: false,
    failed: false,
    pagesMissing: false,
  });
</script>

<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { beforeNavigate, goto, invalidate, refreshAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy, onMount, tick } from 'svelte';
  import { wikiClient } from '../wiki-client.ts';
  import type { WikiData } from '../wiki-load.ts';
  import type { WorkspaceView } from '../workspace.ts';
  import { organizationLabel } from '../organization-label.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import type { organizationInfo } from '../../shared/operations/organization/index.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { parseWikiFrontmatter, wikiBodyProblem, wikiTitle } from '../../shared/wiki.ts';
  import { focusPageHeading } from '../focus-heading.ts';
  import Icon from './Icon.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import WikiContent from './WikiContent.svelte';
  import PageHead from './PageHead.svelte';
  import FavoriteButton from './FavoriteButton.svelte';
  import WikiTree from './WikiTree.svelte';
  import WikiSearch from './WikiSearch.svelte';
  import WikiHistory from './WikiHistory.svelte';
  import WikiUploadDialog from './WikiUploadDialog.svelte';
  import { wikiDownloadName, wikiDownloadSource } from '../../shared/wiki-transfer.ts';
  import { showToast } from '../toast.svelte.ts';
  let uploadDialog = $state<ReturnType<typeof WikiUploadDialog>>();
  let uploadBusy = $state(false);
  let historyBusy = $state(false);
  let historyPage = $state<string | null>(null);

  let {
    data,
  }: {
    data: WikiData & { workspace?: WorkspaceView | null; organization: OutputOf<typeof organizationInfo> | null };
  } = $props();
  const slug = $derived(page.params.slug ?? '');
  const workspaceId = $derived(page.params.id ?? null);
  const wiki = $derived(wikiClient(slug, workspaceId));
  const name = $derived(
    workspaceId === null
      ? data.organization
        ? organizationLabel(data.organization.organization)
        : undefined
      : data.workspace?.name,
  );
  const current = $derived(data.wikiPage);
  let narrowWiki = $state(false);
  const currentPageId = $derived(current?.id ?? null);
  let pageListOpen = $derived(!narrowWiki || currentPageId === null);
  onMount(() => {
    // .layout-wiki が1列になる幅と揃える。広い幅へ戻したときは一覧を必ず開く。
    const query = window.matchMedia('(max-width: 1080px)');
    const update = () => {
      narrowWiki = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });
  const pages = $derived(data.wikiPages ?? []);
  let deletePending = $state(false);
  const scopedFailure = $derived(recovery.path === page.url.pathname ? recovery.failure : '');
  const deleteBlocked = $derived(deletePending || recovery.busy || Boolean(scopedFailure));
  let deleting = $state(false);
  let deletedPageId = $state<string | null>(null);
  let deleteTarget = $state<{ id: string; title: string; parent: string; children: number } | null>(null);
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();
  const canDelete = $derived(
    current !== null &&
      current.id !== deletedPageId &&
      !scopedFailure &&
      !recovery.busy &&
      data.organization !== null &&
      (workspaceId === null || (data.workspace != null && data.workspace.closedAt === null)) &&
      (data.organization.me.is_admin ||
        data.organization.me.id === current.created_by ||
        (workspaceId !== null && data.workspace?.role === 'leader')),
  );
  const canWrite = $derived(
    workspaceId === null
      ? data.organization !== null && data.wikiPages !== null
      : data.workspace != null && data.workspace.closedAt === null,
  );
  let wikiTree = $state<ReturnType<typeof WikiTree>>();
  let mode = $state<'read' | 'create' | 'edit'>('read');
  let parentId = $state<string | null>(null);
  let title = $state('');
  let body = $state('');
  let originalTitle = $state('');
  let originalBody = $state('');
  let version = $state(1);
  let saving = $state(false);
  let editGeneration = 0;
  let comparisonRequest = 0;
  let failure = $state('');
  let notice = $state('');
  let titleError = $state(false);
  let bodyError = $state(false);
  let conflict = $state(false);
  let comparison = $state<typeof data.wikiPage>(null);
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  const dirty = $derived(mode !== 'read' && (title !== originalTitle || body !== originalBody));
  const frontmatter = $derived(parseWikiFrontmatter(body));
  const ancestors = $derived.by(() => {
    const found: typeof pages = [];
    let id = current?.parent_id;
    const seen = new SvelteSet<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const ancestor = pages.find((item) => item.id === id);
      if (!ancestor) break;
      found.unshift(ancestor);
      id = ancestor.parent_id;
    }
    return found;
  });
  const depth = $derived(ancestors.length + 1);
  $effect(() => {
    // 移動が実際に完了してから消す。ほかのガードが移動を取り消しても理由を残す。
    if (!recovery.busy && recovery.path !== page.url.pathname) {
      recovery.failure = '';
      recovery.destination = null;
      recovery.path = page.url.pathname;
    }
  });
  $effect(() => {
    recovery.failed = data.wikiFailed;
    recovery.pagesMissing = data.wikiPages === null;
  });
  $effect(() => {
    if (historyPage !== null && historyPage !== current?.id) historyPage = null;
  });

  onDestroy(() => {
    // 削除後の内部遷移では引き継ぎ、それ以外で Wiki を離れたときは破棄する。
    if (!recovery.busy) {
      recovery.failure = '';
      recovery.destination = null;
      recovery.path = '';
    }
  });

  async function mayDiscard(): Promise<boolean> {
    if (saving || historyBusy || uploadBusy || deletePending || recovery.busy || scopedFailure) return false;
    return (
      !dirty ||
      ((await discardDialog?.ask(document.activeElement instanceof HTMLElement ? document.activeElement : null)) ??
        false)
    );
  }
  beforeNavigate((navigation) => {
    if (
      uploadBusy ||
      deletePending ||
      (recovery.busy &&
        (navigation.to?.url.origin !== page.url.origin || navigation.to.url.pathname !== recovery.destination))
    ) {
      navigation.cancel();
      return;
    }
    if (!dirty && !saving && !historyBusy) return;
    if (navigation.type === 'leave') {
      navigation.cancel();
      return;
    }
    navigation.cancel();
    const url = navigation.to?.url;
    if (url)
      void mayDiscard().then(async (yes) => {
        if (yes) {
          mode = 'read';
          // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した navigation.to の URL
          await goto(url);
        }
      });
  });
  async function begin(create: boolean, parent: string | null = null): Promise<void> {
    if (!canWrite || current?.id === deletedPageId || !(await mayDiscard())) return;
    historyPage = null;
    editGeneration += 1;
    parentId = parent;
    title = create ? '' : (current?.title ?? '');
    body = create ? '' : (current?.body_md ?? '');
    originalTitle = title;
    originalBody = body;
    version = current?.version ?? 1;
    mode = create ? 'create' : 'edit';
    failure = '';
    notice = '';
    conflict = false;
    comparison = null;
    titleError = false;
    bodyError = false;
    await tick();
    document.getElementById('wiki-title')?.focus();
  }
  async function cancel(): Promise<void> {
    if (await mayDiscard()) {
      editGeneration += 1;
      mode = 'read';
      failure = '';
    }
  }
  async function readLatest(): Promise<void> {
    if (saving || !current) return;
    const pageId = current.id;
    const generation = editGeneration;
    const request = ++comparisonRequest;
    const result = await wiki.readPage(current.id);
    if (mode !== 'edit' || current?.id !== pageId || editGeneration !== generation || request !== comparisonRequest)
      return;
    if (result.ok) {
      comparison = result.data.page;
      version = result.data.page.version;
    } else failure = t('wikiReadFailed');
  }
  async function save(): Promise<void> {
    if (saving) return;
    titleError = wikiTitle(title, body) === null;
    bodyError = wikiBodyProblem(body) !== null;
    if (titleError || bodyError) {
      await tick();
      document.getElementById(titleError ? 'wiki-title' : 'wiki-body')?.focus();
      return;
    }
    saving = true;
    failure = '';
    notice = '';
    try {
      const result =
        mode === 'create'
          ? await wiki.createPage({ title, body_md: body }, parentId)
          : await wiki.updatePage(current!.id, version, { title, body_md: body });
      if (result.ok) {
        const unchanged = mode === 'edit' && result.data.page.version === version;
        notice = t(unchanged ? 'wikiUnchanged' : 'wikiSaved');
        conflict = false;
        // 保存は確定済み。読み直しが失敗しても、同じフォームで再送しない。
        try {
          await invalidate('app:wiki');
        } catch {
          notice += ` ${t('wikiReadFailed')}`;
        }
        mode = 'read';
        saving = false;
        await goto(wiki.pageHref(result.data.page.id));
      } else {
        const code = result.error?.code;
        conflict = code === 'conflict' && mode === 'edit';
        failure = t(
          conflict
            ? 'wikiConflict'
            : code === 'workspace_closed'
              ? 'wikiClosed'
              : code === 'rate_limited'
                ? 'wikiRateLimited'
                : code === 'attachment_quota_exceeded'
                  ? 'wikiQuota'
                  : result.status === 404
                    ? 'wikiGone'
                    : code === 'conflict'
                      ? 'wikiDepth'
                      : 'wikiSaveFailed',
        );
      }
    } finally {
      saving = false;
    }
  }
  async function removePage(trigger: HTMLElement): Promise<void> {
    if (!canDelete || !current || deletePending || saving || historyBusy || uploadBusy) return;
    const target = current;
    const client = wiki;
    const destination = target.parent_id === null ? client.rootHref : client.pageHref(target.parent_id);
    deleteTarget = {
      id: target.id,
      title: target.title,
      parent: pages.find((item) => item.id === target.parent_id)?.title ?? t('wikiMoveRoot'),
      children: pages.filter((item) => item.parent_id === target.id).length,
    };
    recovery.failure = '';
    recovery.path = page.url.pathname;
    deletePending = true;
    try {
      if (!(await deleteDialog?.ask(trigger))) return;
      // 確認中に表示が変わっても、別のページを消さない。
      if (!canDelete || current?.id !== target.id || wiki.rootHref !== client.rootHref || mode !== 'read') return;
      deleting = true;
      const result = await client.deletePage(target.id, target.parent_id);
      if (!result.ok) {
        recovery.failure = t(
          result.status === 403
            ? 'wikiDeleteForbidden'
            : result.status === 404
              ? 'wikiDeleteGone'
              : result.error?.code === 'workspace_closed'
                ? 'wikiClosed'
                : result.error?.code === 'conflict'
                  ? 'wikiDeleteConflict'
                  : 'wikiDeleteFailed',
        );
        return;
      }
      // 削除は確定済み。読み直しが失敗しても、消したページから再送させない。
      deletedPageId = target.id;
      notice = t('wikiDeleted', { title: target.title });
      showToast(notice);
      recovery.destination = destination;
      deletePending = false;
      await recoverDeletion();
    } finally {
      deletePending = false;
      deleting = false;
      deleteTarget = null;
      if (recovery.failure) {
        await tick();
        const active = document.activeElement;
        if (active === document.body || active === trigger || active === null)
          document.getElementById('wiki-reload')?.focus();
      }
    }
  }
  async function recoverDeletion(): Promise<void> {
    if (recovery.busy || deletePending) return;
    const trigger = document.activeElement;
    recovery.busy = true;
    try {
      // 成功済みなら先に行き先へ移る。削除したURLを invalidate しない。
      if (recovery.destination !== null) {
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- wikiClient の resolve 済みの行き先
        await goto(recovery.destination, { refreshAll: true, replace: true });
      } else await refreshAll();
      // goto/refreshAll が load と画面の更新を待ち、tick で新しい部品の effect も反映する。
      // 最上段へ移った後、この関数の data は旧部品のものなので、表示中の部品が送る状態を見る。
      await tick();
      if (recovery.failed || recovery.pagesMissing) {
        recovery.failure = t(recovery.destination !== null ? 'wikiDeleteRefreshFailed' : 'wikiReloadFailed');
      } else {
        recovery.failure = '';
        recovery.destination = null;
      }
    } catch {
      recovery.failure = t(recovery.destination !== null ? 'wikiDeleteRefreshFailed' : 'wikiReloadFailed');
    } finally {
      recovery.path = page.url.pathname;
      recovery.busy = false;
      await tick();
      const active = document.activeElement;
      if (active === document.body || active === trigger || active === null) {
        if (recovery.failure) document.getElementById('wiki-reload')?.focus();
        else {
          const heading = document.getElementById('wiki-page-title');
          if (heading) heading.focus();
          else focusPageHeading();
        }
      }
    }
  }
  async function uploaded(count: number) {
    notice = t('wikiUploadDone', { count });
    try {
      await invalidate('app:wiki');
    } catch {
      notice += ` ${t('wikiReadFailed')}`;
    }
    showToast(notice);
  }
  async function refreshWiki() {
    try {
      await invalidate('app:wiki');
      await tick();
      return !data.wikiFailed && data.wikiPages !== null;
    } catch {
      showToast(t('wikiUploadRefreshFailed'));
      return false;
    }
  }
  function download() {
    if (!current) return;
    const source = wikiDownloadSource(current.title, current.body_md);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = wikiDownloadName(current.title);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const frontmatter = parseWikiFrontmatter(current.body_md);
    const messages = [];
    if (frontmatter.invalid) messages.push(t('wikiDownloadRaw'));
    else if (!frontmatter.title) messages.push(t('wikiDownloadAddedTitle'));
    if (wikiBodyProblem(source) === 'too_long') messages.push(t('wikiDownloadTooLong'));
    if (!frontmatter.invalid && parseWikiFrontmatter(source).invalid) messages.push(t('wikiDownloadMetadataLimit'));
    if (messages.length) {
      notice = messages.join(' ');
      showToast(notice);
    }
  }
</script>

<svelte:head
  ><title
    >{t('pageTitle', {
      page: name ? `${current?.title ?? t('wiki')}・${name}` : (current?.title ?? t('wiki')),
      app: t('appName'),
    })}</title
  ></svelte:head
>

<PageHead title={t('wiki')} eyebrow={name}>
  {#snippet actions()}{#if canWrite}{#if mode === 'read'}<button
          class="btn"
          type="button"
          aria-disabled={historyBusy || uploadBusy || deleteBlocked}
          onclick={(event) => {
            if (!historyBusy && !uploadBusy && !deleteBlocked)
              uploadDialog?.show(event.currentTarget, current?.id ?? null);
          }}>{t('wikiUpload')}</button
        >{/if}<button
        class="btn is-primary"
        type="button"
        aria-disabled={historyBusy || uploadBusy || deleteBlocked}
        onclick={() => begin(true)}>{t('wikiAdd')}</button
      >{/if}{/snippet}
  {#snippet meta()}{#if data.wikiPages !== null && !data.wikiNotFound && canWrite}<p class="props-note">
        {t(wiki.accessLabel)}
      </p>{/if}{/snippet}
</PageHead>
<p role="status" class={notice ? 'field-hint' : 'visually-hidden'}>{notice}</p>
{#if scopedFailure}
  <div class="callout is-warn" role="alert">
    <Icon name="alert" />
    <span>{scopedFailure}</span>
    <div class="callout-actions">
      <button
        id="wiki-reload"
        class="btn"
        type="button"
        aria-disabled={recovery.busy || deletePending}
        onclick={recoverDeletion}>{t('wikiReload')}</button
      >
    </div>
  </div>
{/if}
<p class="visually-hidden" role="status">{recovery.busy ? t('wikiReloading') : ''}</p>
{#if data.wikiFailed && mode === 'read'}
  {#if !scopedFailure}<LoadFailed inShell />{/if}
{:else}
  <div class="layout-wiki">
    <aside class="wiki-side">
      <!-- 狭い幅で閉じたときの toggle が幅変更後に届いても、広い幅の一覧を閉じない。 -->
      <details
        class="wiki-page-list"
        ontoggle={(event) => {
          if (!narrowWiki) event.currentTarget.open = true;
        }}
        bind:open={pageListOpen}
      >
        <summary>{t('wikiPageList')}</summary>
        <div class="wiki-list-content">
          {#if data.wikiPages !== null}{#key wiki.rootHref}<WikiSearch
                {slug}
                workspaceId={workspaceId || null}
                {pages}
                currentId={current?.id ?? null}
              >
                {#snippet children(searching)}
                  {#if pages.length}<WikiTree
                      bind:this={wikiTree}
                      {pages}
                      {wiki}
                      {searching}
                      canWrite={canWrite &&
                        !deleteBlocked &&
                        current?.id !== deletedPageId &&
                        mode === 'read' &&
                        !saving &&
                        !historyBusy &&
                        !uploadBusy}
                      currentId={current?.id ?? null}
                    />{:else}<p class="section-hint" hidden={searching}>
                      {t('wikiTreeEmpty')}
                    </p>{/if}
                {/snippet}
              </WikiSearch>{/key}{/if}
        </div>
      </details>
    </aside>
    <section class="wiki-main" aria-label={t('wikiPage')}>
      <nav class="crumbs" aria-label={t('wikiCrumbs')}>
        <ol>
          <li>
            <a href={wiki.rootHref}>{t('wiki')}</a>
          </li>
          {#each ancestors as ancestor (ancestor.id)}<li>
              <a href={wiki.pageHref(ancestor.id)}>{ancestor.title}</a>
            </li>{/each}
          {#if current}<li><span aria-current="page">{current.title}</span></li>{/if}
        </ol>
      </nav>
      {#if deleting}<p role="status">{t('wikiDeleting')}</p>{/if}
      {#if mode !== 'read'}
        <h2 class="section-title">{t(mode === 'create' ? 'wikiAdd' : 'wikiEdit')}</h2>
        {#if failure}<div class="callout is-warn" role="alert">
            <p>{failure}</p>
            {#if conflict}<button class="btn" type="button" onclick={readLatest}>{t('wikiReadLatest')}</button>{/if}
          </div>{/if}
        {#if comparison}<details>
            <summary>{t('wikiCompare', { version: comparison.version })}</summary>
            <h3>{comparison.title}</h3>
            <WikiContent source={comparison.body_md} />
          </details>{/if}
        <form
          class="form"
          onsubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="field">
            <label for="wiki-title">{t('wikiTitle')}</label>
            <input
              id="wiki-title"
              class="input"
              value={frontmatter.title ?? title}
              readonly={saving || frontmatter.title !== null}
              aria-invalid={titleError || undefined}
              aria-describedby={titleError ? 'wiki-title-error' : frontmatter.title ? 'wiki-title-hint' : undefined}
              oninput={(event) => {
                title = event.currentTarget.value;
                titleError = false;
              }}
            />
            {#if frontmatter.title}<p id="wiki-title-hint" class="field-hint">{t('wikiTitleFromBody')}</p>{/if}
            {#if titleError}<p id="wiki-title-error" class="field-error" role="alert">{t('wikiTitleInvalid')}</p>{/if}
          </div>
          <div class="field">
            <label for="wiki-body">{t('wikiBody')}</label>
            <textarea
              id="wiki-body"
              class="textarea"
              rows="20"
              readonly={saving}
              bind:value={body}
              aria-invalid={bodyError || undefined}
              aria-describedby={bodyError ? 'wiki-body-error' : 'wiki-body-hint'}
              oninput={() => {
                bodyError = false;
              }}></textarea>
            <p id="wiki-body-hint" class="field-hint">{t('wikiBodyHint')}</p>
            {#if bodyError}<p id="wiki-body-error" class="field-error" role="alert">{t('wikiBodyInvalid')}</p>{/if}
          </div>
          {#if mode === 'edit'}<p class="field-hint">{t('wikiVersionHint', { version })}</p>{/if}
          <details><summary>{t('wikiPreview')}</summary><WikiContent source={body} /></details>
          <div class="form-actions">
            <button class="btn is-primary" type="submit" aria-disabled={saving}
              >{t(saving ? 'wikiSaving' : 'wikiSave')}</button
            ><button class="btn" type="button" aria-disabled={saving} onclick={cancel}>{t('cancel')}</button>
          </div>
          <span role="status">{saving ? t('wikiSaving') : ''}</span>
        </form>
      {:else if data.wikiNotFound}
        <EmptyState icon="search" title={t('wikiNotFound')} />
      {:else if current && historyPage === current.id}
        {#key current.id}
          <WikiHistory
            {wiki}
            {current}
            {canWrite}
            onbusy={(busy) => {
              historyBusy = busy;
            }}
            internalLinkPrefix={`${page.url.origin}${wiki.rootHref}/`}
            onclose={async () => {
              historyPage = null;
              await invalidate('app:wiki');
              await tick();
              document.getElementById('wiki-page-title')?.focus();
            }}
            update={({ page_id, read_version, title, body_md }) =>
              wiki.updatePage(page_id, read_version, { title, body_md })}
            onrestored={async (saved) => {
              historyPage = null;
              notice = t(saved.version === current.version ? 'wikiRestoreUnchanged' : 'wikiRestored', {
                version: saved.version,
              });
              await invalidate('app:wiki');
              await tick();
              document.getElementById('wiki-page-title')?.focus();
            }}
          />
        {/key}
      {:else if current}
        <div class="wiki-head">
          <h2 id="wiki-page-title" tabindex="-1" class="section-title wrap-anywhere">{current.title}</h2>
        </div>
        <div class="form-actions wiki-page-actions">
          {#if current.id !== deletedPageId}
            <FavoriteButton targetType="wiki_page" targetId={current.id} title={current.title} {workspaceId} />
          {/if}
          <button
            class="btn"
            type="button"
            aria-disabled={deleteBlocked}
            onclick={() => {
              if (!deleteBlocked) download();
            }}>{t('wikiDownload')}</button
          >
          <button
            class="btn"
            type="button"
            aria-disabled={deleteBlocked}
            onclick={() => {
              if (!deleteBlocked) historyPage = current.id;
            }}>{t('wikiHistory')}</button
          >
          {#if canWrite && current.id !== deletedPageId}
            <button class="btn" type="button" aria-disabled={deleteBlocked} onclick={() => begin(false)}
              >{t('wikiEdit')}</button
            >
            <button
              class="btn"
              type="button"
              id="wiki-parent-action"
              aria-disabled={deleteBlocked}
              onclick={(event) => {
                if (!deleteBlocked) wikiTree?.showMove(event.currentTarget, current);
              }}>{t('moveParent')}</button
            >{#if depth < 10}<button
                class="btn"
                type="button"
                aria-disabled={deleteBlocked}
                onclick={() => begin(true, current.id)}>{t('wikiAddChild')}</button
              >{:else}<p class="field-hint">{t('wikiDepth')}</p>{/if}
          {/if}
          {#if canDelete}<button
              class="btn is-danger"
              type="button"
              aria-disabled={deleteBlocked || uploadBusy || historyBusy}
              onclick={(event) => removePage(event.currentTarget)}>{t('wikiDelete')}</button
            >{/if}
        </div>
        <WikiContent source={current.body_md} internalLinkPrefix={`${page.url.origin}${wiki.rootHref}/`} />
      {:else if pages.length}
        <h2 class="section-title">{t('wikiTop')}</h2>
        <ul>
          {#each pages.filter((item) => item.parent_id === null) as item (item.id)}<li>
              <a href={wiki.pageHref(item.id)}>{item.title}</a>
            </li>{/each}
        </ul>
      {:else}
        <EmptyState icon="file" title={t('wikiEmpty')} text={t('wikiEmptyText')} />
      {/if}
    </section>
  </div>
{/if}
<ConfirmDialog
  bind:this={deleteDialog}
  title={t('wikiDeleteTitle')}
  confirmLabel={t('wikiDelete')}
  cancelLabel={t('cancel')}
  danger
>
  <p class="wrap-anywhere">{t('wikiDeleteText', { title: deleteTarget?.title ?? '' })}</p>
  {#if deleteTarget && deleteTarget.children > 0}<p class="wrap-anywhere">
      {t('wikiDeleteChildren', { count: deleteTarget.children, parent: deleteTarget.parent })}
    </p>{/if}
</ConfirmDialog>
<ConfirmDialog
  bind:this={discardDialog}
  title={t('wikiDiscardTitle')}
  confirmLabel={t('wikiDiscard')}
  cancelLabel={t('wikiKeepWriting')}
  danger><p>{t('wikiDiscardText')}</p></ConfirmDialog
>
{#key wiki.rootHref}
  <WikiUploadDialog
    bind:this={uploadDialog}
    {wiki}
    {pages}
    bind:busy={uploadBusy}
    onuploaded={uploaded}
    onrefresh={refreshWiki}
  />
{/key}
