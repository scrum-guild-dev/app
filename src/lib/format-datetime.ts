const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

// 日時の表示。DB の日時は UTC の ISO 文字列で、画面はブラウザのタイムゾーンで出す（docs/requirements.md の「日付と時刻」）。
// timeZone を渡すと、そのタイムゾーンで出す（テスト用。省略はブラウザのタイムゾーン）。
// 日時として読めない値は、受け取った文字列のまま返す
export function formatDateTime(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  // 日付と時刻の間は折り返さない空白にする（狭い幅で、日付と時刻が別の行に割れない）
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  })
    .format(time)
    .replace(/\s/, NO_BREAK_SPACE);
}

// お試しは UTC の期限日の翌日 0 時から、毎時の定期処理で止まる。
export function formatTrialStopDateTime(endsOn: string, timeZone?: string): string {
  const date = new Date(`${endsOn}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return formatDateTime(date.toISOString(), timeZone);
}

// 今日やることの見出しの上に出す今日の日付（「2026年10月20日（火）」。見本の todayLabel と同じ形）。
// 画面はワークスペースをまたぐので、ワークスペースのタイムゾーンではなく、ブラウザのタイムゾーンの今日を出す
// （docs/design.md の今日やることの画面）。timeZone を渡すと、そのタイムゾーンで出す（テスト用）
export function formatTodayLabel(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}年${part('month')}月${part('day')}日（${part('weekday')}）`;
}
