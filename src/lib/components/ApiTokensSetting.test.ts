// マイプロフィールの「API トークン」の節（ApiTokensSetting.svelte）を svelte/server で HTML にして、初期の描画だけを確かめる。
// 入力の解釈（problem()）と発行・取消の流れはコンポーネントの中の状態で、純粋な関数に切れていないので、ここでは扱わない（e2e/api-tokens.test.ts）
import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import { formatLocalDate } from '../format.ts';
import { dictionary } from '../../shared/vocabulary.ts';
import ApiTokensSetting from './ApiTokensSetting.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/aoba/me') } }));

const HASH = 'a'.repeat(63) + 'b';
const token = {
  id: HASH,
  name: '手元の端末',
  scope: 'write' as const,
  created_at: '2026-10-01T00:00:00.000Z',
  last_used_at: null as string | null,
  expires_at: '2026-12-31T12:00:00.000Z',
};

const renderWith = (initial: (typeof token)[] | null) =>
  render(ApiTokensSetting, { props: { initial, canCreate: true, loginProvider: 'github', slug: 'aoba' } }).body;

test('apiToken の辞書のキーは、スクラムの言葉の文言を持つ', () => {
  const keys = Object.keys(dictionary).filter((key) => key.startsWith('apiToken'));
  expect(keys.length).toBeGreaterThan(20);
  for (const key of keys) {
    const text = (dictionary as Record<string, string>)[key]!;
    expect(text.length, key).toBeGreaterThan(0);
  }
});

