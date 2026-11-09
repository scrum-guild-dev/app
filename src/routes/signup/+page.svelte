<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import BrandMark from '../../lib/components/BrandMark.svelte';
  import { onMount } from 'svelte';
  import { resetToDefaults } from '../../lib/organization.svelte.ts';
  import { RETURN_TO_MAX_LENGTH } from '../../shared/return-to.ts';
  import { setupReturnTo } from '../../lib/onboarding.ts';
  import GoogleMark from '../../lib/components/GoogleMark.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LegalLinks from '../../lib/components/LegalLinks.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';

  // 会員登録の画面（枠の外）。招待の無い人が GitHub か Google でアカウントを作る。パスワードの欄は無い。
  // ログインの画面と同じく、開始は GET のリダイレクトなので、ボタンはリンクにして画面の遷移を通さず直に開く。
  // 開始の URL に signup=1 を付けると、サーバーが往復に登録の印を付ける（src/server/auth/login-routes.ts）。
  // 登録後は /auth/setup を通り、導入の後に return_to（安全なサイト内パス）へ戻る。
  // 往復の失敗（?error=）はサーバーがログインの画面へ戻すので、この画面は error を出さない
  const returnTo = $derived(setupReturnTo(page.url.searchParams.get('return_to')));
  const setupHref = $derived.by(() => {
    const path = `${resolve('/auth/setup')}${returnTo === '/' ? '' : `?return_to=${encodeURIComponent(returnTo)}`}`;
    return path.length <= RETURN_TO_MAX_LENGTH ? path : resolve('/auth/setup');
  });
  const startQuery = $derived(`signup=1&return_to=${encodeURIComponent(setupHref)}`);
  onMount(resetToDefaults);
  const githubStartHref = $derived(`/api/auth/github/start?${startQuery}`);
  const googleStartHref = $derived(`/api/auth/google/start?${startQuery}`);

  let moving = $state<'github' | 'google' | null>(null);
  function startExternal(event: MouseEvent, provider: 'github' | 'google'): void {
    if (moving) {
      event.preventDefault();
      return;
    }
    // 別のタブやウィンドウで開くときは、この画面を待機中にしない。
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    moving = provider;
  }

  function restore(event: PageTransitionEvent): void {
    if (event.persisted) moving = null;
  }

  // ログインの画面へ戻る。戻り先が `/` でなければ引き継ぐ
  const loginQuery = $derived(returnTo === '/' ? '' : `?return_to=${encodeURIComponent(returnTo)}`);

  // ほかの文言に混ぜる言葉。organization は辞書の項目
  const words = $derived({ organization: t('organization') });
</script>

<svelte:window onpageshow={restore} />

<svelte:head>
  <title>{t('pageTitle', { page: t('signupTitle'), app: t('appName') })}</title>
</svelte:head>

<main class="onboarding">
  <header class="onboarding-header">
    <div class="gate-brand"><BrandMark /><span class="visually-hidden">{t('appName')}</span></div>
  </header>
  <div class="onboarding-stage">
    <section class="onboarding-content" aria-labelledby="signup-title">
      <div class="onboarding-heading"><h1 id="signup-title">{t('signupTitle')}</h1></div>
      <p>{t('signupLead', words)}</p>
      <!-- 画面の経路ではなく Worker の GET。resolve() は経路の ID を要るので通さず、data-sveltekit-reload で直に開く -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a
        class="btn is-wide"
        href={githubStartHref}
        data-sveltekit-reload
        aria-disabled={moving !== null}
        onclick={(event) => startExternal(event, 'github')}
        ><Icon name="git" />{moving === 'github' ? t('authMoving') : t('signupWithGithub')}</a
      >
      <a
        class="btn is-wide is-google"
        href={googleStartHref}
        data-sveltekit-reload
        aria-disabled={moving !== null}
        onclick={(event) => startExternal(event, 'google')}
        ><GoogleMark />{moving === 'google' ? t('authMoving') : t('signupWithGoogle')}</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
      <p class="gate-note">{t('signupNote', words)}</p>
      <div class="form-actions">
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- 経路は resolve() で解決し、引き継ぐ return_to のクエリだけを足している -->
        <a class="btn is-sm is-quiet" href={`${resolve('/login')}${loginQuery}`}>{t('signupLoginLink')}</a>
      </div>
      <a class="btn is-sm is-quiet" href={resolve('/signup/preview')}>{t('onboardingOpen')}</a>
      <LegalLinks />
    </section>
  </div>
</main>
