<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { operationPath } from '../../shared/operations/define.ts';
  import { meThemeUpdate, organizationInfo } from '../../shared/operations/organization/index.ts';
  import { themeLabelKeys, themeNoteKeys, themes, type Theme } from '../../shared/theme.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { setTheme } from '../theme.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import Setting from './Setting.svelte';

  // マイプロフィールの画面（me.html）の「テーマ」の節。4つのテーマから選ぶ。組織の既定は無く、自分で選ぶだけ。
  // 選んだ瞬間に保存して画面に当てる（自分の見た目だけで、組織のほかの人には効かない）。
  // 値は組織の枠が読んだ自分のテーマ（theme。選んでいなければ simple）を受け取り、節は自分で読まない。
  // 選ぶと、先に画面へ当て（setTheme。localStorage にも覚える）、me-theme-update を送る。通ったら組織の枠を読み直して、枠の値を今の値にそろえる。
  // 失敗したら選択と画面を送る前の値に戻し、理由を節の中（role="alert"）に出す（401 はログインへ）。
  // 送っている間（枠の読み直しの間を含む）にまた選んだら、送り終えてから最後に選んだ値を送る（古い応答で選択が戻らず、同時に2つ送らない）。
  // 変更の履歴には残らない（API が書かない）
  let { slug, theme }: { slug: string; theme: Theme } = $props();

  const ids = $props.id();
  // 最後に保存できた値と、画面に出している選択
  let saved = $state<Theme>(untrack(() => theme));
  let chosen = $state<Theme>(untrack(() => theme));
  let sending = $state(false);
  // 失敗の理由。次に選ぶまで残す（消えると、失敗したのか未操作なのか分からない）
  let error = $state<string | null>(null);
  // 保存できた値を読み上げに伝える
  let announcement = $state('');

  // 組織の枠の値が替わったとき（画面の移動、読み直し）に、選択を合わせる。送っている間は触らない
  $effect.pre(() => {
    void slug;
    const current = theme;
    if (untrack(() => sending)) return;
    saved = current;
    chosen = current;
    error = null;
    announcement = '';
  });

  function choose(value: Theme): void {
    if (chosen === value) return;
    chosen = value;
    error = null;
    announcement = '';
    setTheme(value);
    if (!sending) void flush();
  }

  // 送っている間に別の組織へ移った。$effect.pre は送っている間は合わせず、終わった後も再実行されないので、ここで今の組織の値に合わせる
  function resync(): void {
    saved = theme;
    chosen = theme;
    error = null;
    announcement = '';
  }

  async function flush(): Promise<void> {
    const sentSlug = slug;
    sending = true;
    try {
      // 枠を読み直している間に選び直されたら、その値も送る（読み直しの後に chosen と saved を見直す）
      do {
        while (chosen !== saved) {
          const value = chosen;
          const result = await callOperation(meThemeUpdate, { theme: value }, { slug: sentSlug });
          if (sentSlug !== slug) {
            resync();
            return;
          }
          if (!result.ok && isUnauthenticated(result)) {
            window.location.assign(loginUrl(page.url));
            return;
          }
          if (!result.ok) {
            // 選択と画面を、最後に保存できた値へ戻す
            chosen = saved;
            setTheme(saved);
            error = t('meThemeFailed');
            return;
          }
          saved = value;
          announcement = t('meThemeChanged', { label: t(themeLabelKeys[value]) });
        }
        // 組織の枠の自分のテーマを読み直す（別の画面から戻ったとき、古い値を見せないため）。この画面の他の節は読み直さない
        const path = operationPath(organizationInfo, sentSlug);
        await invalidate((url) => url.pathname === path);
        // 読み直している間に別の組織へ移っていたら、選択を移った先の値に合わせ直す
        if (sentSlug !== slug) {
          resync();
          return;
        }
      } while (chosen !== saved);
    } finally {
      sending = false;
    }
  }
</script>

<Setting title={t('themeLabel')} description={t('meThemeDesc')}>
  <div class="choice-list" role="radiogroup" aria-label={t('themeLabel')}>
    {#each themes as value (value)}
      <label class="choice">
        <input type="radio" name="{ids}-theme" {value} checked={chosen === value} onchange={() => choose(value)} />
        <div><b>{t(themeLabelKeys[value])}</b><span>{t(themeNoteKeys[value])}</span></div>
      </label>
    {/each}
  </div>
  <!-- 失敗の理由。領域は常に置き、中の文字だけを替える -->
  <div role="alert">
    {#if error !== null}<span class="field-error"><Icon name="alert" />{error}</span>{/if}
  </div>
  <!-- 送っている間と保存できたことの読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{sending ? t('meThemeSaving') : announcement}</span>
</Setting>
