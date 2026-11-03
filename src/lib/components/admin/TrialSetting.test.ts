// お試しの節（TrialSetting.svelte）の止まる日時と3つの状態を svelte/server で HTML にして確かめる。
// 期限の翌日から定期処理が止めるまでの間は days_left が負になるので、「残り -1 日」と出さないことを固定する
import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import TrialSetting from './TrialSetting.svelte';

const DateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new DateTimeFormat(locales, { ...options, timeZone: 'Asia/Tokyo' });
  });
});
afterEach(() => vi.restoreAllMocks());

const bodyOf = (days_left: number) =>
  render(TrialSetting, { props: { trial: { ends_on: '2028-03-01', days_left } } }).body.replace(/<!--.*?-->/gs, '');

test('期限の前は、ブラウザの時刻の停止日時と残りの日数を出す', () => {
  const body = bodyOf(30);
  expect(body).toContain('2028/03/02\u00a009:00 ごろに止まります');
  expect(body).not.toContain('UTC');
  expect(body).toContain('残り 30 日');
  expect(body).not.toContain('今日までです');
  expect(body).not.toContain('お試しの期限を過ぎています');
});

test('期限の当日は、「残り 0 日」ではなく「今日までです」と出す', () => {
  const body = bodyOf(0);
  expect(body).toContain('今日までです');
  expect(body).not.toContain('残り 0 日');
  expect(body).not.toContain('お試しの期限を過ぎています');
});

test.each([-1, -3])('期限を過ぎたとき（%i 日）は、日数を出さずに期限切れを形と言葉で示す', (days) => {
  const body = bodyOf(days);
  // 色だけで示さない: 同じ chip の中に、alert のアイコンと文言がそろっている
  expect(body).toMatch(
    /<span class="chip is-danger"><svg[^>]*><use href="#i-alert"><\/use><\/svg>お試しの期限を過ぎています<\/span>/,
  );
  expect(body).not.toContain('残り');
  expect(body).not.toContain('今日までです');
});
