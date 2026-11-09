import { describe, expect, test, vi } from 'vitest';

function element(...classes: string[]) {
  const names = new Set(classes);
  return {
    classList: { add: (name: string) => names.add(name), contains: (name: string) => names.has(name) },
  } as unknown as HTMLElement;
}

describe('引き出しの出現', () => {
  test('前後への置き直しでは動かさず、閉じた後の再開では動かす', async () => {
    vi.resetModules();
    const { drawerMotion } = await import('./drawer-motion.ts');
    const first = element();
    const firstAction = drawerMotion(first, element());
    expect(first.classList.contains('is-motion')).toBe(true);
    firstAction.destroy();
    const next = element();
    const nextAction = drawerMotion(next, element());
    await Promise.resolve();
    expect(next.classList.contains('is-motion')).toBe(false);
    nextAction.destroy();
    await Promise.resolve();
    const reopened = element();
    drawerMotion(reopened, element()).destroy();
    expect(reopened.classList.contains('is-motion')).toBe(true);
  });

  test('ページ全体は動かさず、遅れて束縛された幕にも最初の出現を付ける', async () => {
    vi.resetModules();
    const { drawerMotion } = await import('./drawer-motion.ts');
    const page = element('is-page');
    drawerMotion(page, undefined).destroy();
    expect(page.classList.contains('is-motion')).toBe(false);
    await Promise.resolve();
    const action = drawerMotion(element(), undefined);
    const scrim = element();
    action.update(scrim);
    expect(scrim.classList.contains('is-motion')).toBe(true);
    action.destroy();
  });
});
