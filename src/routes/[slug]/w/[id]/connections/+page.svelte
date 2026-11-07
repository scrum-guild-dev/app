<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../../../../lib/api.ts';
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import Section from '../../../../../lib/components/Section.svelte';
  import {
    CONNECTION_NAME_LIMIT,
    connectionCreateFailure,
    connectionScopeFailure,
    connectionSyncFailure,
    connectionSyncOutcome,
    validateConnectionCreate,
    type ConnectionFailure,
  } from '../../../../../lib/connection-form.ts';
  import { formatLocalDateTime } from '../../../../../lib/format.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    CONNECTION_SCOPES_MAX,
    connectionCreate,
    connectionScopeCandidates,
    connectionScopesSave,
    connectionSync,
    type Connection,
  } from '../../../../../shared/operations/connection/index.ts';
  import type { DictionaryKey } from '../../../../../shared/vocabulary.ts';
  import type { PageProps } from './$types';

  // 接続の画面（design/connections.html）。ワークスペースの接続を、状態、登録した人、取り込み元、範囲、最後に成功した日時、
  // 認証情報の末尾4文字で並べる（ワークスペースの全員が見られる）。終了していないワークスペースでは、メンバーが新しい接続を
  // 登録できる。登録は2段で、1段目は表示名と認証情報（GitHub の fine-grained PAT）を送って登録する。形の違うトークンと
  // GitHub が受け付けないトークンは、理由を欄の下に出して登録しない。登録できたら同じ画面で続けて範囲の候補を読み、選んで保存する
  // （2段目。選ばずに閉じてもよく、範囲を選ぶまで何も取り込まない。登録した本人の接続で範囲がまだ無いものからも開ける）。
  // 公開範囲（取り込んだ内容は private を含めてワークスペースの全員に見える）と、組織の承認制の案内は登録の欄に出す。
  // 今すぐ同期、編集、停止、削除は別のタスクで足す。認証情報は送った直後に欄から消し、画面の状態にも残さない
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const connections = $derived(data.connections);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  const meId = $derived(data.organization?.me.id ?? null);

  const STATE: Record<Connection['status'], { cls: string; key: DictionaryKey }> = {
    active: { cls: 'is-ok', key: 'connectionStateActive' },
    error: { cls: 'is-error', key: 'connectionStateError' },
    stopped: { cls: 'is-stopped', key: 'connectionStateStopped' },
  };

  const tallies = $derived.by(() => {
    const list = connections ?? [];
    const count = (status: Connection['status']) => list.filter((c) => c.status === status).length;
    return [
      { icon: 'check' as const, label: t('connectionTallyActive'), count: count('active'), tone: 'ok' as const },
      { icon: 'alert' as const, label: t('connectionTallyError'), count: count('error'), tone: 'warn' as const },
      { icon: 'alert' as const, label: t('connectionTallyStopped'), count: count('stopped'), tone: 'danger' as const },
    ];
  });

  // 1段目の入力と状態。認証情報は送ったらすぐ空にする
  let name = $state('');
  let credential = $state('');
  let creating = $state(false);
  let failure = $state<ConnectionFailure | null>(null);

  // 2段目: 範囲を選んでいる接続の ID と、その候補。candidates が null の間は読み込み中か失敗
  let choosing = $state<{ id: string; name: string } | null>(null);
  let candidates = $state<{ id: string; name: string }[] | null>(null);
  let chosen = $state<string[]>([]);
  let scopeFailure = $state<DictionaryKey | null>(null);
  let loadingCandidates = $state(false);
  let saving = $state(false);
  // 同期中の接続の ID（同時に1つだけ）
  let syncingId = $state<string | null>(null);

  const overLimit = $derived(chosen.length > CONNECTION_SCOPES_MAX);

  function unauthenticated(result: Parameters<typeof isUnauthenticated>[0]): boolean {
    if (!isUnauthenticated(result)) return false;
    window.location.assign(loginUrl(page.url));
    return true;
  }

  async function reload(): Promise<void> {
    await invalidate('app:connections');
  }

  async function openScope(target: Connection | { id: string; name: string }): Promise<void> {
    choosing = { id: target.id, name: target.name };
    chosen = 'scopes' in target ? target.scopes.map((scope) => scope.id) : [];
    await loadCandidates();
    await tick();
    document.getElementById('connection-scope')?.focus();
  }

  async function loadCandidates(): Promise<void> {
    if (choosing === null || workspace === null || loadingCandidates) return;
    loadingCandidates = true;
    scopeFailure = null;
    candidates = null;
    try {
      const result = await callOperation(
        connectionScopeCandidates,
        { workspace_id: workspace.id, connection_id: choosing.id },
        { slug },
      );
      if (!result.ok && unauthenticated(result)) return;
      if (result.ok) {
        candidates = result.data.candidates;
        // 候補に無くなった選びは捨てる
        const live = new Set(candidates.map((candidate) => candidate.id));
        chosen = chosen.filter((id) => live.has(id));
      } else scopeFailure = connectionScopeFailure(result);
    } finally {
      loadingCandidates = false;
    }
  }

  function toggle(id: string, on: boolean): void {
    chosen = on ? [...chosen.filter((item) => item !== id), id] : chosen.filter((item) => item !== id);
  }

  async function register(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (creating || workspace === null || !canWrite) return;
    const invalid = validateConnectionCreate({ name, credential });
    if (invalid !== null) {
      failure = invalid;
      return;
    }
    failure = null;
    creating = true;
    // 認証情報は送る分だけ取り出して、欄はすぐ空にする
    const secret = credential;
    credential = '';
    try {
      const result = await callOperation(
        connectionCreate,
        { workspace_id: workspace.id, provider: 'github', name: name.trim(), credential: secret },
        { slug },
      );
      if (!result.ok && unauthenticated(result)) return;
      if (result.ok) {
        const created = result.data.connection;
        showToast(t('connectionRegistered', { name: created.name }), 'check');
        name = '';
        await reload();
        await openScope(created);
      } else {
        failure = connectionCreateFailure(result);
        if (result.error?.code === 'workspace_closed') await invalidate('app:workspace');
      }
    } finally {
      creating = false;
    }
  }

  async function saveScope(): Promise<void> {
    if (choosing === null || workspace === null || saving || overLimit || candidates === null) return;
    saving = true;
    scopeFailure = null;
    try {
      const result = await callOperation(
        connectionScopesSave,
        { workspace_id: workspace.id, connection_id: choosing.id, source_ids: chosen },
        { slug },
      );
      if (!result.ok && unauthenticated(result)) return;
      if (result.ok) {
        showToast(t('connectionScopeSaved', { name: result.data.connection.name }), 'check');
        closeScope();
        await reload();
      } else {
        scopeFailure = connectionScopeFailure(result);
        if (result.error?.code === 'workspace_closed') await invalidate('app:workspace');
        else if (result.status === 403 || result.status === 404) await reload();
      }
    } finally {
      saving = false;
    }
  }

  async function syncNow(target: Connection): Promise<void> {
    if (syncingId !== null || workspace === null || !canWrite) return;
    syncingId = target.id;
    try {
      const result = await callOperation(
        connectionSync,
        { workspace_id: workspace.id, connection_id: target.id },
        { slug },
      );
      if (!result.ok && unauthenticated(result)) return;
      if (result.ok) {
        const outcome = connectionSyncOutcome(result.data);
        showToast(t(outcome.key, { count: result.data.imported, connection: t('connection') }), outcome.icon);
      } else {
        showToast(
          t(connectionSyncFailure(result), { connection: t('connection'), workspace: t('workspace') }),
          'alert',
        );
        if (result.error?.code === 'workspace_closed') await invalidate('app:workspace');
      }
      // 結果にかかわらず、最後に成功した日時と状態、理由を読み直す
      await reload();
    } finally {
      syncingId = null;
    }
  }

  function closeScope(): void {
    choosing = null;
    candidates = null;
    chosen = [];
    scopeFailure = null;
  }

  const nameFailure = $derived(failure?.field === 'name' ? failure.key : null);
  const credentialFailure = $derived(failure?.field === 'credential' ? failure.key : null);
  const formFailure = $derived(failure?.field === 'form' ? failure.key : null);
