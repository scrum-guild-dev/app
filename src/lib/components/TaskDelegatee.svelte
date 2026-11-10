<script lang="ts">
  import { page } from '$app/state';
  import { delegateeList, delegateeCreate } from '../../shared/operations/organization/index.ts';
  import { taskDelegate } from '../../shared/operations/task/index.ts';
  import { definitionNameProblem } from '../../shared/definition.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import SectionBoundary from './admin/SectionBoundary.svelte';
  import { SectionLoad } from './admin/section-load.svelte.ts';

  let {
    slug,
    workspaceId,
    taskId,
    value,
    editable,
    onsaved,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    value: { id: string; name: string } | null;
    editable: boolean;
    onsaved: () => Promise<boolean>;
  } = $props();
  const id = $props.id();
  let rows = $state<{ id: string; name: string }[]>([]);
  let name = $state('');
  let busy = $state(false);
  let select = $state<HTMLSelectElement>();
  $effect(() => {
    void busy;
    void rows;
    if (select) select.value = value?.id ?? '';
  });
  let error = $state('');
  const section = new SectionLoad(
    () => callOperation(delegateeList, {}, { slug }),
    (data) => {
      rows = data.delegatees;
    },
  );
  section.attach(
    () => [slug, workspaceId, taskId],
    () => {
      rows = [];
      name = '';
      error = '';
      busy = false;
    },
  );
  async function save(selected: string | null, create = false): Promise<void> {
    if (busy || !editable) return;
    const token = section.token();
    const input = { workspace_id: workspaceId, task_id: taskId };
    const options = { slug };
    const wantedName = name.trim();
    if (create && definitionNameProblem(wantedName) !== null) {
      error = t('delegateeInvalid');
      return;
    }
    busy = true;
    error = '';
    try {
      if (create) {
        const existing = rows.find((row) => row.name === wantedName);
        if (existing) selected = existing.id;
        else {
          const created = await callOperation(delegateeCreate, { name: wantedName }, options);
          if (!section.isCurrent(token)) return;
          if (isUnauthenticated(created)) {
            window.location.assign(loginUrl(page.url));
            return;
          }
          if (!created.ok) {
            await section.load();
            if (!section.isCurrent(token)) return;
            const duplicate = created.status === 409 ? rows.find((row) => row.name === wantedName) : undefined;
            if (!duplicate) {
              error = t('delegateeFailed');
              return;
            }
            selected = duplicate.id;
          } else {
            selected = created.data.delegatee.id;
            rows = [...rows, created.data.delegatee];
          }
        }
        name = '';
      }
      const result = await callOperation(taskDelegate, { ...input, delegatee_id: selected }, options);
      if (!section.isCurrent(token)) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (!result.ok) {
        error = t('delegateeFailed');
        await section.load();
        return;
      }
      if (!(await onsaved()) && section.isCurrent(token)) error = t('createSheetReloadFailed');
    } finally {
      if (section.isCurrent(token)) busy = false;
    }
  }
</script>

<div>
  <dt>
    {#if editable}<label for={id}>{t('delegateeTitle')}</label>{:else}{t('delegateeTitle')}{/if}
  </dt>
  <dd>
    {#if editable}
      <SectionBoundary {section} failedTitle={t('delegateeLoadFailed')} refreshFailedText={t('delegateeRefreshFailed')}>
        <select
          bind:this={select}
          {id}
          class="select"
          value={value?.id ?? ''}
          disabled={busy}
          aria-invalid={error !== ''}
          aria-describedby={error ? `${id}-error` : undefined}
          onchange={(event) => save(event.currentTarget.value || null)}
        >
          <option value="">{t('delegateeNone')}</option>
          {#if value && !rows.some((row) => row.id === value.id)}<option value={value.id}>{value.name}</option>{/if}
          {#each rows as row (row.id)}<option value={row.id}>{row.name}</option>{/each}
        </select>
        <label class="visually-hidden" for={`${id}-new`}>{t('delegateeNew')}</label>
        <input
          id={`${id}-new`}
          class="input"
          bind:value={name}
          readonly={busy}
          aria-invalid={error !== ''}
          aria-describedby={error ? `${id}-error` : undefined}
          placeholder={t('delegateeNew')}
        />
        {#if name.trim()}<button class="btn is-sm" type="button" disabled={busy} onclick={() => save(null, true)}
            >{t('delegateeAdd', { name: name.trim() })}</button
          >{/if}
      </SectionBoundary>
    {:else}<span>{value?.name ?? t('delegateeNone')}</span>{/if}
    <span id={`${id}-error`} role="alert" class="field-error">{error}</span>
    <span role="status" class="visually-hidden">{busy ? t('delegateeBusy') : ''}</span>
  </dd>
</div>
