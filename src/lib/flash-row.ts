import { prefersReducedMotion } from './reduced-motion.ts';
import { FLASH_MS } from './flash-duration.ts';

// 成功後の描画に付ける時刻。古い印を持った行が再び置かれても光らせない。
// CSS の演出が終わるまで、共有する FLASH_MS の間だけ印を残す。
export function flashRow(node: HTMLElement, stamp = 0) {
  let current = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let ownsClass = false;

  function clear() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    clearTimeout(timer);
    if (ownsClass) node.classList.remove('is-dropped');
    ownsClass = false;
  }

  function update(next = 0) {
    if (next === current) return;
    current = next;
    clear();
    if (next <= 0 || performance.now() - next > FLASH_MS || prefersReducedMotion()) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (prefersReducedMotion()) return;
        node.classList.add('is-dropped');
        ownsClass = true;
        timer = setTimeout(clear, FLASH_MS);
      });
    });
  }

  update(stamp);
  return { update, destroy: clear };
}
