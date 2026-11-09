import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';
import { A11Y_TAGS, A11Y_THEMES, applyTheme, signIn } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import {
  orgWikiPage,
  orgWikiTree,
  orgWikiMove,
  workspaceWikiPage,
  workspaceWikiTree,
  workspaceWikiMove,
} from '../src/shared/operations/wiki/index.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

for (const scope of ['organization', 'workspace'] as const) {
  for (const theme of A11Y_THEMES) {
    test(`Wiki の余白と折り畳み、本文と JSON を読める（${scope}・${theme}）`, async ({ page }) => {
      const workspaceId = '019a0000-0000-7000-8000-000000000401';
      const root = scope === 'organization' ? '/aoba/wiki' : `/aoba/w/${workspaceId}/wiki`;
      const wikiPage = {
        id: crypto.randomUUID(),
        parent_id: null,
        position: 'a0',
        title: 'チームの手順',
        body_md: '最初に読める手順の本文です。',
        version: 1,
        created_by: '019a0000-0000-7000-8000-000000000301',
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
      };
      const pages = [wikiPage, { ...wikiPage, id: crypto.randomUUID(), title: '次の手順' }].map(
        ({ id, parent_id, position, title, version }) => ({ id, parent_id, position, title, version }),
      );
      await mockOperation(
        page,
        scope === 'organization' ? orgWikiTree : workspaceWikiTree,
        { slug: 'aoba' },
        { pages },
      );
      await routeOperation(
        page,
        scope === 'organization' ? orgWikiPage : workspaceWikiPage,
        { slug: 'aoba' },
        async (call) => {
          await call.fulfill({ page: wikiPage });
        },
      );
      await mockOperation(
        page,
        workspaceInfo,
        { slug: 'aoba' },
        { name: '手順のチーム', closed_at: null, definition_of_done_md: null, role: 'leader' },
      );
      await page.goto(root);
      const list = page.locator('.wiki-page-list');
      const search = page.getByRole('searchbox');
      const access = page.locator('.page-head > .props-note');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await applyTheme(page, theme);
        await expect(search).toBeVisible();
        await expect(access).toBeVisible();
        const metrics = await page.evaluate(() => {
          const head = document.querySelector('.page-head')!.getBoundingClientRect();
          const layout = document.querySelector('.layout-wiki')!.getBoundingClientRect();
          const hint = document.querySelector('.page-head > .props-note')!.getBoundingClientRect();
          return {
            gap: layout.top - head.bottom,
            expected: parseFloat(getComputedStyle(document.querySelector('.content')!).rowGap),
            left: hint.left - head.left,
          };
        });
        expect(Math.abs(metrics.gap - metrics.expected)).toBeLessThanOrEqual(1);
        expect(Math.abs(metrics.left)).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      // 一覧からページへ移ると畳まれ、題と本文が最初の画面内に来る。
      await page.locator('.wiki-side').getByRole('link', { name: wikiPage.title, exact: true }).click();
      await expect(list).not.toHaveAttribute('open');
      await expect(search).toBeHidden();
      await applyTheme(page, theme);
      const heading = page.getByRole('heading', { level: 2, name: wikiPage.title });
      await expect(heading).toBeInViewport();
      await expect(page.locator('.doc-box')).toBeInViewport();
      wikiPage.body_md = '---\ntags: [process, team]\n---\n最初に読める手順の本文です。';
      await page.reload();
      await expect(heading).toBeVisible();
      await applyTheme(page, theme);
      const value = page.getByRole('cell', { name: '[ "process", "team" ]', exact: true });
      await expect(value).toBeVisible();
      expect(await value.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(
        await value.evaluate((element) => getComputedStyle(element.closest('tr')!.querySelector('th')!).fontFamily),
      );
      // 共通ヘッダーの既知の問題（#343）は既存の検査に任せ、Wiki の一覧と本文を調べる。
      expect((await new AxeBuilder({ page }).include('.content').withTags(A11Y_TAGS).analyze()).violations).toEqual([]);
      // キーボードで開閉でき、幅を戻すと閉じた一覧も再び使える。
      await list.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(search).toBeVisible();
      if (theme === A11Y_THEMES[0]) {
        await mockOperation(
          page,
          scope === 'organization' ? orgWikiMove : workspaceWikiMove,
          { slug: 'aoba' },
          { page_id: wikiPage.id, parent_id: null },
        );
        await page.getByRole('button', { name: '並べ替える', exact: true }).click();
        const move = page.getByRole('button', { name: `下へ: ${wikiPage.title}`, exact: true });
        await move.click();
        await expect(move).toHaveAttribute('aria-disabled', 'false');
        await expect(search).toBeVisible();
        await expect(move).toBeFocused();
        await page.getByRole('button', { name: '並べ替える', exact: true }).click();
        await list.locator('summary').focus();
      }
      await page.keyboard.press('Enter');
      await expect(search).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(search).toBeVisible();
      await expect(list.locator('summary')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
