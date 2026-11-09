import { prefersReducedMotion } from './reduced-motion.ts';

// 成功後の描画に付ける時刻。古い印を持った行が再び置かれても光らせない。
// CSS の --duration-flash（800ms）が終わるまで、印を900ms残す。
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
    if (next <= 0 || performance.now() - next > 900 || prefersReducedMotion()) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (prefersReducedMotion()) return;
        node.classList.add('is-dropped');
        ownsClass = true;
        timer = setTimeout(clear, 900);
      });
    });
  }

  update(stamp);
  return { update, destroy: clear };
}
