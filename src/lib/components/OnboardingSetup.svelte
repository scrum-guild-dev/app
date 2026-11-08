<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../api.ts';
  import {
    createPersonalOrganizationFailure,
    validateCreatePersonalOrganization,
  } from '../create-personal-organization-form.ts';
  import { createMyOrganizationFailure, validateCreateMyOrganization } from '../create-my-organization-form.ts';
  import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { invitationEmails } from '../onboarding.ts';
  import { resetToDefaults } from '../organization.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import {
    accountProfileSave,
    accountProfileSchema,
    onboardingStatus,
  } from '../../shared/operations/session/onboarding.ts';
  import { me } from '../../shared/operations/session/index.ts';
  import {
    createMyOrganization,
    createPersonalOrganization,
    organizationInfo,
    myOrganizations,
  } from '../../shared/operations/organization/index.ts';
  import { onboardingWorkspacePrepare } from '../../shared/operations/workspace/index.ts';
  import { invitationCreate } from '../../shared/operations/workspace/invitation-create.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import BrandMark from './BrandMark.svelte';
  import Icon from './Icon.svelte';
  import LogoutButton from './LogoutButton.svelte';

  let {
    initialStatus,
    person,
    initialTeamSlug,
    returnTo,
  }: {
    initialStatus: OutputOf<typeof onboardingStatus>;
    person: OutputOf<typeof me>;
    initialTeamSlug?: string;
    returnTo: string;
  } = $props();
  // URLのteamが変わると親のkeyで作り直す。入力中のload再評価では欄を巻き戻さない。
  const firstStatus = untrack(() => initialStatus);
  const firstPerson = untrack(() => person);
  const firstTeam = untrack(() => initialTeamSlug);
  const blocked = firstStatus.personal !== null && !firstStatus.personal.available;
  let personal = $state(firstStatus.personal);
  let profileSaved = $state(firstStatus.profile !== null && firstStatus.personal !== null);
  let name = $state(firstStatus.profile?.name ?? firstPerson.display_name ?? firstPerson.login_name);
  let title = $state(firstStatus.profile?.title ?? '');
  let personalSlug = $state(firstStatus.personal?.slug ?? '');
  let teamSlug = $state(firstTeam ?? '');
  let teamName = $state('');
  let workspaceId = $state('');
  let teamCreated = $state(firstTeam !== undefined);
  let step = $state(
    firstTeam !== undefined ? 3 : firstStatus.profile !== null && firstStatus.personal !== null ? 2 : 1,
  );
  let withTeam = $state(firstTeam !== undefined);
  let busy = $state(false);
  let error = $state<DictionaryKey>();
  let heading = $state<HTMLHeadingElement>();
  let errorBox = $state<HTMLDivElement>();
  let emailInput = $state('');
  let links = $state<Array<{ email: string; url: string | null; failed: boolean }>>([]);
  let copied = $state('');
  let alive = true;
  const titles: DictionaryKey[] = $derived([
    'signupTitle',
    'onboardingProfile',
    'onboardingInviteChoice',
    ...(withTeam ? (['onboardingOrganization', 'onboardingInvite'] as DictionaryKey[]) : []),
  ]);
  const words = { organization: t('organization') };
  const personalHref = $derived(personal ? resolve('/[slug]', { slug: personal.slug }) : resolve('/'));
  const finishHref = $derived(
    returnTo !== '/'
      ? returnTo
      : teamCreated && workspaceId !== ''
        ? resolve('/[slug]/w/[id]', { slug: teamSlug, id: workspaceId })
        : personalHref,
  );

  onMount(() => {
    resetToDefaults();
    if (initialTeamSlug !== undefined && !blocked) void prepareWorkspace(initialTeamSlug);
    return () => {
      alive = false;
    };
  });

  async function move(next: number) {
    if (busy) return;
    step = next;
    error = undefined;
    await tick();
    heading?.focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  async function fail(key: DictionaryKey) {
    if (!alive) return;
    busy = false;
    error = key;
    await tick();
    errorBox?.focus();
  }
  function authFailure(result: ApiResult<unknown>): boolean {
    if (isUnauthenticated(result)) {
      location.replace(loginUrl(page.url));
      return true;
    }
    if (isTermsRequired(result)) {
      location.replace(consentUrl(page.url));
      return true;
    }
    return false;
  }
  async function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    if (busy || blocked) return;
    if (profileSaved) {
      await move(2);
      return;
    }
    const parsed = accountProfileSchema.safeParse({ name, title });
    if (!parsed.success) {
      await fail('onboardingProfileInvalid');
      return;
    }
    if (personal === null) {
      const invalid = validateCreatePersonalOrganization({ slug: personalSlug });
      if (invalid) {
        await fail(invalid.key);
        return;
      }
    }
    busy = true;
    error = undefined;
    const profile = await callOperation(accountProfileSave, parsed.data);
    if (!alive || authFailure(profile)) return;
    if (!profile.ok) {
      await fail('onboardingProfileFailed');
      return;
    }
    name = profile.data.name;
    title = profile.data.title;
    if (personal === null) {
      const created = await callOperation(createPersonalOrganization, { slug: personalSlug.trim() });
      if (!alive || authFailure(created)) return;
      if (!created.ok) {
        // 応答を失った後や別タブで作ったときは、重ねて作らずサーバーの状態を取り直す。
        const current = await callOperation(onboardingStatus, {});
        if (!alive || authFailure(current)) return;
        if (current.ok && current.data.personal?.available) personal = current.data.personal;
        else {
          await fail(createPersonalOrganizationFailure(created).key);
          return;
        }
      } else personal = { slug: created.data.slug, available: true };
    }
    personalSlug = personal!.slug;
    profileSaved = true;
    busy = false;
    await move(2);
  }
  async function createTeam(event: SubmitEvent) {
    event.preventDefault();
    if (busy || blocked) return;
    if (teamCreated) {
      await prepareWorkspace(teamSlug);
      return;
    }
    const invalid = validateCreateMyOrganization({ slug: teamSlug, name: teamName });
    if (invalid) {
      await fail(invalid.key);
      return;
    }
    busy = true;
    error = undefined;
    // 既存の管理対象の組織を、今回作成できたチームと取り違えない。
    const before = await callOperation(myOrganizations, {});
    if (!alive || authFailure(before)) return;
    if (!before.ok) {
      await fail('createMyOrganizationFailed');
      return;
    }
    const result = await callOperation(createMyOrganization, { slug: teamSlug.trim(), name: teamName.trim() });
    if (!alive || authFailure(result)) return;
    if (!result.ok) {
      // 書き込み後に応答だけを失ったときは、本人に見える同じチームを確認して再開する。
      const current = await callOperation(myOrganizations, {});
      if (!alive || authFailure(current)) return;
      const recovered = current.ok
        ? current.data.organizations.find(
            (org) =>
              org.kind === 'team' &&
              org.slug === teamSlug.trim() &&
              org.name === teamName.trim() &&
              !before.data.organizations.some((previous) => previous.slug === org.slug),
          )
        : undefined;
      if (!recovered) {
        await fail(createMyOrganizationFailure(result).key);
        return;
      }
      teamSlug = recovered.slug;
      teamName = recovered.name;
    } else {
      teamSlug = result.data.slug;
      teamName = result.data.name;
    }
    teamCreated = true;
    // 組織作成後の再読み込みでも、同じ組織のワークスペース・招待から再開する。
    const params = new SvelteURLSearchParams({ team: teamSlug });
    if (returnTo !== '/') params.set('return_to', returnTo);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 固定の経路をresolveし、URLSearchParamsで構成したクエリだけを足す
    await goto(`${resolve('/auth/setup')}?${params}`, { replace: true });
  }
  async function prepareWorkspace(slug: string) {
    if (busy || blocked) return;
    busy = true;
    error = undefined;
    const org = await callOperation(organizationInfo, {}, { slug });
    if (!alive || authFailure(org)) return;
    if (!org.ok || !org.data.me.is_admin || org.data.organization.kind !== 'team') {
      await fail('onboardingTeamUnavailable');
      return;
    }
    teamName = org.data.organization.name;
    const workspace = await callOperation(
      onboardingWorkspacePrepare,
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
      { slug },
    );
    if (!alive || authFailure(workspace)) return;
    if (!workspace.ok) {
      await fail(workspace.status === 409 ? 'onboardingTeamUnavailable' : 'onboardingWorkspaceFailed');
      return;
    }
    workspaceId = workspace.data.workspace_id;
    busy = false;
    await move(4);
  }
  async function invite(event: SubmitEvent) {
    event.preventDefault();
    if (busy || workspaceId === '') return;
    const emails = invitationEmails(emailInput);
    if (emails === null) {
      await fail('onboardingEmailsInvalid');
      return;
    }
    busy = true;
    error = undefined;
    const requested = [...new Set([...links.filter((row) => row.url !== null).map((row) => row.email), ...emails])];
    links = requested.map(
      (email) => links.find((row) => row.email === email && row.url !== null) ?? { email, url: null, failed: false },
    );
    for (const row of links) {
      if (row.url !== null) continue;
      const result = await callOperation(
        invitationCreate,
        { workspace_id: workspaceId, provider: 'google', email: row.email, role: 'member' },
        { slug: teamSlug },
      );
      if (!alive || authFailure(result)) return;
      if (!result.ok || result.data.invite === null) row.failed = true;
      else {
        row.url = result.data.invite.url;
        row.failed = false;
      }
    }
    busy = false;
    if (links.some((row) => row.failed)) await fail('onboardingInvitationsFailed');
  }
  async function copyLink(email: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      copied = '';
      await tick();
      copied = email;
    } catch {
      await fail('onboardingCopyFailed');
    }
  }
