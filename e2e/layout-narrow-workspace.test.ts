// ワークスペースの中の主な画面（バックログ、タスクの引き出し、計画、メンバー、ワークスペースの設定）を幅 390px で開き、
// 横のはみ出しと 44px の押せる範囲を確かめる（#336）。3つのテーマ × 1つの言葉（スクラムの言葉）。ワークスペースの外の画面は
// e2e/layout-narrow.test.ts（CI のシャードに散るよう分けた）。除外は e2e/ui-exclusions.ts。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト。
// 開くだけで、seed の行もテーマも書き換えない（ほかのファイルと並べて走るため）
import type { Page } from '@playwright/test';
import type { DictionaryKey, TemplateParams } from '../src/shared/vocabulary.ts';
import { sprintBoard } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import {
  LAYOUT_THEMES,
  A11Y_THEMES,
  expectNoA11yViolations,
  NARROW_VIEWPORT,
  applyTheme,
  createWorkspace,
  expectNarrowLayout,
  findOverflowViolations,
  findTargetSizeViolations,
  signIn,
} from './helpers.ts';
import { mockOperation, rewriteOperation } from './operations.ts';
import { SAMPLE_BOARD } from './sprint-fixture.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const TASK_ID = '019a0000-0000-7000-8000-000000000801';
const EPIC_ID = '019a0000-0000-7000-8000-000000000b01';
const STORY_ID = '019a0000-0000-7000-8000-000000000901';

type W = (key: DictionaryKey, params?: TemplateParams) => string;

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

// ワークスペースの言葉が出ていること。左のメニューのバックログの項目の名前で見る（狭い幅では帯の中に畳まれる）
async function expectWorkspaceWords(page: Page, w: W): Promise<void> {
  await expect(page.locator('.nav a.nav-item', { hasText: w('backlog') })).toHaveCount(1);
}

test('バックログが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'backlog', async (w) => {
    await page.goto(WORKSPACE);
    await expect(page.getByRole('heading', { level: 1, name: w('backlog') })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ポイント付与のバッチを作る' })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

// #1095: 上部の補助情報を閉じた初期表示では、木の先頭2行を切らずに見せる。
// 2行にはエピックとストーリーを含む。未完了タスクだけを数える条件ではない。
test('バックログの先頭2行が390×844pxに入り、補助情報を各1回で開ける（4つの見た目）', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const header = page.locator('.page-head');
  const bar = page.getByRole('search', { name: 'バックログの絞り込み' });
  const summary = header.getByRole('button', { name: '集計', exact: true });
  const filters = bar.getByRole('button', { name: '絞り込み', exact: true });
  const help = page.getByRole('button', { name: '並べ替えの使い方', exact: true });
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    await page.evaluate(() => scrollTo(0, 0));
    for (const button of [summary, filters, help]) await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(bar.getByRole('searchbox')).toBeVisible();
    await expect(header.getByText('未完了のタスク', { exact: true })).toBeVisible();
    await expect(header.locator('.team-xp')).toBeHidden();
    await expect(page.locator('.breadcrumb')).toHaveCount(0);
    await expect(header.locator('.mobile-page-tools')).toHaveCount(1);
    for (const label of ['詳細 未記入', '未見積もり', 'スプリントに入っていない']) {
      await expect(header.getByText(label, { exact: true })).toBeHidden();
    }
    await expect(page.getByText('上ほど優先', { exact: true })).toBeVisible();
    await expect(bar.getByRole('combobox')).toHaveCount(0);
    const rows = await page.locator('.tree-row, .tree .entry').evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().height > 0)
        .slice(0, 2)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
    );
    expect(rows, theme).toHaveLength(2);
    for (const row of rows) {
      expect(row.top, theme).toBeGreaterThanOrEqual(0);
      expect(row.bottom, theme).toBeLessThanOrEqual(NARROW_VIEWPORT.height);
    }
    await expectNoA11yViolations(page, 'backlog');
    const closedDirections = await Promise.all(
      [summary, filters, help].map((button) =>
        button.locator('svg').evaluate((icon) => getComputedStyle(icon).transform),
      ),
    );
    for (const button of [summary, filters, help]) await button.click();
    for (const [index, button] of [summary, filters, help].entries()) {
      await expect(button.locator('svg')).toBeVisible();
      expect(await button.locator('svg').evaluate((icon) => getComputedStyle(icon).transform)).not.toBe(
        closedDirections[index],
      );
    }
    for (const button of [summary, filters, help]) await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(header.locator('.team-xp')).toBeVisible();
    for (const label of ['詳細 未記入', '未見積もり', 'スプリントに入っていない']) {
      const item = header.locator('.tally > div').filter({ has: page.getByText(label, { exact: true }) });
      await expect(item.locator('dt')).toBeVisible();
      await expect(item.locator('dd')).toBeVisible();
      await expect(item.locator('dd')).toHaveText(/^\d+$/);
    }
    await expect(bar.getByRole('combobox')).toHaveCount(4);
    await expect(page.locator('.order-help .action-note')).toBeVisible();
    expect(await findOverflowViolations(page), theme).toEqual([]);
    expect(await findTargetSizeViolations(page), theme).toEqual([]);
    await expectNoA11yViolations(page, 'backlog');
    for (const button of [summary, filters, help]) await button.click();
    for (const [index, button] of [summary, filters, help].entries()) {
      await expect(button.locator('svg')).toBeVisible();
      expect(await button.locator('svg').evaluate((icon) => getComputedStyle(icon).transform)).toBe(
        closedDirections[index],
      );
    }
  }
});