// 行のセル（td[data-label=…]）の文字だけを取り出す。範囲の選択肢の文字（発行の欄の「書き込み」）と取り違えないため
function cellText(body: string, label: string): string {
  const cell = new RegExp(`<td[^>]*data-label="${label}"[^>]*>(.*?)</td>`, 's').exec(body);
  expect(cell, `${label} のセル`).not.toBeNull();
  return cell![1]!
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

test('一覧の行の範囲のセルは、write なら書き込み、read なら読み取りを出す', () => {
  expect(cellText(renderWith([token]), '範囲')).toBe('書き込み');
  expect(cellText(renderWith([{ ...token, scope: 'read' as never }]), '範囲')).toBe('読み取り');
});

test('一覧の行は名前、範囲、期限、未使用を出し、ハッシュ（id）と生の値の接頭辞は HTML のどこにも出ない', () => {
  const body = renderWith([token]);
  expect(body).toContain('手元の端末');
  expect(cellText(body, '範囲')).toBe('書き込み');
  expect(cellText(body, '期限')).toBe(formatLocalDate(token.expires_at));
  expect(cellText(body, '最後に使った日')).toBe('未使用');
  expect(body).toContain(formatLocalDate(token.expires_at));
  expect(body).toContain('未使用');
  expect(body).toContain('aria-label="API トークン「手元の端末」を取り消す"');
  expect(body).not.toContain(HASH);
  expect(body).not.toContain('sgp_');
});

test('最後に使った日があれば未使用を出さず、日付を出す', () => {
  const body = renderWith([{ ...token, last_used_at: '2026-10-15T03:00:00.000Z' }]);
  expect(body).not.toContain('未使用');
  expect(body).toContain(formatLocalDate('2026-10-15T03:00:00.000Z'));
});

test('名前の HTML は文字として出し、タグとして解釈させない', () => {
  const body = renderWith([{ ...token, name: '<img src=x onerror=alert(1)>' }]);
  expect(body).not.toContain('<img src=x');
  expect(body).toContain('&lt;img src=x onerror=alert(1)>');
  // 属性（aria-label）の中でも引用符を破れない
  const quoted = renderWith([{ ...token, name: '" onfocus="alert(1)' }]);
  expect(quoted).not.toContain('" onfocus="alert(1)"');
});

test('一覧が空なら空の知らせ、読めなかった（null）なら失敗と再試行を出し、表は出さない', () => {
  const empty = renderWith([]);
  expect(empty).toContain('発行済みの API トークンはありません');
  expect(empty).not.toContain('<table');
  const failed = renderWith(null);
  expect(failed).toContain('API トークンを読み込めませんでした');
  expect(failed).toContain('もう一度試す');
  expect(failed).not.toContain('<table');
  expect(failed).not.toContain('発行済みの API トークンはありません');
});

test('発行の欄の初期値は、範囲が読み取り、有効日数が90で、発行直後のダイアログの中身（値）を持たない', () => {
  const body = renderWith([]);
  expect(body).toMatch(/<input[^>]*type="radio"[^>]*value="read"[^>]*checked|<input[^>]*checked[^>]*value="read"/);
  expect(body).toMatch(/type="number"[^>]*value="90"|value="90"[^>]*type="number"/);
  expect(body).toContain('max="90"');
  expect(body).not.toContain('二度と見られません');
  expect(body).not.toContain('sgp_');
});

test.each(['github', 'google'])(
  '再認証が必要なら発行の欄を出さず、%s のログイン開始へ同じ組織の設定を return_to にして戻す',
  (provider) => {
    const body = render(ApiTokensSetting, {
      props: { initial: [token], canCreate: false, loginProvider: provider, slug: 'hibari' },
    }).body;
    expect(body).toContain('ログインし直す');
    expect(body).toContain(`/api/auth/${provider}/start?return_to=%2Fhibari%2Fme`);
    expect(body).toContain('data-sveltekit-reload');
    expect(body).not.toContain('<form');
    expect(body).toContain('手元の端末');
    expect(body).toContain('取り消す');
  },
);

test('canCreate が true なら発行の欄を出し、発行専用の再認証案内を出さない', () => {
  const body = renderWith([]);
  expect(body).toContain('<form');
  expect(body).not.toContain('API トークンを発行するには、ログインし直してください。');
});

test('一覧が読めなくても発行の欄を出す', () => {
  expect(renderWith(null)).toContain('<form');
});

// 危険な操作「ほかの端末とトークンを締め出す」。押す先の確認のダイアログと、成功と失敗の知らせの文は辞書から出す
test('節の末尾に、危険な操作の小見出しと説明とボタンを辞書の文言で出す（一覧が空でも、行があっても、読めなくても）', () => {
  for (const initial of [[], [token], null]) {
    const body = renderWith(initial);
    expect(body).toContain(`<h3 class="field-label">${dictionary.apiTokenRevokeAllTitle}</h3>`);
    expect(body).toContain(dictionary.apiTokenRevokeAllDesc);
    expect(body).toMatch(/<button[^>]*class="btn is-danger"[^>]*>ほかの端末とトークンを締め出す<\/button>/);
    // 一覧より後ろ（節の末尾）に置く
    expect(body.indexOf(dictionary.apiTokenRevokeAllTitle)).toBeGreaterThan(body.indexOf('<form'));
  }
  expect(dictionary.apiTokenRevokeAllDesc).toMatch(/^端末をなくしたとき/);
  const withRow = renderWith([token]);
  expect(withRow.lastIndexOf('</table>')).toBeLessThan(withRow.indexOf(dictionary.apiTokenRevokeAllTitle));
});

test('再認証が必要で発行の欄が無いときも、締め出すボタンは出す（セッションの締め出しは再認証を求めない）', () => {
  const body = render(ApiTokensSetting, {
    props: { initial: [token], canCreate: false, loginProvider: 'github', slug: 'aoba' },
  }).body;
  expect(body).not.toContain('<form');
  expect(body).toContain('ほかの端末とトークンを締め出す</button>');
});

test('確認のダイアログは、元に戻せないことと、今のログインと後からのログインが残ることを辞書の文言で書き、やめるを主ボタン、締め出すを危険のボタンにする', () => {
  const body = renderWith([token]);
  expect(body).toContain(dictionary.apiTokenRevokeAllDialogTitle);
  const paragraphs = dictionary.apiTokenRevokeAllText.split('\n\n');
  expect(paragraphs).toHaveLength(3);
  for (const paragraph of paragraphs) expect(body).toContain(`<p>${paragraph}</p>`);
  expect(dictionary.apiTokenRevokeAllText).toContain('元に戻せません');
  expect(dictionary.apiTokenRevokeAllText).toContain('このブラウザのログインは残ります');
  expect(dictionary.apiTokenRevokeAllText).toContain('後からログインした端末は残ります');
  expect(dictionary.apiTokenRevokeAllText).toContain('疑わしいときは「やめる」で戻り');
  expect(body).toMatch(/<button[^>]*class="btn is-primary"[^>]*>やめる<\/button>/);
  expect(body).toMatch(/<button[^>]*class="btn is-danger"[^>]*>締め出す<\/button>/);
});

test('件数の知らせは、消したセッションと取り消したトークンの数を差し込み、「{sessions}」「{tokens}」を残さない', () => {
  const text = dictionary.apiTokenRevokedAll;
  expect(text).toContain('{sessions}');
  expect(text).toContain('{tokens}');
  expect(text.replace('{sessions}', '2').replace('{tokens}', '3')).toBe(
    'ほかの端末のセッション2件と、API トークン3件を締め出しました',
  );
  expect(text.replace('{sessions}', '0').replace('{tokens}', '0')).toBe(
    'ほかの端末のセッション0件と、API トークン0件を締め出しました',
  );
  for (const key of ['apiTokenRevokingAll', 'apiTokenRevokeAllFailed'] as const) {
    expect(dictionary[key].length, key).toBeGreaterThan(0);
  }
});

test('ログインの手段が読めなければ、戻り先を保ったログイン画面へ案内する', () => {
  const body = render(ApiTokensSetting, {
    props: { initial: [], canCreate: false, loginProvider: null, slug: 'aoba' },
  }).body;
  expect(body).toContain('/login?return_to=%2Faoba%2Fme');
});

// トーストが消えても、締め出せない端末と次の手順を見失わない。
test.each([true, false])('全失効の注意と再ログイン導線は発行可否 %j によらず常設する', (canCreate) => {
  const body = render(ApiTokensSetting, {
    props: { initial: [], canCreate, loginProvider: 'github', slug: 'aoba' },
  }).body;
  const notice = /<span id="([^"]+-revoke-all-hint)">([^<]+)<\/span>/.exec(body);
  expect(notice).not.toBeNull();
  expect(notice![2]).toContain('後からログインした端末は残ります');
  expect(notice![2]).toContain('ログインし直して');
  expect(body).toContain(`aria-describedby="${notice![1]}"`);
  expect(body).toContain('class="callout is-info"');
  expect(body.indexOf(notice![1]!)).toBeGreaterThan(body.indexOf(dictionary.apiTokenRevokeAllTitle));
});
