import { prefersReducedMotion } from './reduced-motion.ts';

type StepState = { key: string; done: boolean };

// 完了の判定はサーバーに任せ、同じタブで前回見た状態だけを覚える。
// 利用者・組織・ロール・手順を呼び出し側の key で分ける。
export function firstStepMotion(node: HTMLElement, initial: StepState) {
  function read(state: StepState): boolean {
    try {
      const saved = window.sessionStorage.getItem(`first-step-motion:${state.key}`);
      if (saved === 'true' || saved === 'false') return saved === 'true';
    } catch {
      // 保存を使えないときは初期済みを動かさず、表示中の変化だけを追う。
    }
    return state.done;
  }

  let key = initial.key;
  let previous = read(initial);
  const finish = () => node.classList.remove('is-new');
  function update(state: StepState) {
    if (state.key !== key) {
      key = state.key;
      previous = read(state);
      finish();
    }
    if (state.done !== previous) {
      node.classList.toggle('is-new', state.done && !prefersReducedMotion());
    }
    previous = state.done;
    try {
      window.sessionStorage.setItem(`first-step-motion:${key}`, String(state.done));
    } catch {
      // 演出の記録に失敗しても、手順の状態と操作は変えない。
    }
  }
  node.addEventListener('animationend', finish);
  node.addEventListener('animationcancel', finish);
  update(initial);
  return {
    update,
    destroy() {
      node.removeEventListener('animationend', finish);
      node.removeEventListener('animationcancel', finish);
    },
  };
}
