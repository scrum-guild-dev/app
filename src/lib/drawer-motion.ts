// 前後移動は同じ更新の中で古い引き出しを外し、新しい引き出しを置く。
// その置き直しには出現を付けず、いったん閉じて次に開いたときだけ付ける。
let mounted = false;
let generation = 0;

export function drawerMotion(node: HTMLElement, scrim: HTMLElement | undefined) {
  const entering = !mounted && !node.classList.contains('is-page');
  mounted = true;
  const ownGeneration = ++generation;
  if (entering) {
    node.classList.add('is-motion');
    scrim?.classList.add('is-motion');
  }
  return {
    update(nextScrim: HTMLElement | undefined) {
      if (entering) nextScrim?.classList.add('is-motion');
    },
    destroy() {
      queueMicrotask(() => {
        if (generation === ownGeneration) mounted = false;
      });
    },
  };
}
