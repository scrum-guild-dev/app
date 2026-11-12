// スマホの画面の移り変わりで、本文を短く入れ替える（View Transitions）かを決める。
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
