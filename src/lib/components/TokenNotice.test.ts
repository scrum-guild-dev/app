import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import { formatDateTime } from '../format-datetime.ts';
import TokenNotice from './TokenNotice.svelte';

vi.mock('$app/paths', () => ({
  resolve: (route: string, params: { slug: string }) => route.replace('[slug]', params.slug),
}));
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));

const latest = { name: '手元の CLI', scope: 'write' as const, created_at: '2026-11-04T01:30:00.000Z', revoked: false };
const body = (notice: { count: number; latest: typeof latest | null } | null) =>
  render(TokenNotice, { props: { notice, slug: 'aoba' } }).body;

test('未確認が無ければ帯も操作も出さない', () => {
  expect(body({ count: 0, latest: null })).not.toContain('token-notice');
});
test('件数と最新の名前・範囲・日時、設定への導線と確認を出す', () => {
  const html = body({ count: 3, latest });
  expect(html).toContain('未確認の API トークンの発行が3件あります');
  expect(html).toContain('手元の CLI / 書き込み');
  expect(html).toContain(formatDateTime(latest.created_at));
  expect(html).toContain('href="/aoba/me#api-tokens"');
  expect(html).toContain('確かめた');
  expect(html).not.toContain('取り消し済み');
});
test('取り消し済みの最新の発行を明示し、読み取りの範囲も出す', () => {
  const html = body({ count: 1, latest: { ...latest, scope: 'read' as never, revoked: true } });
  expect(html).toContain('手元の CLI / 読み取り');
  expect(html).toContain('取り消し済み');
});
test('名前はHTMLとして解釈しない', () => {
  const html = body({ count: 1, latest: { ...latest, name: '<script>alert(1)</script>' } });
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script>');
});
test('読み取りに失敗したら再試行を出し、確認の操作は出さない', () => {
  const html = body(null);
  expect(html).toContain('API トークンの発行の知らせを読み込めませんでした');
  expect(html).toContain('role="alert"');
  expect(html).toContain('もう一度試す');
  expect(html).not.toContain('確かめた');
});