</script>

<svelte:head>
  {#if workspace && connections !== null}
    <title>
      {t('pageTitle', {
        page: t('connectionPageName', { connection: t('connection'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && connections === null}
  <LoadFailed inShell />
{:else if workspace && connections !== null}
  <PageHead title={t('connection')} eyebrow={workspace.name} {tallies} />

  <p class="action-note">{t('connectionNote', { connection: t('connection'), workspace: t('workspace') })}</p>

  {#if connections.length === 0}
    <EmptyState
      icon="link"
      title={t('connectionEmptyTitle', { connection: t('connection') })}
      text={canWrite
        ? t('connectionEmptyText', { connection: t('connection'), inbox: t('inbox') })
        : t('connectionEmptyReadonly', { connection: t('connection'), workspace: t('workspace') })}
    />
  {:else}
    <div role="list" aria-label={t('connectionListLabel', { connection: t('connection') })}>
      {#each connections as connection (connection.id)}
        {@const state = STATE[connection.status]}
        {@const mine = meId !== null && connection.owner_user_id === meId}
        <section class="panel conn" role="listitem" data-connection-id={connection.id}>
          <div class="conn-head">
            <span class="kind is-story"><Icon name="git" /></span>
            <h2 class="conn-name">{connection.name}</h2>
            <span class="state-badge {state.cls}">{t(state.key)}</span>
            {#if canWrite && mine && connection.scopes.length === 0 && choosing?.id !== connection.id}
              <span class="conn-actions">
                <button class="btn is-sm" type="button" onclick={() => openScope(connection)}
                  >{t('connectionChooseScope')}</button
                >
              </span>
            {:else if canWrite && mine && connection.status !== 'stopped' && connection.scopes.length > 0}
              <span class="conn-actions">
                <button
                  class="btn is-sm"
                  type="button"
                  aria-disabled={syncingId !== null}
                  aria-busy={syncingId === connection.id}
                  onclick={() => syncNow(connection)}
                  ><Icon name="refresh" />{syncingId === connection.id
                    ? t('connectionSyncing')
                    : t('connectionSyncNow')}</button
                >
              </span>
            {/if}
          </div>
          {#if connection.last_error_message}
            <div class="callout is-warn">
              <Icon name="alert" /><span
                >{t('connectionErrorCallout', {
                  message: connection.last_error_message,
                  at: connection.last_error_at === null ? '' : formatLocalDateTime(connection.last_error_at),
                  count: connection.consecutive_failures,
                })}</span
              >
            </div>
          {/if}
          {#if connection.stopped_reason}
            <div class="callout is-danger">
              <Icon name="alert" /><span
                >{connection.stopped_reason === 'auth_failed'
                  ? t('connectionStoppedAuthFailed')
                  : t('connectionStoppedOther', { connection: t('connection') })}</span
              >
            </div>
          {/if}
          <dl class="facts">
            <div>
              <dt>{t('connectionFactOwner')}</dt>
              <dd>
                <Avatar userId={connection.owner_user_id} name={connection.owner_name ?? ''} />
                {connection.owner_name ?? t('connectionOwnerUnknown')}
              </dd>
            </div>
            <div>
              <dt>{t('connectionFactSource')}</dt>
              <dd>{t('connectionSourceGithub')}</dd>
            </div>
            <div>
              <dt>{t('connectionFactScope')}</dt>
              <dd>
                {#each connection.scopes as scope (scope.id)}
                  <span class="tag">{scope.name}</span>
                {:else}
                  {t('connectionFactScopeNone')}
                {/each}
              </dd>
            </div>
            <div>
              <dt>{t('connectionFactLastSuccess')}</dt>
              <dd class="mono">
                {connection.last_success_at === null
                  ? t('connectionFactLastSuccessNone')
                  : formatLocalDateTime(connection.last_success_at)}
              </dd>
            </div>
            <div>
              <dt>{t('connectionFactCredential')}</dt>
              <dd class="mono">{connection.credential_last4 === null ? '—' : `••••${connection.credential_last4}`}</dd>
            </div>
          </dl>
        </section>
      {/each}
    </div>
  {/if}

  {#if canWrite}
    <Section
      id="connection-new"
      title={t('connectionRegisterTitle', { connection: t('connection') })}
      hint={t('connectionRegisterHint')}
    >
      <div class="panel">
        <ol class="steps">
          <li class="step" class:is-done={choosing !== null}>
            <form class="step-body" onsubmit={register} novalidate>
              <span class="step-title">{t('connectionStepRegister')}</span>
              <div class="choice-list">
                <div class="choice is-static">
                  <div>
                    <b>{t('connectionSourceGithub')}</b>
                    <span>{t('connectionSourceGithubHint')}</span>
                  </div>
                </div>
              </div>
              <div class="form-row">
                <label class="field" for="connection-name">
                  <span class="field-label">{t('connectionNameLabel')}</span>
                  <input
                    class="input"
                    id="connection-name"
                    bind:value={name}
                    maxlength={CONNECTION_NAME_LIMIT * 2}
                    autocomplete="off"
                    placeholder={t('connectionNamePlaceholder')}
                    aria-invalid={nameFailure !== null}
                    aria-describedby={nameFailure !== null ? 'connection-name-error' : undefined}
                  />
                  {#if nameFailure !== null}
                    <span class="field-error" id="connection-name-error" role="alert">{t(nameFailure)}</span>
                  {/if}
                </label>
                <label class="field" for="connection-credential">
                  <span class="field-label">{t('connectionCredentialLabel')}</span>
                  <input
                    class="input"
                    id="connection-credential"
                    type="password"
                    bind:value={credential}
                    autocomplete="off"
                    spellcheck="false"
                    placeholder={t('connectionCredentialPlaceholder')}
                    aria-invalid={credentialFailure !== null}
                    aria-describedby={credentialFailure !== null
                      ? 'connection-credential-error'
                      : 'connection-credential-hint'}
                  />
                  {#if credentialFailure !== null}
                    <span class="field-error" id="connection-credential-error" role="alert">{t(credentialFailure)}</span
                    >
                  {/if}
                </label>
              </div>
              <span class="field-hint" id="connection-credential-hint">{t('connectionCredentialHint')}</span>
              <div class="callout is-warn">
                <Icon name="alert" /><span>{t('connectionPrivacyNotice', { workspace: t('workspace') })}</span>
              </div>
              <div class="callout is-info">
                <Icon name="shield" /><span>{t('connectionOrgApprovalNotice')}</span>
              </div>
              {#if formFailure !== null}
                <div class="callout is-warn" role="alert">
                  <Icon name="alert" /><span
                    >{t(formFailure, { workspace: t('workspace'), connection: t('connection') })}</span
                  >
                </div>
              {/if}
              <div class="form-actions">
                <button class="btn is-primary" type="submit" aria-disabled={creating}
                  >{creating ? t('connectionSubmitting') : t('connectionSubmit')}</button
                >
              </div>
            </form>
          </li>
          <li class="step">
            <div class="step-body">
              <span class="step-title" id="connection-scope" tabindex="-1">{t('connectionStepScope')}</span>
              {#if choosing === null}
                <span class="field-hint">{t('connectionStepScopeLocked')}</span>
              {:else}
                <p class="field-hint">{choosing.name}</p>
                {#if loadingCandidates}
                  <span class="field-hint" role="status">{t('connectionScopeLoading')}</span>
                {:else if candidates !== null}
                  {#if candidates.length === 0}
                    <span class="field-hint" role="status">{t('connectionScopeEmpty')}</span>
                  {:else}
                    <fieldset class="choice-list">
                      <legend class="field-label">{t('connectionScopeLegend')}</legend>
                      {#each candidates as candidate (candidate.id)}
                        <label class="toggle">
                          <input
                            type="checkbox"
                            checked={chosen.includes(candidate.id)}
                            onchange={(event) => toggle(candidate.id, event.currentTarget.checked)}
                          /><span>{candidate.name}</span>
                        </label>
                      {/each}
                    </fieldset>
                    <span class="field-hint" role="status"
                      >{overLimit
                        ? t('connectionScopeLimit', { limit: CONNECTION_SCOPES_MAX })
                        : t('connectionScopeCount', { count: chosen.length })}</span
                    >
                  {/if}
                  <span class="field-hint">{t('connectionScopeHint')}</span>
                {/if}
                {#if scopeFailure !== null}
                  <div class="callout is-warn" role="alert">
                    <Icon name="alert" /><span
                      >{t(scopeFailure, { connection: t('connection'), workspace: t('workspace') })}</span
                    >
                  </div>
                {/if}
                <div class="form-actions">
                  {#if candidates !== null}
                    <button class="btn is-primary" type="button" aria-disabled={saving || overLimit} onclick={saveScope}
                      >{saving ? t('connectionScopeSaving') : t('connectionScopeSave')}</button
                    >
                  {:else if !loadingCandidates}
                    <button class="btn" type="button" onclick={loadCandidates}>{t('connectionScopeRetry')}</button>
                  {/if}
                  <button class="btn is-quiet" type="button" onclick={closeScope}>{t('connectionScopeCancel')}</button>
                </div>
              {/if}
            </div>
          </li>
        </ol>
      </div>
    </Section>
  {/if}
{/if}
