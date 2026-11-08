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
    // 以前は約 155px。見本の seed で測って決めた目標（余白に 8px の許容）
    expect(result.height, `${theme}: 行の高さ`).toBeLessThanOrEqual(125);
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
  if ((await row.count()) > 0) {
    const [check, main] = await Promise.all([
      row.locator('.row-check').boundingBox(),
      row.locator('.entry-main').boundingBox(),
    ]);
    // 選ぶ欄は題の左の列で、題の上の別の段にならない
    expect(check!.y).toBeLessThan(main!.y + main!.height);
    expect(check!.x + check!.width).toBeLessThanOrEqual(main!.x + 1);
  }
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
    const boxes = await drawer.locator('.drawer-tools button:visible').evaluateAll((buttons) =>
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
  await expect(whole.getByRole('heading', { level: 2 })).toBeVisible();
  await expectDrawerToolsApart(page, whole, 3);
});
