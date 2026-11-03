<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { beforeNavigate, goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { wikiClient } from '../wiki-client.ts';
  import type { WikiData } from '../wiki-load.ts';
  import type { WorkspaceView } from '../workspace.ts';
  import { organizationLabel } from '../organization-label.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import type { organizationInfo } from '../../shared/operations/organization/index.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { parseWikiFrontmatter, wikiBodyProblem, wikiTitle } from '../../shared/wiki.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import LoadFailed from './LoadFailed.svelte';
  import WikiContent from './WikiContent.svelte';
  import PageHead from './PageHead.svelte';
  import WikiTree from './WikiTree.svelte';
  import WikiHistory from './WikiHistory.svelte';
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
  const pages = $derived(data.wikiPages ?? []);
  const canWrite = $derived(
    workspaceId === null
      ? data.organization !== null && data.wikiPages !== null
      : data.workspace != null && data.workspace.closedAt === null,
  );
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

  async function mayDiscard(): Promise<boolean> {
    if (saving || historyBusy) return false;
    return (
      !dirty ||
      ((await discardDialog?.ask(document.activeElement instanceof HTMLElement ? document.activeElement : null)) ??
        false)
    );
  }
  beforeNavigate((navigation) => {
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
    if (!canWrite || !(await mayDiscard())) return;
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
        mode = 'read';
        saving = false;
        notice = t(unchanged ? 'wikiUnchanged' : 'wikiSaved');
        conflict = false;
        await invalidate('app:wiki');
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
  {#snippet actions()}{#if canWrite}<button
        class="btn is-primary"
        type="button"
        aria-disabled={historyBusy}
        onclick={() => begin(true)}>{t('wikiAdd')}</button
      >{/if}{/snippet}
  {#snippet meta()}{#if data.wikiPages !== null && !data.wikiNotFound}<p class="section-hint">
        {t(wiki.accessLabel)}
      </p>{/if}{/snippet}
</PageHead>
{#if workspaceId !== null && !canWrite}<p class="callout is-info">{t('wikiClosed')}</p>{/if}
<p role="status" class="field-hint">{notice}</p>
{#if data.wikiFailed && mode === 'read'}
  <LoadFailed inShell />
{:else}
  <div class="layout-wiki">
    <aside class="wiki-side">
      {#if pages.length}<WikiTree {pages} {wiki} currentId={current?.id ?? null} />{:else}<p class="section-hint">
          {t('wikiTreeEmpty')}
        </p>{/if}
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
              notice = t(saved.version === current.version ? 'wikiUnchanged' : 'wikiRestored', {
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
          <button
            class="btn"
            type="button"
            onclick={() => {
              historyPage = current.id;
            }}>{t('wikiHistory')}</button
          >
          {#if canWrite}<div class="form-actions">
              <button class="btn" type="button" onclick={() => begin(false)}>{t('wikiEdit')}</button
              >{#if depth < 10}<button class="btn" type="button" onclick={() => begin(true, current.id)}
                  >{t('wikiAddChild')}</button
                >{:else}<p class="field-hint">{t('wikiDepth')}</p>{/if}
            </div>{/if}
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
  bind:this={discardDialog}
  title={t('wikiDiscardTitle')}
  confirmLabel={t('wikiDiscard')}
  cancelLabel={t('wikiKeepWriting')}
  danger><p>{t('wikiDiscardText')}</p></ConfirmDialog
>
