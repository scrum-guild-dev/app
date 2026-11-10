<script lang="ts">
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { delegateeList, delegateeCreate } from '../../shared/operations/organization/index.ts';
  import { taskDelegate } from '../../shared/operations/task/index.ts';
  import { definitionNameProblem } from '../../shared/definition.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { SectionLoad } from './admin/section-load.svelte.ts';

  let {
    slug,
    workspaceId,
    taskId,
    value,
    editable,
    onsaved,
    onfailed,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    value: { id: string; name: string } | null;
    editable: boolean;
    onsaved: () => Promise<boolean>;
    onfailed: (status: number, code: string | undefined) => Promise<void>;
  } = $props();
  const id = $props.id();
  let rows = $state<{ id: string; name: string }[]>([]);
  let name = $state('');
  let busy = $state(false);
  let select = $state<HTMLSelectElement>();
  let newInput = $state<HTMLInputElement>();
  $effect(() => {
    void busy;
    void rows;
    if (select) select.value = value?.id ?? '';
  });
  let error = $state('');
  const section = new SectionLoad(
    () =>
      editable
        ? callOperation(delegateeList, {}, { slug })
        : Promise.resolve({ ok: true as const, data: { delegatees: [] } }),
    (data) => {
      rows = data.delegatees;
    },
  );
  section.attach(
    () => [slug, workspaceId, taskId, editable],
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
            await section.load();
            if (!section.isCurrent(token)) return;
          }
        }
      }
      const result = await callOperation(taskDelegate, { ...input, delegatee_id: selected }, options);
      if (!section.isCurrent(token)) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (!result.ok) {
        error = t(
          result.status === 404 || result.status === 409 ? 'delegateeAssignUnavailable' : 'delegateeAssignFailed',
        );
        await onfailed(result.status, result.error?.code);
        if (section.isCurrent(token)) await section.load();
        return;
      }
      const saved = await onsaved();
      if (!section.isCurrent(token)) return;
      if (!saved) error = t('delegateeReloadFailed');
      else if (create) {
        name = '';
        await tick();
        newInput?.focus();
      }
    } finally {
      if (section.isCurrent(token)) busy = false;
    }
  }
</script>

<div>
  <dt>
    {#if editable && section.state === 'ready'}<label for={id}>{t('delegatee')}</label>{:else}{t('delegatee')}{/if}
  </dt>
  <dd>
    {#if editable}
      {#if section.state === 'ready'}
        <select
          bind:this={select}
          {id}
          class="select"
          value={value?.id ?? ''}
          aria-disabled={busy}
          aria-invalid={error !== ''}
          aria-describedby={error ? `${id}-error` : undefined}
          onchange={(event) => {
            if (busy) event.currentTarget.value = value?.id ?? '';
            else void save(event.currentTarget.value || null);
          }}
        >
          <option value="">{t('delegateeNone')}</option>
          {#if value && !rows.some((row) => row.id === value.id)}<option value={value.id}>{value.name}</option>{/if}
          {#each rows as row (row.id)}<option value={row.id}>{row.name}</option>{/each}
        </select>
        <form
          class="field"
          onsubmit={(event) => {
            event.preventDefault();
            if (!busy && name.trim()) void save(null, true);
          }}
        >
          <label class="visually-hidden" for={`${id}-new`}>{t('delegateeNew')}</label>
          <input
            bind:this={newInput}
            id={`${id}-new`}
            class="input"
            bind:value={name}
            readonly={busy}
            oninput={() => {
              error = '';
            }}
            aria-invalid={error !== ''}
            aria-describedby={error ? `${id}-error` : undefined}
            placeholder={t('delegateeNew')}
          />
          {#if name.trim()}<div class="form-actions">
              <button class="btn is-sm" type="submit" aria-disabled={busy}
                >{t('delegateeAdd', { name: name.trim() })}</button
              >
            </div>{/if}
        </form>
      {:else}
        <span>{value?.name ?? t('delegateeNone')}</span>
        <span class="props-note" role="status"
          >{t(section.state === 'loading' ? 'delegateeLoading' : 'delegateeLoadFailed')}</span
        >
      {/if}
      {#if section.refreshFailed}<span class="props-note" id={`${id}-refresh`}>{t('delegateeRefreshFailed')}</span>{/if}
      {#if section.state === 'failed' || section.refreshFailed}
        <div class="form-actions">
          <button
            class="btn is-sm is-quiet"
            type="button"
            aria-disabled={section.retrying}
            aria-describedby={section.refreshFailed ? `${id}-refresh` : undefined}
            onclick={() => section.retry()}>{t('retry')}</button
          >
        </div>
      {/if}
    {:else}
      <span>{value?.name ?? t('delegateeNone')}</span>
      <span class="props-note">{t('delegateeReadonly')}</span>
    {/if}
    <span id={`${id}-error`} role="alert"
      >{#if error}<span class="field-error"><Icon name="alert" />{error}</span>{/if}</span
    >
    <span role="status" class="visually-hidden">{busy ? t('delegateeBusy') : ''}</span>
  </dd>
</div>
