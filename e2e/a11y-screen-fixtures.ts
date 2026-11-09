import type { Locator, Page } from '@playwright/test';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { favoriteList } from '../src/shared/operations/favorite.ts';
import { consentStatus } from '../src/shared/operations/session/consent.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { mockOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';
import type { UiScreen } from './ui-exclusions.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const FAVORITE_ROWS = (
  [
    ['task', '朝会の進め方をまとめる'],
    ['story', '初めて使う人が招待から最初のタスクまで迷わず進められる'],
    ['epic', 'お気に入りの長い題の見本'.repeat(4) + 'とても長くて空白の無い題が折り返して崩れないことを確かめる'],
    ['wiki_page', 'ふくろう班の開発手順'],
    // 英数字だけの空白の無い題（字の間で折り返せない）も、行の幅からはみ出さない
    ['task', 'release-checklist-for-the-owl-team-'.repeat(4)],
  ] as const
).map(([target_type, title], index) => ({
  id: `019a0000-0000-7000-8000-00000000f0${index}0`,
  target_type,
  target_id: `019a0000-0000-7000-8000-00000000f0${index}1`,
  workspace_id: '019a0000-0000-7000-8000-000000000401',
  title,
  created_at: '2026-11-10T00:00:00.000Z',
}));

// 画面ごとの URL と、落ち着いたとみなす要素（見出しと、読み込んで描く主な要素）
export const a11yScreens: {
  screen: UiScreen;
  path: string;
  // 画面を開く前に、応答の差し替えなどを済ませる
  prepare?: (page: Page) => Promise<unknown>;
  ready: (page: Page) => Locator[];
}[] = [
  {
    screen: 'consent',
    path: '/consent',
    // 同意の e2e（e2e/consent.test.ts）が seed の unconsented に同意を書くので、状態は固定して、読むだけにする
    prepare: (page) =>
      mockOperation(page, consentStatus, {
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        latest: null,
        current: false,
      }),
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '同意の確認' }),
      page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーを確認し、同意します' }),
    ],
  },
  {
    screen: 'today',
    path: '/aoba',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '今日やること' }),
      page.getByRole('region', { name: '今日やると決めたもの' }),
    ],
  },
  {
    screen: 'favorites',
    path: '/aoba/favorites',
    // 星の数は seed で決まらないので、種類ごとに1件と、空白の無い長い題の行を返す
    prepare: (page) => mockOperation(page, favoriteList, { slug: 'aoba' }, { favorites: FAVORITE_ROWS, marks: [] }),
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'お気に入り' }),
      page.getByRole('main').getByRole('link', { name: /朝会の進め方をまとめる/ }),
    ],
  },
  {
    screen: 'backlog',
    path: WORKSPACE,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'バックログ' }),
      page.getByRole('link', { name: 'ポイント付与のバッチを作る' }),
    ],
  },
  {
    screen: 'epic',
    path: `${WORKSPACE}/epics/${EPIC_ID}`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' }),
      page.getByRole('heading', { level: 2, name: '参加者' }),
    ],
  },
  {
    screen: 'plan',
    path: `${WORKSPACE}/plan`,
    ready: (page) => [page.getByRole('heading', { level: 1, name: '計画' })],
  },
  {
    screen: 'sprint',
    path: `${WORKSPACE}/sprint`,
    // aoba のワークスペースには進行中のスプリントを置かない（seed の進行中は別の組織のワークスペース）ので、架空のスプリントと列とカードに差し替える
    prepare: (page) => mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD),
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'スプリント 第14回' }),
      page.getByRole('article', { name: 'ポイント付与のバッチを作る' }),
    ],
  },
  {
    screen: 'inbox',
    path: `${WORKSPACE}/inbox`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '受信箱' }),
      page.getByRole('list', { name: '受信箱のタスク' }),
    ],
  },
  {
    screen: 'connections',
    path: `${WORKSPACE}/connections`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '接続' }),
      page.getByRole('list', { name: '接続の一覧' }),
    ],
  },
  {
    screen: 'members',
    path: `${WORKSPACE}/members`,
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'メンバー' }),
      page.getByRole('table', { name: '所属している人の一覧' }),
    ],
  },
  {
    screen: 'workspace-settings',
    path: `${WORKSPACE}/settings`,
    ready: (page) => [page.getByRole('heading', { level: 1, name: '設定' })],
  },
  {
    screen: 'admin',
    path: '/aoba/admin',
    ready: (page) => [
      page.getByRole('heading', { level: 1 }),
      // 節ごとに読む一覧のうち、seed の行がほかのファイルに消されないもの（ワークスペースの一覧）
      page.getByRole('table', { name: 'ワークスペースの一覧' }),
    ],
  },
  // 枠の外の画面。ログインしていなくても開ける（開く確かめは e2e/legal.test.ts）。ここはログインした状態でも同じ画面が出て、axe の違反が無いことを見る
  {
    screen: 'terms',
    path: '/terms',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: '利用規約' }),
      page.getByRole('heading', { level: 2, name: /^第1条/ }),
    ],
  },
  {
    screen: 'privacy',
    path: '/privacy',
    ready: (page) => [
      page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' }),
      page.getByRole('heading', { level: 2, name: /預からないもの/ }),
    ],
  },
];
