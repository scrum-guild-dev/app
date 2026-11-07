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
    connectionCreateFailure,
    connectionScopeFailure,
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

  const overLimit = $derived(chosen.length > CONNECTION_SCOPES_MAX);

  function unauthenticated(result: Parameters<typeof isUnauthenticated>[0]): boolean {
    if (!isUnauthenticated(result)) return false;
    window.location.assign(loginUrl(page.url));
    return true;
  }

  async function reload(): Promise<void> {
    await invalidate('app:connections');
  }

  // 範囲の候補を読んだ回数。応答が着いたとき、読み始めた回と同じでなければ（別の接続を開いた、閉じた）捨てる
  let candidatesRun = 0;

  async function openScope(target: Connection | { id: string; name: string }): Promise<void> {
    // 範囲を保存している間は、別の接続を開かない（保存の完了が新しく開いた段を閉じるため）
    if (saving) return;
    choosing = { id: target.id, name: target.name };
    chosen = 'scopes' in target ? target.scopes.map((scope) => scope.id) : [];
    // 段のタイトルへ先にフォーカスを移す（押したボタンが消えるので、読み込みを待つとフォーカスが body に落ちる）
    await tick();
    document.getElementById('connection-scope')?.focus();
    await loadCandidates();
  }

  async function loadCandidates(): Promise<void> {
    if (choosing === null || workspace === null) return;
    candidatesRun += 1;
    const run = candidatesRun;
    const connectionId = choosing.id;
    loadingCandidates = true;
    scopeFailure = null;
    candidates = null;
    const result = await callOperation(
      connectionScopeCandidates,
      { workspace_id: workspace.id, connection_id: connectionId },
      { slug },
    );
    if (run !== candidatesRun) return;
    loadingCandidates = false;
    if (!result.ok && unauthenticated(result)) return;
    if (result.ok) {
      candidates = result.data.candidates;
      // 候補に無くなった選びは捨てる
      const live = new Set(candidates.map((candidate) => candidate.id));
      chosen = chosen.filter((id) => live.has(id));
    } else {
      scopeFailure = connectionScopeFailure(result);
      if (result.status === 403 || result.status === 404) await reload();
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
      await focusFailure();
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
        if (result.error?.code === 'workspace_closed') {
          showToast(t('connectionWorkspaceClosed', { workspace: t('workspace') }), 'alert');
          await invalidate('app:workspace');
        } else await focusFailure();
      }
    } finally {
      creating = false;
    }
  }

  // 失敗した欄へフォーカスを移す。認証情報の欄は送った直後に空になっているので、入れ直す場所に戻す
  async function focusFailure(): Promise<void> {
    await tick();
    const id =
      failure?.field === 'name'
        ? 'connection-name'
        : failure?.field === 'form' && failure.key.startsWith('connectionCreate')
          ? 'connection-credential'
          : failure?.field === 'credential'
            ? 'connection-credential'
            : null;
    if (id !== null) document.getElementById(id)?.focus();
  }

  async function saveScope(): Promise<void> {
    if (choosing === null || workspace === null || saving || overLimit || candidates === null) return;
    saving = true;
    scopeFailure = null;
    const connectionId = choosing.id;
    try {
      const result = await callOperation(
        connectionScopesSave,
        { workspace_id: workspace.id, connection_id: connectionId, source_ids: chosen },
        { slug },
      );
      if (!result.ok && unauthenticated(result)) return;
      if (result.ok) {
        showToast(t('connectionScopeSaved', { name: result.data.connection.name }), 'check');
        closeScope(true);
        await reload();
        // 押したボタンが消えるので、フォーカスを段のタイトルへ戻す
        await tick();
        document.getElementById('connection-scope')?.focus();
      } else {
        scopeFailure = connectionScopeFailure(result);
        if (result.error?.code === 'workspace_closed') {
          showToast(t('connectionWorkspaceClosed', { workspace: t('workspace') }), 'alert');
          await invalidate('app:workspace');
        } else if (result.status === 403 || result.status === 404) await reload();
      }
    } finally {
      saving = false;
    }
  }

  // 保存の間は閉じない（完了の応答が、閉じた後に開いた別の接続の段を書き換えないように）。保存が成功したときだけ、保存の中から閉じる
  function closeScope(afterSave = false): void {
    if (saving && !afterSave) return;
    candidatesRun += 1;
    loadingCandidates = false;
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
  {#if !canWrite && connections.length > 0}
    <p class="action-note">
      {t('connectionReadonlyNote', { connection: t('connection'), workspace: t('workspace') })}
    </p>
  {/if}

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
                <button class="btn is-sm" type="button" aria-disabled={saving} onclick={() => openScope(connection)}
                  >{t('connectionChooseScope')}</button
                >
              </span>
            {/if}
          </div>
          {#if connection.last_error_message}
            <div class="callout is-warn">
              <Icon name="alert" /><span
                >{connection.last_error_at === null || connection.consecutive_failures === 0
                  ? t('connectionErrorCalloutPlain', { message: connection.last_error_message })
                  : t('connectionErrorCallout', {
                      message: connection.last_error_message,
                      at: formatLocalDateTime(connection.last_error_at),
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
                  : t('connectionStoppedOther')}</span
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
              <dd class="mono">
                {#if connection.credential_last4 === null}
                  —
                {:else}
                  <span aria-hidden="true">••••</span><span class="visually-hidden"
                    >{t('connectionCredentialLast4')}</span
                  >{connection.credential_last4}
                {/if}
              </dd>
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
                <div class="field">
                  <label class="field-label" for="connection-name">{t('connectionNameLabel')}</label>
                  <input
                    class="input"
                    id="connection-name"
                    bind:value={name}
                    autocomplete="off"
                    placeholder={t('connectionNamePlaceholder')}
                    aria-invalid={nameFailure !== null}
                    aria-describedby={nameFailure !== null ? 'connection-name-error' : undefined}
                  />
                  {#if nameFailure !== null}
                    <span class="field-error" id="connection-name-error" role="alert"
                      ><Icon name="alert" />{t(nameFailure)}</span
                    >
                  {/if}
                </div>
                <div class="field">
                  <label class="field-label" for="connection-credential">{t('connectionCredentialLabel')}</label>
                  <!-- 伏せ字のために type="password" を使う。ブラウザのパスワード管理に保存されないことは保証できない（autocomplete="off" は無視されうる）ので、主な拡張の無視の印だけを付ける。docs/design.md の「接続の画面」 -->
                  <input
                    class="input"
                    id="connection-credential"
                    type="password"
                    bind:value={credential}
                    autocomplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    data-form-type="other"
                    spellcheck="false"
                    placeholder={t('connectionCredentialPlaceholder')}
                    aria-invalid={credentialFailure !== null}
                    aria-describedby={credentialFailure !== null
                      ? 'connection-credential-error connection-credential-hint'
                      : 'connection-credential-hint'}
                  />
                  {#if credentialFailure !== null}
                    <span class="field-error" id="connection-credential-error" role="alert"
                      ><Icon name="alert" />{t(credentialFailure)}</span
                    >
                  {/if}
                </div>
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
                <p class="field-hint">
                  {t('connectionScopeTarget', { connection: t('connection'), name: choosing.name })}
                </p>
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
                  <button class="btn is-quiet" type="button" aria-disabled={saving} onclick={() => closeScope()}
                    >{t('connectionScopeCancel')}</button
                  >
                </div>
              {/if}
            </div>
          </li>
        </ol>
      </div>
    </Section>
  {/if}
{/if}
