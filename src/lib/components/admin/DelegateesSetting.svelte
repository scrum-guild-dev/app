<script lang="ts">
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { delegateeList, delegateeUpdate, delegateeDelete } from '../../../shared/operations/organization/index.ts';
  import { definitionNameProblem } from '../../../shared/definition.ts';
  import { callOperation } from '../../api.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Setting from '../Setting.svelte';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  let { slug }: { slug: string } = $props();
  let rows = $state<{ id: string; name: string }[]>([]);
  let drafts = $state<Record<string, string>>({});
  let busy = $state(false);
  let error = $state('');
  let errorRow = $state<string | null>(null);
  let deleting = $state('');
  let confirm = $state<ReturnType<typeof ConfirmDialog>>();
  let list = $state<HTMLDivElement>();
  const ids = $props.id();
  const section = new SectionLoad(
    () => callOperation(delegateeList, {}, { slug }),
    (data) => {
      const previous = new Map(rows.map((row) => [row.id, row.name]));
      rows = data.delegatees;
      drafts = Object.fromEntries(
        rows.map((row) => [
          row.id,
          drafts[row.id] !== undefined && drafts[row.id] !== previous.get(row.id) ? drafts[row.id] : row.name,
        ]),
      );
    },
  );
  section.attach(
    () => slug,
    () => {
      rows = [];
      drafts = {};
      busy = false;
      error = '';
    },
  );
  async function change(row: { id: string; name: string }, remove: boolean, trigger: HTMLButtonElement): Promise<void> {
    if (busy) return;
    const token = section.token();
    const options = { slug };
    const name = (drafts[row.id] ?? '').trim();
    errorRow = row.id;
    if (!remove && definitionNameProblem(name) !== null) {
      error = t('delegateeInvalid');
      return;
    }
    busy = true;
    error = '';
    try {
      if (remove) {
        deleting = row.name;
        if (!(await confirm?.ask(trigger)) || !section.isCurrent(token)) return;
      }
      const result = remove
        ? await callOperation(delegateeDelete, { delegatee_id: row.id }, options)
        : await callOperation(delegateeUpdate, { delegatee_id: row.id, name }, options);
      if (!section.isCurrent(token)) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (!result.ok) {
        error = t(remove ? 'delegateeDeleteFailed' : 'delegateeFailed');
        await section.load();
        return;
      }
      // 保存した行だけを確定し、ほかの行の書きかけは一覧の再取得でも残す。
      if (!remove && drafts[row.id] === name) drafts[row.id] = row.name;
      await section.load();
      if (remove && section.isCurrent(token)) {
        await tick();
        list?.focus();
      }
    } finally {
      if (section.isCurrent(token)) busy = false;
    }
  }
</script>

<Setting title={t('delegatee')} description={t('delegateeDesc')}>
  <SectionBoundary {section} failedTitle={t('delegateeLoadFailed')} refreshFailedText={t('delegateeRefreshFailed')}>
    <div class="form" bind:this={list} tabindex="-1">
      {#if rows.length === 0}<EmptyState icon="users" title={t('delegateeEmpty')} text={t('delegateeEmptyText')} />{/if}
      {#each rows as row (row.id)}
        <form
          class="field"
          aria-labelledby={`${ids}-${row.id}-label`}
          onsubmit={(event) => {
            event.preventDefault();
            const trigger = event.currentTarget.querySelector<HTMLButtonElement>('button');
            if (trigger) void change(row, false, trigger);
          }}
        >
          <label id={`${ids}-${row.id}-label`} class="field-label" for={`${ids}-${row.id}`}>{row.name}</label>
          <input
            class="input"
            id={`${ids}-${row.id}`}
            bind:value={drafts[row.id]}
            readonly={busy}
            oninput={() => {
              if (errorRow === row.id) error = '';
            }}
            aria-invalid={errorRow === row.id && error !== ''}
            aria-describedby={errorRow === row.id && error ? `${ids}-error` : undefined}
          />
          <div class="form-actions">
            <button class="btn is-sm" type="submit" aria-disabled={busy}>{t('delegateeSave')}</button>
            <button
              class="btn is-sm is-danger"
              type="button"
              aria-disabled={busy}
              onclick={(event) => change(row, true, event.currentTarget)}>{t('delegateeRemove')}</button
            >
          </div>
        </form>
      {/each}
    </div>
  </SectionBoundary>
  <span id={`${ids}-error`} role="alert"
    >{#if error}<span class="field-error"><Icon name="alert" />{error}</span>{/if}</span
  >
  <span role="status" class="visually-hidden">{busy ? t('delegateeBusy') : ''}</span>
</Setting>
<ConfirmDialog
  bind:this={confirm}
  title={t('delegateeDeleteTitle')}
  confirmLabel={t('delegateeRemove')}
  cancelLabel={t('delegateeCancel')}
  danger
>
  <p>{t('delegateeDeleteText', { name: deleting })}</p>
</ConfirmDialog>
