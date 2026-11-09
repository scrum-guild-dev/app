import { describe, expect, it } from 'vitest';
import { navStripEdges, navStripScrollLeft } from './nav-strip.ts';

const view = { scrollLeft: 0, left: 16, width: 358 };

describe('navStripScrollLeft', () => {
  it('今のページの項目が見えていれば送らない', () => {
    expect(navStripScrollLeft(view, { left: 16, right: 120 }, null)).toBeNull();
    expect(navStripScrollLeft(view, { left: 300, right: 374 }, null)).toBeNull();
  });

  it('右にはみ出した項目は、手前の項目を少し残して左に寄せる', () => {
    expect(navStripScrollLeft(view, { left: 945, right: 1040 }, null, 32)).toBe(945 - 16 - 32);
  });

  it('既に送った帯でも、今の送り量に足して求める', () => {
    expect(navStripScrollLeft({ ...view, scrollLeft: 200 }, { left: -100, right: -20 }, null, 32)).toBe(200 - 116 - 32);
  });

  it('ワークスペースの札から項目までが収まるなら、札も見える位置まで送る', () => {
    expect(navStripScrollLeft(view, { left: 600, right: 700 }, { left: 480, right: 590 }, 32)).toBe(480 - 16 - 32);
  });

  it('項目が見えていても、収まるはずの札が左に隠れていれば札まで送り直す', () => {
    expect(
      navStripScrollLeft({ ...view, scrollLeft: 300 }, { left: 48, right: 170 }, { left: -110, right: 40 }, 32),
    ).toBe(300 - 110 - 16 - 32);
  });

  it('札も項目も見えていれば送らない', () => {
    expect(navStripScrollLeft(view, { left: 180, right: 300 }, { left: 20, right: 170 }, 32)).toBeNull();
  });

  it('札から項目までが帯に収まらなければ、項目を基準にする', () => {
    expect(navStripScrollLeft(view, { left: 900, right: 1000 }, { left: 480, right: 590 }, 32)).toBe(900 - 16 - 32);
  });

  it('札が項目より後ろにあるときは札を使わない', () => {
    expect(navStripScrollLeft(view, { left: 400, right: 480 }, { left: 500, right: 600 }, 32)).toBe(400 - 16 - 32);
  });

  it('負の送り量にしない', () => {
    expect(navStripScrollLeft({ ...view, scrollLeft: 10 }, { left: -5, right: 60 }, null, 32)).toBe(0);
  });
});

describe('navStripEdges', () => {
  it('先頭では左に続きが無く、右に続きがある', () => {
    expect(navStripEdges(0, 358, 1100)).toEqual({ start: false, end: true });
  });

  it('途中では両方に続きがある', () => {
    expect(navStripEdges(300, 358, 1100)).toEqual({ start: true, end: true });
  });

  it('末尾では右に続きが無い。小数の誤差は端とみなす', () => {
    expect(navStripEdges(741.5, 358, 1100)).toEqual({ start: true, end: false });
  });

  it('はみ出さない帯（広い幅の縦の列）はどちらにも続きが無い', () => {
    expect(navStripEdges(0, 240, 240)).toEqual({ start: false, end: false });
  });
});