test('390pxで閉じた絞り込みにも条件数と解除を残し、広い幅では開く操作が要らない', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(`${WORKSPACE}?assignee=me&repository=none`);
  const bar = page.getByRole('search', { name: 'バックログの絞り込み' });
  const filters = bar.getByRole('button', { name: '絞り込み（2条件）', exact: true });
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByRole('combobox')).toHaveCount(0);
  await filters.click();
  await expect(bar.getByRole('combobox', { name: '担当', exact: true })).toHaveValue('me');
  await expect(bar.getByRole('combobox', { name: 'リポジトリ', exact: true })).toHaveValue('none');
  await filters.click();
  await bar.getByRole('button', { name: '絞り込みを外す', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${WORKSPACE}$`));
  await expect(bar.getByRole('searchbox')).toBeFocused();
  await expect(bar.getByRole('button', { name: '絞り込み', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByRole('button', { name: '絞り込みを外す', exact: true })).toHaveCount(0);
  for (const width of [761, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(bar.getByRole('combobox')).toHaveCount(4);
    await expect(page.locator('.page-head .team-xp')).toBeVisible();
    await expect(page.locator('.page-head .page-eyebrow')).toBeVisible();
    await expect(page.locator('.order-help .action-note')).toBeVisible();
    await expect(page.locator('.narrow-disclosure-toggle:visible')).toHaveCount(0);
  }
  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(bar.getByRole('combobox')).toHaveCount(0);
    await expect(bar.getByRole('button', { name: '絞り込み', exact: true })).toBeVisible();
  }
});

test('エピックの画面が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'epic', async (w) => {
    await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: w('party') })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('タスクの引き出しが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'task-drawer', async (w) => {
    await page.goto(`${WORKSPACE}?task=${TASK_ID}`);
    const drawer = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
    await expectWorkspaceWords(page, w);
  });
});

test('計画が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'plan', async (w) => {
    await page.goto(`${WORKSPACE}/plan`);
    await expect(page.getByRole('heading', { level: 1, name: w('plan') })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('スプリントが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  // aoba のワークスペースには進行中のスプリントを置かない（seed の進行中は別の組織のワークスペース）ので、架空のスプリントと列とカードに差し替える
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await expectNarrowLayout(page, 'sprint', async (w) => {
    await page.goto(`${WORKSPACE}/sprint`);
    await expect(page.getByRole('heading', { level: 1, name: `${w('sprint')} 第14回` })).toBeVisible();
    await expect(page.getByRole('article', { name: 'ポイント付与のバッチを作る' })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

// バックログのタスクの行の密度（#999）。行の高さを詰めても、押せる範囲（::after で 44px に広げたもの）が隣と重ならない。
// 押せる範囲の汎用の検査は、重なっても上に描かれた方に当たれば通るので、広げた範囲の箱を直接比べる
test('バックログのタスクの行が 390px で今より低く、チップと完了の丸の押せる範囲が 44px で隣と重ならない', async ({
  page,
}) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  const row = page.locator('.entry', {
    has: page.getByRole('link', { name: 'ポイント付与のバッチを作る', exact: true }),
  });
  await expect(row).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const theme of LAYOUT_THEMES) {
    await applyTheme(page, theme);
    const result = await row.evaluate((entry) => {
      // 押せる範囲は ::after で広げるので、疑似要素の大きさから箱を作る。見た目の大きさが 44px 以上ならそのまま使う
      const targets = [...entry.querySelectorAll<HTMLElement>('.entry-end button, .entry-end a, .entry-title')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const boxes = targets.map((el) => {
        const rect = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        const w = Math.max(rect.width, after.content === 'none' ? 0 : parseFloat(after.width) || 0);
        const h = Math.max(rect.height, after.content === 'none' ? 0 : parseFloat(after.height) || 0);
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return { name: el.textContent?.trim().slice(0, 12) ?? '', x: cx - w / 2, y: cy - h / 2, w, h };
      });
      return { height: entry.getBoundingClientRect().height, boxes };
    });
    // 以前は約 181px（seed のこの行を本番と同じ build の 390px で測った。2026-11-08）。いまは約 170px。書体の差に 5px の許容
    expect(result.height, `${theme}: 行の高さ`).toBeLessThanOrEqual(175);
    for (const box of result.boxes) {
      expect(box.w, `${theme}: ${box.name} の幅`).toBeGreaterThanOrEqual(43.5);
      expect(box.h, `${theme}: ${box.name} の高さ`).toBeGreaterThanOrEqual(43.5);
    }
    for (const [i, a] of result.boxes.entries()) {
      for (const b of result.boxes.slice(i + 1)) {
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX > 0.5 && overlapY > 0.5, `${theme}: ${a.name} と ${b.name} の押せる範囲が重なる`).toBe(false);
      }
    }
  }
});

// ストーリーの行（題のリンクと右端の段）と、受信箱の行（選ぶ欄、題、右端）の 390px の並び（#999）。
// 題の広げた押せる範囲が右端のボタンの範囲に重ならないことと、受信箱の選ぶ欄が題と同じ段に並ぶことを確かめる
test('ストーリーの行の題と右端のボタンの押せる範囲が重ならず、受信箱の行は選ぶ欄と題が同じ段に並ぶ', async ({
  page,
}) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto(WORKSPACE);
  await expect(page.getByRole('link', { name: 'ポイント付与のバッチを作る', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const boxesOf = (selector: string) =>
    page.locator(selector).evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll<HTMLElement>('a.tree-link, .tree-end button')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const after = getComputedStyle(el, '::after');
            const w = Math.max(rect.width, parseFloat(after.width) || 0);
            const h = Math.max(rect.height, parseFloat(after.height) || 0);
            return { y: rect.y + rect.height / 2 - h / 2, h, x: rect.x + rect.width / 2 - w / 2, w };
          }),
      ),
    );
  for (const theme of LAYOUT_THEMES) {
    await applyTheme(page, theme);
    const rows = await boxesOf('.tree-row.is-story');
    expect(rows.length).toBeGreaterThan(0);
    for (const boxes of rows) {
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(overlapX > 0.5 && overlapY > 0.5, `${theme}: ストーリー行の押せる範囲が重なる`).toBe(false);
        }
      }
    }
  }
  await page.goto(`${WORKSPACE}/inbox`);
  const row = page.locator('.entry:has(.row-check)').first();
  await expect(row).toBeVisible();
  const [check, main] = await Promise.all([
    row.locator('.row-check').boundingBox(),
    row.locator('.entry-main').boundingBox(),
  ]);
  // 選ぶ欄は題の左の列で、題の上の別の段にならない（縦の範囲が重なり、横は題の左に収まる）
  expect(check!.y).toBeLessThan(main!.y + main!.height);
  expect(main!.y).toBeLessThan(check!.y + check!.height);
  expect(check!.x + check!.width).toBeLessThanOrEqual(main!.x + 1);
});

test('スプリントの列の「タスクを足す」の欄の案内が、390px でも切れずに読める', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  await page.goto(`${WORKSPACE}/sprint`);
  const input = page.locator('.board-col .draft-row .input').first();
  await expect(input).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(input).toHaveAttribute('placeholder', 'タスクを足す');
  // 案内の文字の幅が、欄の中身の幅（余白を除く）に収まる
  const fits = await input.evaluate((el: HTMLInputElement) => {
    const style = getComputedStyle(el);
    const canvas = document.createElement('canvas').getContext('2d');
    if (canvas === null) return false;
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return canvas.measureText(el.placeholder).width <= inner;
  });
  expect(fits).toBe(true);
});

test('受信箱が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'inbox', async (w) => {
    await page.goto(`${WORKSPACE}/inbox`);
    await expect(page.getByRole('heading', { level: 1, name: w('inbox') })).toBeVisible();
    await expect(page.getByRole('list', { name: `${w('inbox')}の${w('task')}` })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('接続が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'connections', async (w) => {
    await page.goto(`${WORKSPACE}/connections`);
    await expect(page.getByRole('heading', { level: 1, name: w('connection') })).toBeVisible();
    await expect(page.getByRole('list', { name: `${w('connection')}の一覧` })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('メンバーが 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'members', async (w) => {
    await page.goto(`${WORKSPACE}/members`);
    await expect(page.getByRole('heading', { level: 1, name: w('pageMembers') })).toBeVisible();
    await expect(page.getByRole('table', { name: '所属している人の一覧' })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

test('ワークスペースの設定が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({ page }) => {
  await expectNarrowLayout(page, 'workspace-settings', async (w) => {
    await page.goto(`${WORKSPACE}/settings`);
    await expect(page.getByRole('heading', { level: 1, name: w('pageSettings') })).toBeVisible();
    await expectWorkspaceWords(page, w);
  });
});

// 空白の無い 2048 字近い URL のリンクを持つエピック。seed の行は書き換えず、作ったワークスペースの中に作る（ほかのファイルと並べて走るため）
async function createEpicWithLongLink(page: Page): Promise<{ epicPath: string; link: string }> {
  await createWorkspace(page, '長いリンクのワークスペース');
  const workspacePath = new URL(page.url()).pathname;
  const link = `https://example.com/${'a'.repeat(2000)}`;
  const response = await page.request.post('/api/aoba/epic-create', {
    headers: { Origin: new URL(page.url()).origin },
    data: { workspace_id: workspacePath.split('/').pop(), title: '長いリンクのエピック', link_url: link },
  });
  expect(response.ok()).toBe(true);
  const { epic } = (await response.json()) as { epic: { id: string } };
  return { epicPath: `${workspacePath}/epics/${epic.id}`, link };
}

test('長い URL のリンクを持つエピックの画面が 390px で横にはみ出さず、押せる要素が 44px 四方で押せる', async ({
  page,
}) => {
  const { epicPath, link } = await createEpicWithLongLink(page);
  await expectNarrowLayout(page, 'epic', async (w) => {
    await page.goto(epicPath);
    await expect(page.getByRole('heading', { level: 1, name: '長いリンクのエピック' })).toBeVisible();
    // URL は全文を出し、折り返す。「開く」は URL の文字と別のリンクで、読み上げの名前に「開く」を含む
    await expect(page.locator('.source-key.is-wrap')).toContainText(link);
    await expect(page.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveText('開く');
    await expectWorkspaceWords(page, w);
  });
});

test('長い URL のリンクを持つエピックの画面が 320px でも横にはみ出さず、押せる要素が 44px 四方で押せる', async ({
  page,
}) => {
  const { epicPath } = await createEpicWithLongLink(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(epicPath);
  await expect(page.getByRole('heading', { level: 1, name: '長いリンクのエピック' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await findOverflowViolations(page)).toEqual([]);
  expect(await findTargetSizeViolations(page)).toEqual([]);
});

test('終了したワークスペースのエピックの画面は、「戻る」だけが残る見出しの右も 44px 四方で押せる', async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-20T00:00:00.000Z',
  }));
  await page.goto(`${WORKSPACE}/epics/${EPIC_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'ポイントの交換先を増やす' })).toBeVisible();
  await expect(page.locator('.page-actions .btn')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  // 終了の帯の中のリンク（組織の管理へ）は、どのワークスペースの画面にも出る帯の部品で、この画面の対象ではない
  const violations = await findTargetSizeViolations(page);
  expect(violations.filter((violation) => !violation.detail.includes('div.callout'))).toEqual([]);
});

// 引き出しの上の帯の右端（前後、開き方、閉じる）。閉じるは見た目ごと 44px 四方で、隣のボタンと箱が交わらない（#994）。
// 押せる範囲の汎用の検査は、::after で広げた範囲が隣に重なっても、上に描かれた方に当たれば通るので、箱の大きさと交わりを直接確かめる
async function expectDrawerToolsApart(
  page: Page,
  drawer: ReturnType<Page['locator']>,
  neighbors: number,
): Promise<void> {
  const close = drawer.locator('.drawer-close');
  await expect(close).toBeVisible();
  // 組織の読み込みでテーマが DB の値に戻らないよう、要求が止んでから当てる
  await page.waitForLoadState('networkidle');
  for (const theme of LAYOUT_THEMES) {
    await applyTheme(page, theme);
    const boxes = await drawer
      .locator('.drawer-tools button:visible, .drawer-top > .drawer-close')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            close: button.classList.contains('drawer-close'),
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
          };
        }),
      );
    // 前後と開き方と閉じるは、どれも見た目ごと 44px 四方
    for (const box of boxes) {
      expect(box.w, `${theme}: 右端のボタンの幅`).toBeGreaterThanOrEqual(44);
      expect(box.h, `${theme}: 右端のボタンの高さ`).toBeGreaterThanOrEqual(44);
    }
    const closeBox = boxes.find((box) => box.close);
    expect(closeBox, `${theme}: 閉じるボタンが無い`).toBeDefined();
    // 隣のボタンの数は固定する（出るはずのボタンが消えて、交わりの確かめが空振りしないように）。
    // 狭い幅では開き方の「真ん中」を出さない。タスクは前後の2つと開き方（横、ページ全体、新しいタブ）の3つ、
    // ストーリーは横だけが残って開き方の組ごと出ないので前後の2つ、ページ全体は前後が出ず開き方の3つ
    const others = boxes.filter((box) => !box.close);
    expect(others.length, `${theme}: 閉じるボタンの隣のボタンの数`).toBe(neighbors);
    for (const other of others) {
      const apart =
        other.x + other.w <= closeBox!.x ||
        closeBox!.x + closeBox!.w <= other.x ||
        other.y + other.h <= closeBox!.y ||
        closeBox!.y + closeBox!.h <= other.y;
      expect(apart, `${theme}: 閉じるボタンと隣のボタンの箱が交わる`).toBe(true);
    }
    // 閉じるは帯の 1 段目（先頭の印と同じ段）の右端に残る（前後と開き方が 2 段目に落ちても、閉じるを探さない）
    await expect(drawer.locator('.drawer-top .chip').first()).toBeVisible();
    const rows = await drawer.evaluate((root) => {
      const close = root.querySelector('.drawer-close')!.getBoundingClientRect();
      const first = root.querySelector('.drawer-top > :first-child')!.getBoundingClientRect();
      const top = root.querySelector('.drawer-top')!.getBoundingClientRect();
      return {
        closeTop: close.top,
        closeRight: close.right,
        firstTop: first.top,
        topRight: top.right,
        topHeight: top.height,
      };
    });
    expect(Math.abs(rows.closeTop - rows.firstTop), `${theme}: 閉じるが 1 段目に無い`).toBeLessThanOrEqual(30);
    expect(rows.topRight - rows.closeRight, `${theme}: 閉じるが右端に無い`).toBeLessThanOrEqual(2);
    expect(rows.topHeight, `${theme}: 帯が高すぎる`).toBeLessThan(110);
    expect(await findTargetSizeViolations(page), theme).toEqual([]);
    // 測っている間に、画面の読み直しで DB のテーマに戻っていない
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  }
}

test('タスクの引き出し（前後のボタンつき）、ストーリーの引き出し、ページ全体の閉じるボタンが、390px で見た目ごと 44px 四方になり隣と交わらない', async ({
  page,
}) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  // タスクの引き出し。木の題から開くと、前後のボタンが閉じるボタンの左に並ぶ
  await page.goto(WORKSPACE);
  await page.getByRole('link', { name: 'ポイント付与のバッチを作る', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'ポイント付与のバッチを作る' });
  await expect(task.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(task.locator('.drawer-steps')).toBeVisible();
  await expectDrawerToolsApart(page, task, 5);
  // ポイントの選択は折り返しても、どの選択肢にも右と下の区切り（box-shadow）が付き、左の線は残らない
  const borders = await task.locator('.segmented[aria-labelledby] label span').evaluateAll((spans) =>
    spans.map((span) => {
      const style = getComputedStyle(span);
      return { left: style.borderLeftWidth, shadow: style.boxShadow };
    }),
  );
  expect(borders.length).toBeGreaterThan(1);
  for (const border of borders) {
    expect(border.left).toBe('0px');
    expect(border.shadow).not.toBe('none');
  }
  // ストーリーの引き出し
  await page.goto(`${WORKSPACE}?story=${STORY_ID}`);
  const story = page.getByRole('dialog');
  await expect(story.getByRole('heading', { level: 2 })).toBeFocused();
  // 前後のボタンは、バックログが木を読んで順を置いてから出る。見出しのフォーカスだけでは数える時点に間に合わない
  await expect(story.locator('.drawer-steps')).toBeVisible();
  await expectDrawerToolsApart(page, story, 2);
  // ページ全体で開いたタスク
  await page.goto(`${WORKSPACE}/tasks/${TASK_ID}`);
  const whole = page.locator('.drawer.is-page');
  // ページ全体は画面に h1 が無いので、題を h1 にする（引き出しの h2 のまま読み上げが h2 から始まらない）
  await expect(whole.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expectDrawerToolsApart(page, whole, 3);
});
