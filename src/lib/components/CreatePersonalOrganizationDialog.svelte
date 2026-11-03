<script lang="ts">
  import { tick } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import {
    createPersonalOrganizationFailure,
    validateCreatePersonalOrganization,
    type CreatePersonalOrganizationFailure,
  } from '../create-personal-organization-form.ts';
  import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { createPersonalOrganization } from '../../shared/operations/organization/index.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // design/kit.js の createPersonalOrganization。会員が自分だけで使う組織（自分用）を作る。入れるのは slug だけで、名前は固定の「自分用」。
  // slug は後から変えられないので、規則と「あとから変えられません」、できあがる URL を欄の下に常に出す（aria-describedby で結ぶ）。
  // 作れたら、その組織（/<slug>）へ画面ごと移る。作っている間は入力を読み取り専用にし、閉じる操作を無視する（応答を見失わない）
  let { open = $bindable(false) }: { open?: boolean } = $props();

  let dialog = $state<ReturnType<typeof Dialog>>();
  let slug = $state('');
  let busy = $state(false);
  let error = $state<CreatePersonalOrganizationFailure | null>(null);
  let slugInput = $state<HTMLInputElement>();
  let formCallout = $state<HTMLElement>();

  const words = $derived({
    organization: t('organization'),
    admin: t('admin'),
    url: `${page.url.host}/${slug.trim() === '' ? '<slug>' : slug.trim()}/`,
  });
  const slugDescribedBy = $derived(
    error?.field === 'slug'
      ? 'create-personal-organization-slug-error create-personal-organization-slug-hint create-personal-organization-slug-url'
      : 'create-personal-organization-slug-hint create-personal-organization-slug-url',
  );

  export function show(trigger?: HTMLElement | null): void {
    dialog?.show(trigger);
  }

  function reset(): void {
    slug = '';
    error = null;
    busy = false;
  }

  $effect(() => {
    void open;
    reset();
  });

  async function focusError(field: CreatePersonalOrganizationFailure['field']): Promise<void> {
    await tick();
    (field === 'slug' ? slugInput : formCallout)?.focus();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const invalid = validateCreatePersonalOrganization({ slug });
    if (invalid !== null) {
      error = invalid;
      await focusError(invalid.field);
      return;
    }
    error = null;
    busy = true;
    const result = await callOperation(createPersonalOrganization, { slug: slug.trim() });
    if (result.ok) {
      window.location.assign(`/${result.data.slug}`);
      return;
    }
    busy = false;
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (isTermsRequired(result)) {
      window.location.assign(consentUrl(page.url));
      return;
    }
    const failure = createPersonalOrganizationFailure(result);
    error = failure;
    await focusError(failure.field);
  }

  // かな漢字変換の確定の Enter では送らない（isComposing、古い Safari は keyCode 229）
  function submitOnEnter(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!busy} title={t('createPersonalOrganizationTitle', words)}>
  <!-- 読み上げの領域。常に置き、文字だけを替える（後から挿入した領域は読み上げられないことがある） -->
  <div class="visually-hidden" role="status">{busy ? t('createPersonalOrganizationSubmitting', words) : ''}</div>
  <p>{t('createPersonalOrganizationLead', words)}</p>
  <div class="field" class:is-invalid={error?.field === 'slug'}>
    <label class="field-label" for="create-personal-organization-slug">{t('createMyOrganizationSlugLabel')}</label>
    <input
      bind:this={slugInput}
      class="input mono"
      id="create-personal-organization-slug"
      bind:value={slug}
      placeholder={t('createMyOrganizationSlugExample')}
      autocomplete="off"
      spellcheck="false"
      aria-invalid={error?.field === 'slug' ? 'true' : undefined}
      aria-describedby={slugDescribedBy}
      readonly={busy}
      oninput={() => (error = null)}
      onkeydown={submitOnEnter}
    />
    {#if error?.field === 'slug'}<span class="field-error" id="create-personal-organization-slug-error" role="alert"
        ><Icon name="alert" />{t(error.key, words)}</span
      >{/if}
    <span class="field-hint" id="create-personal-organization-slug-hint">{t('createMyOrganizationSlugHint')}</span>
    <span class="field-hint" id="create-personal-organization-slug-url">{t('createMyOrganizationSlugUrl', words)}</span>
  </div>
  {#if error?.field === 'form'}<div bind:this={formCallout} class="callout is-warn" role="alert" tabindex="-1">
      <Icon name="alert" /><span
        >{t(error.key, words)}{#if error.key === 'createPersonalOrganizationLimit'}
          <a href={resolve('/')} data-sveltekit-reload>{t('createMyOrganizationTrialLimitLink', words)}</a>{/if}</span
      >
    </div>{/if}
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={busy} onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="button" aria-disabled={busy} onclick={() => void submit()}
      >{busy ? t('createPersonalOrganizationSubmitting', words) : t('createPersonalOrganizationSubmit', words)}</button
    >
  {/snippet}
</Dialog>
