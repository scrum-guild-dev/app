import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatDateTime, formatTrialStopDateTime } from '../src/lib/format-datetime.ts';

// 日付と時刻の間は、折り返さない空白（U+00A0）
const NBSP = String.fromCodePoint(0x00a0);

describe('日時の表示', () => {
  test('UTC の ISO 文字列を、指したタイムゾーンの日付と時刻で出す', () => {
    assert.equal(formatDateTime('2026-10-01T09:30:00.000Z', 'Asia/Tokyo'), `2026/10/01${NBSP}18:30`);
    assert.equal(formatDateTime('2026-10-01T09:30:00.000Z', 'UTC'), `2026/10/01${NBSP}09:30`);
  });

  test('日付をまたぐときは、日付も指したタイムゾーンのものになる', () => {
    assert.equal(formatDateTime('2026-10-01T20:05:00.000Z', 'Asia/Tokyo'), `2026/10/02${NBSP}05:05`);
  });

  test('日付と時刻の間以外に、折り返せる空白は無い', () => {
    assert.doesNotMatch(formatDateTime('2026-10-01T09:30:00.000Z', 'UTC'), / /);
  });

  test('読めない値は、そのまま返す', () => {
    assert.equal(formatDateTime('not a date'), 'not a date');
  });
});

describe('お試しが止まる日時の表示', () => {
  test('期限の翌日の UTC 0 時を、それぞれのタイムゾーンで出す', () => {
    assert.equal(formatTrialStopDateTime('2026-11-30', 'Asia/Tokyo'), `2026/12/01${NBSP}09:00`);
    assert.equal(formatTrialStopDateTime('2026-11-30', 'UTC'), `2026/12/01${NBSP}00:00`);
    assert.equal(formatTrialStopDateTime('2026-11-30', 'America/Los_Angeles'), `2026/11/30${NBSP}16:00`);
  });

  test('年末とうるう日、夏時間の境界でも UTC で翌日を求める', () => {
    assert.equal(formatTrialStopDateTime('2026-12-31', 'Asia/Tokyo'), `2027/01/01${NBSP}09:00`);
    assert.equal(formatTrialStopDateTime('2028-02-28', 'Asia/Tokyo'), `2028/02/29${NBSP}09:00`);
    assert.equal(formatTrialStopDateTime('2028-02-29', 'Asia/Tokyo'), `2028/03/01${NBSP}09:00`);
    assert.equal(formatTrialStopDateTime('2026-03-08', 'America/Los_Angeles'), `2026/03/08${NBSP}17:00`);
  });
});