</script>

<main class="onboarding">
  <header class="onboarding-header">
    <div class="gate-brand"><BrandMark /><span class="visually-hidden">{t('appName')}</span></div>
    <LogoutButton />
  </header>
  <div class="onboarding-stage">
    <section class="onboarding-content" aria-labelledby="setup-title">
      <div class="onboarding-heading">
        <p class="onboarding-eyebrow">{t('onboardingStep', { current: step + 1, total: titles.length })}</p>
        <h1 id="setup-title" tabindex="-1" bind:this={heading}>{t(titles[step], words)}</h1>
        <p class="onboarding-lead">
          {t(
            step === 1
              ? 'onboardingProfileLead'
              : step === 2
                ? 'onboardingInviteChoiceLead'
                : step === 3
                  ? 'onboardingOrganizationLead'
                  : 'onboardingInviteLiveLead',
            words,
          )}
        </p>
      </div>
      {#if blocked}
        <div class="callout is-warn"><Icon name="alert" /><span>{t('onboardingPersonalUnavailable')}</span></div>
        <a class="btn" href={resolve('/')}>{t('onboardingReturnOrganizations')}</a>
      {:else}
        {#if error}<div class="callout is-warn" id="setup-error" role="alert" tabindex="-1" bind:this={errorBox}>
            <Icon name="alert" /><span>{t(error, words)}</span>
          </div>{/if}
        {#if step === 1}
          <form class="onboarding-fields" onsubmit={saveProfile}>
            <div class="field">
              <label class="field-label" for="setup-name">{t('onboardingName')}</label><input
                class="input"
                id="setup-name"
                bind:value={name}
                autocomplete="name"
                maxlength="200"
                readonly={busy || profileSaved}
                aria-describedby={error ? 'setup-error' : undefined}
              />
            </div>
            <div class="field">
              <label class="field-label" for="setup-title-input">{t('onboardingJob')}</label><input
                class="input"
                id="setup-title-input"
                aria-describedby={error ? 'setup-error' : undefined}
                bind:value={title}
                autocomplete="organization-title"
                maxlength="200"
                readonly={busy || profileSaved}
              />
            </div>
            <div class="field">
              <label class="field-label" for="setup-personal-slug">{t('onboardingPersonalUrl')}</label>
              <div class="onboarding-url">
                <span aria-hidden="true">{page.url.host}/</span><input
                  class="input"
                  id="setup-personal-slug"
                  bind:value={personalSlug}
                  maxlength="40"
                  spellcheck="false"
                  autocomplete="off"
                  readonly={busy || personal !== null}
                  aria-describedby={error ? 'setup-personal-hint setup-error' : 'setup-personal-hint'}
                />
              </div>
              <p class="field-hint" id="setup-personal-hint">
                {t(
                  personal === null
                    ? 'onboardingPersonalUrlLiveHint'
                    : profileSaved
                      ? 'onboardingProfileSaved'
                      : 'onboardingPersonalUrlSaved',
                )}
              </p>
            </div>
            <div class="onboarding-actions">
              <button class="btn is-primary" type="submit" aria-disabled={busy}
                >{t(busy ? 'onboardingSaving' : 'onboardingContinue')}</button
              >
            </div>
          </form>
        {:else if step === 2}
          <div class="onboarding-fields">
            <p>{t('onboardingInviteChoiceLiveNote')}</p>
            <div class="onboarding-actions">
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- finishHref は resolve() または safeReturnTo で確かめたサイト内のパス -->
              <a class="btn is-quiet" href={returnTo !== '/' ? returnTo : personalHref}
                >{t('onboardingStartPersonal')}</a
              >
              <button
                class="btn is-primary"
                type="button"
                onclick={() => {
                  withTeam = true;
                  void move(3);
                }}>{t('onboardingAddTeam')}</button
              >
            </div>
          </div>
        {:else if step === 3}
          <form class="onboarding-fields" onsubmit={createTeam}>
            <div class="field">
              <label class="field-label" for="setup-team-name">{t('onboardingOrganizationName', words)}</label><input
                class="input"
                id="setup-team-name"
                aria-describedby={error ? 'setup-error' : undefined}
                bind:value={teamName}
                maxlength="100"
                autocomplete="organization"
                readonly={busy || teamCreated}
              />
            </div>
            <div class="field">
              <label class="field-label" for="setup-team-slug">{t('onboardingTeamUrl')}</label>
              <div class="onboarding-url">
                <span aria-hidden="true">{page.url.host}/</span><input
                  class="input"
                  id="setup-team-slug"
                  aria-describedby={error ? 'setup-team-hint setup-error' : 'setup-team-hint'}
                  bind:value={teamSlug}
                  maxlength="40"
                  spellcheck="false"
                  autocomplete="off"
                  readonly={busy || teamCreated}
                />
              </div>
              <p class="field-hint" id="setup-team-hint">{t('createMyOrganizationSlugHint')}</p>
            </div>
            <p class="field-hint">{t('onboardingTeamCreateNote', words)}</p>
            <div class="onboarding-actions">
              <button class="btn is-primary" type="submit" aria-disabled={busy}
                >{t(busy ? 'onboardingSaving' : teamCreated ? 'retry' : 'onboardingCreateTeam')}</button
              >
            </div>
          </form>
        {:else if step === 4}
          <form class="onboarding-fields" onsubmit={invite}>
            <div class="field">
              <label class="field-label" for="setup-emails">{t('onboardingGoogleEmails')}</label><textarea
                class="input"
                id="setup-emails"
                bind:value={emailInput}
                rows="3"
                maxlength="6000"
                readonly={busy}
                aria-describedby={error ? 'setup-invitation-hint setup-error' : 'setup-invitation-hint'}></textarea>
              <p class="field-hint" id="setup-invitation-hint">{t('onboardingInviteLiveNote')}</p>
            </div>
            <div class="onboarding-actions">
              <button class="btn is-primary" type="submit" aria-disabled={busy}
                >{t(busy ? 'onboardingSaving' : 'onboardingCreateInvites')}</button
              >
            </div>
          </form>
          {#if links.length > 0}<div class="onboarding-fields">
              {#each links as row (row.email)}<div
                  class="field"
                  role={row.url === null ? 'group' : undefined}
                  aria-label={row.url === null ? row.email : undefined}
                >
                  {#if row.url !== null}<label class="field-label" for={`invite-${links.indexOf(row)}`}
                      >{row.email}</label
                    ><input class="input" id={`invite-${links.indexOf(row)}`} value={row.url} readonly /><button
                      class="btn"
                      type="button"
                      aria-label={`${t('onboardingCopyLink')} ${row.email}`}
                      onclick={() => copyLink(row.email, row.url!)}>{t('onboardingCopyLink')}</button
                    >
                  {:else}<p class="field-label">{row.email}</p>
                    <p class="field-hint">
                      {t(row.failed ? 'onboardingInvitationFailed' : 'onboardingSaving')}
                    </p>{/if}
                </div>{/each}
              <p class="field-hint">{t('onboardingInviteSecrets')}</p>
            </div>{/if}
          <div class="onboarding-actions">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- 上の finishHref の説明と同じ -->
            <a class="btn is-quiet" class:is-disabled={busy} aria-disabled={busy} href={busy ? undefined : finishHref}
              >{t('onboardingStartTeam')}</a
            >
          </div>
        {/if}
        {#if error && teamCreated}<a class="btn is-quiet" href={resolve('/[slug]', { slug: teamSlug })}
            >{t('onboardingOpenTeam')}</a
          >{/if}
        {#if step > 1 && !busy}<button class="btn is-quiet" type="button" onclick={() => move(step - 1)}
            >{t('onboardingBack')}</button
          >{/if}
      {/if}
      <p class="onboarding-notice wrap-anywhere" role="status">
        {busy ? t('onboardingSaving') : copied ? t('onboardingCopied', { email: copied }) : ''}
      </p>
    </section>
  </div>
  <footer class="onboarding-footer">
    <ol class="onboarding-progress" aria-label={t('onboardingProgress')}>
      {#each titles as item, index (item)}<li aria-current={index === step ? 'step' : undefined}>
          <span class="onboarding-dot" aria-hidden="true"></span><span class="visually-hidden"
            >{t('onboardingStep', { current: index + 1, total: titles.length })} {t(item, words)}</span
          >
        </li>{/each}
    </ol>
  </footer>
</main>
