// スマホの画面の移り変わりで、画面を短く入れ替える（View Transitions）かを決め、入れ替えを始める。
// 戻る・進む（popstate）は、iOS の端からのスワイプが自前の動きを持ち、重ねると二重に動くので入れ替えない。
// 同じ画面の中の移動（?task= で引き出しを開くなど）も、本文が替わらないので入れ替えない。
export type NavigationFadeInput = {
  narrow: boolean;
  reducedMotion: boolean;
  supported: boolean;
  type: string;
  from: string | undefined;
  to: string | undefined;
};

export function shouldFadeNavigation(input: NavigationFadeInput): boolean {
  if (!input.narrow || input.reducedMotion || !input.supported) return false;
  if (input.type !== 'link' && input.type !== 'goto') return false;
  if (!input.from || !input.to) return false;
  return input.from !== input.to;
}

type Transition = { finished: Promise<unknown>; ready: Promise<unknown> };
type StartTransition = (update: () => Promise<void>) => Transition;

// onNavigate に返す Promise。解けると SvelteKit が新しい画面を描き、描き終える（complete）まで入れ替えの「後」の画像を待つ。
// 中断や失敗した移動では入れ替えをやめるだけにし、拒否を外へ漏らさない（漏れると画面のエラーの報告に載る）
export function startNavigationFade(complete: Promise<unknown>, start: StartTransition): Promise<void> {
  return new Promise<void>((ready) => {
    const transition = start(async () => {
      ready();
      await complete.catch(() => {});
    });
    transition.finished.catch(() => {});
    transition.ready.catch(() => {});
  });
}
