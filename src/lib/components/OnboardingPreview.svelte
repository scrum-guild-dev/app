<script lang="ts">
  import { tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import GoogleMark from './GoogleMark.svelte';
  import Icon from './Icon.svelte';
  import { resetToDefaults } from '../organization.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';

  // 操作できる見本。API・ストレージ・クリップボードへ書き込まない。
  // 本当の登録経路とは分け、見本を終えると /signup へ戻る。
  let withTeam = $state(false);
  const titles: DictionaryKey[] = $derived([
    'onboardingAccount',
    'onboardingProfile',
    'onboardingInviteChoice',
    ...(withTeam ? (['onboardingOrganization', 'onboardingInvite'] as DictionaryKey[]) : []),
  ]);
  const leads: DictionaryKey[] = $derived([
    'onboardingAccountLead',
    'onboardingProfileLead',
    'onboardingInviteChoiceLead',
    ...(withTeam ? (['onboardingOrganizationLead', 'onboardingInviteLead'] as DictionaryKey[]) : []),
  ]);
  let step = $state(0);
  let heading = $state<HTMLHeadingElement>();
  let organization = $state('');
  let slug = $state('');
  let personalSlug = $state('');
  let name = $state('');
  let jobTitle = $state('');
  let invitations = $state('');
  let notice = $state('');
  const words = { organization: t('organization') };
  onMount(resetToDefaults);

  async function move(next: number) {
    step = Math.max(0, Math.min(titles.length - 1, next));
    notice = '';
    await tick();
    heading?.focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void move(step + 1);
  }
</script>

<main class="onboarding">
  <header class="onboarding-header">
    <div class="gate-brand"><BrandMark /><span class="visually-hidden">{t('appName')}</span></div>
    <a class="btn is-quiet" href={resolve('/signup')}>{t('onboardingExit')}</a>
  </header>
  <div class="onboarding-stage">
    <aside class="onboarding-disclosure" aria-label={t('onboardingPreview')}>
      <b>{t('onboardingPreview')}</b>
      <p>{t('onboardingDisclosure')}</p>
    </aside>
    <section class="onboarding-content" aria-labelledby="onboarding-title">
      <div class="onboarding-heading">
        <p class="onboarding-eyebrow">{t('onboardingStep', { current: step + 1, total: titles.length })}</p>
        <h1 id="onboarding-title" tabindex="-1" bind:this={heading}>{t(titles[step], words)}</h1>
        <p class="onboarding-lead">{t(leads[step], words)}</p>
      </div>

      {#if step === 0}
        <div class="onboarding-fields">
          <button class="btn is-wide is-google" type="button" onclick={() => move(1)}
            ><GoogleMark />{t('onboardingGoogle')}</button
          >
          <button class="btn is-wide" type="button" onclick={() => move(1)}
            ><Icon name="git" />{t('onboardingGithubAccount')}</button
          >
          <p class="field-hint">{t('onboardingAuthNote')}</p>
        </div>
      {:else if step === 1}
        <form class="onboarding-fields" onsubmit={submit}>
          <div class="field">
            <label class="field-label" for="onboarding-name">{t('onboardingName')}</label>
            <div class="onboarding-profile">
              <span class="onboarding-avatar" aria-hidden="true"><Icon name="users" /></span><input
                class="input"
                id="onboarding-name"
                bind:value={name}
                placeholder={t('onboardingNameExample')}
                maxlength="100"
              />
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="onboarding-job">{t('onboardingJob')}</label><input
              class="input"
              id="onboarding-job"
              bind:value={jobTitle}
              placeholder={t('onboardingJobExample')}
              maxlength="100"
            />
          </div>
          <p class="field-hint">{t('onboardingProfileNote')}</p>
          <div class="field">
            <label class="field-label" for="onboarding-personal-slug">{t('onboardingPersonalUrl')}</label>
            <div class="onboarding-url">
              <span aria-hidden="true">scrum-guild /</span><input
                class="input"
                id="onboarding-personal-slug"
                bind:value={personalSlug}
                placeholder="yui"
                maxlength="63"
                spellcheck="false"
                aria-describedby="onboarding-personal-url-hint"
              />
            </div>
            <p class="field-hint" id="onboarding-personal-url-hint">{t('onboardingPersonalUrlHint')}</p>
          </div>
          <div class="onboarding-actions">
            <button class="btn is-primary" type="submit">{t('onboardingContinue')}</button>
          </div>
        </form>
      {:else if step === 2}
        <div class="onboarding-fields">
          <p>{t('onboardingInviteChoiceNote')}</p>
          <div class="onboarding-actions">
            <a class="btn is-quiet" href={resolve('/signup')}>{t('onboardingNoTeam')}</a>
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
        <form class="onboarding-fields" onsubmit={submit}>
          <div class="field">
            <label class="field-label" for="onboarding-organization">{t('onboardingOrganizationName', words)}</label>
            <input
              class="input"
              id="onboarding-organization"
              bind:value={organization}
              placeholder={t('onboardingOrganizationExample')}
              maxlength="100"
            />
          </div>
          <div class="field">
            <label class="field-label" for="onboarding-slug">{t('onboardingTeamUrl')}</label>
            <div class="onboarding-url">
              <span aria-hidden="true">scrum-guild /</span><input
                class="input"
                id="onboarding-slug"
                bind:value={slug}
                placeholder="hibari"
                aria-describedby="onboarding-url-hint"
                maxlength="63"
                spellcheck="false"
              />
            </div>
            <p class="field-hint" id="onboarding-url-hint">{t('onboardingUrlHint')}</p>
          </div>
          <p class="field-hint">
            {t('onboardingOrganizationNote', words)}
          </p>
          <div class="onboarding-actions">
            <button class="btn is-primary is-wide" type="submit">{t('onboardingCreatePreview')}</button>
          </div>
        </form>
      {:else if step === 4}
        <div class="onboarding-fields">
          <div class="field">
            <label class="field-label" for="onboarding-invitations">{t('onboardingInviteLabel')}</label><textarea
              class="input"
              id="onboarding-invitations"
              bind:value={invitations}
              rows="3"
              placeholder="yui@example.com, ren@example.com"
              aria-describedby="onboarding-invite-hint"
              maxlength="2000"></textarea>
            <p class="field-hint" id="onboarding-invite-hint">{t('onboardingInviteNote')}</p>
          </div>
          <button class="btn is-quiet" type="button" onclick={() => (notice = t('onboardingLinkNote'))}
            ><Icon name="link" />{t('onboardingLinkPreview')}</button
          >
          <div class="onboarding-actions">
            <a class="btn is-quiet" href={resolve('/signup')}>{t('onboardingSkipFinish')}</a>
            <a class="btn is-primary" href={resolve('/signup')}>{t('onboardingFinish')}</a>
          </div>
        </div>
      {/if}
      <p class="onboarding-notice" role="status">{notice}</p>
    </section>
  </div>
  <footer class="onboarding-footer">
    <button class="btn is-quiet" type="button" aria-disabled={step === 0} onclick={() => step > 0 && move(step - 1)}
      >{t('onboardingBack')}</button
    >
    <ol class="onboarding-progress" aria-label={t('onboardingProgress')}>
      {#each titles as title, index (title)}
        <li aria-current={index === step ? 'step' : undefined}>
          <span class="onboarding-dot" aria-hidden="true"></span><span class="visually-hidden"
            >{t('onboardingStep', { current: index + 1, total: titles.length })} {t(title, words)}</span
          >
        </li>
      {/each}
    </ol>
  </footer>
</main>
