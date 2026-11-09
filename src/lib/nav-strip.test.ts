import { describe, expect, it } from 'vitest';
import { NAV_STRIP_EDGE_SLACK, NAV_STRIP_PEEK, navStripEdges, navStripScrollLeft } from './nav-strip.ts';

const view = { scrollLeft: 0, left: 16, width: 358 };

describe('navStripScrollLeft', () => {
  it('今のページの項目が見えていれば送らない', () => {
    expect(navStripScrollLeft(view, { left: 16, right: 120 }, null)).toBeNull();
    expect(navStripScrollLeft(view, { left: 200, right: 374 - NAV_STRIP_PEEK }, null)).toBeNull();
  });

  it('右端の幕（peek の幅）に重なる項目は、見えているとみなさず送る', () => {
    expect(navStripScrollLeft(view, { left: 300, right: 374 - NAV_STRIP_PEEK + 1 }, null)).toBe(
      300 - 16 - NAV_STRIP_PEEK,
    );
  });

  it('左に送ってあるときは、左端の幕（peek の幅）に重なる項目を見えているとみなさず送る', () => {
    expect(navStripScrollLeft({ ...view, scrollLeft: 200 }, { left: 20, right: 120 }, null)).toBe(200 + 20 - 16 - 32);
  });

  it('左に送ったかの境目は続きの印と同じ遊び: 1px までは左の幕が無いとみなし、それを超えたら peek を残す', () => {
    const item = { left: 20, right: 120 };
    expect(navStripScrollLeft({ ...view, scrollLeft: NAV_STRIP_EDGE_SLACK }, item, null)).toBeNull();
    expect(navStripEdges(NAV_STRIP_EDGE_SLACK, 358, 1100).start).toBe(false);
    // 送り量が 1.5px しか無いので、幕を避けて送ると先頭（0）まで戻り、左の幕も消える
    expect(navStripScrollLeft({ ...view, scrollLeft: 1.5 }, item, null)).toBe(0);
    expect(navStripEdges(1.5, 358, 1100).start).toBe(true);
  });

  it('先頭（送っていない）なら左端に幕は出ないので、左端ちょうどの項目は送らない', () => {
    expect(navStripScrollLeft(view, { left: 16, right: 120 }, null)).toBeNull();
  });

  it('peek を省くと NAV_STRIP_PEEK（見本の kit.js と同じ 32px）を使う', () => {
    expect(NAV_STRIP_PEEK).toBe(32);
    expect(navStripScrollLeft(view, { left: 945, right: 1040 }, null)).toBe(945 - 16 - 32);
  });

  it('札から項目までが、両端の peek を除いた幅ちょうどなら札を基準にし、1px 超えたら項目を基準にする', () => {
    const fits = 358 - 2 * 32;
    expect(navStripScrollLeft(view, { left: 600, right: 480 + fits }, { left: 480, right: 590 }, 32)).toBe(
      480 - 16 - 32,
    );
    expect(navStripScrollLeft(view, { left: 600, right: 480 + fits + 1 }, { left: 480, right: 590 }, 32)).toBe(
      600 - 16 - 32,
    );
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

  it('1px の遊びの境界: 左は 1px までは続き無し、それを超えたら続きあり', () => {
    expect(navStripEdges(1, 358, 1100).start).toBe(false);
    expect(navStripEdges(1.5, 358, 1100).start).toBe(true);
  });

  it('1px の遊びの境界: 右は末尾から 1px 以内なら続き無し', () => {
    expect(navStripEdges(1100 - 358 - 1, 358, 1100).end).toBe(false);
    expect(navStripEdges(1100 - 358 - 1.5, 358, 1100).end).toBe(true);
  });

  it('はみ出さない帯（広い幅の縦の列）はどちらにも続きが無い', () => {
    expect(navStripEdges(0, 240, 240)).toEqual({ start: false, end: false });
  });
});
