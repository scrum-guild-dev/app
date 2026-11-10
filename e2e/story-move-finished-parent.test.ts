// 親の終了状態だけを差し替え、seed には書き込まない。
import { backlogTree } from '../src/shared/operations/task/backlog-tree.ts';
import { expect, test } from './fixtures.ts';
import { rowMenuItem, rowMenuToggle, signIn } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

const WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const FINISHED_AT = '2026-10-22T00:00:00.000Z';

for (const state of ['active', 'completed', 'canceled', 'root'] as const) {
  test(`${state}: 終了した親の配下だけ「親を移す」を出さず、並べ替えは残す`, async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
    let title = '';
    await rewriteOperation(page, backlogTree, { slug: 'aoba' }, (output) => {
      const epic = output.epics.find((entry) => entry.stories.length > 0)!;
      const story = epic.stories[0]!;
      title = story.title;
      return {
        ...output,
        epics: output.epics.map((entry) =>
          entry.id !== epic.id
            ? entry
            : {
                ...entry,
                completed_at: state === 'completed' ? FINISHED_AT : null,
                canceled_at: state === 'canceled' ? FINISHED_AT : null,
                stories:
                  state === 'root'
                    ? entry.stories.slice(1)
                    : state === 'completed'
                      ? entry.stories.map((child) => ({ ...child, completed_at: FINISHED_AT }))
                      : entry.stories,
              },
        ),
        // 親は epics 配下か最上段の stories かで表す。出力のストーリーに epic_id は無い。
        stories: state === 'root' ? [...output.stories, story] : output.stories,
      };
    });
    await page.goto(WORKSPACE);
    await expect(page.locator('.tree')).toHaveAttribute('aria-busy', 'false');
    await rowMenuToggle(page, title).click();
    const move = rowMenuItem(page, title, '親を移す');
    if (state === 'completed' || state === 'canceled') await expect(move).toHaveCount(0);
    else await expect(move).toBeVisible();
    await expect(rowMenuItem(page, title, '上へ')).toBeVisible();
    await expect(rowMenuItem(page, title, '下へ')).toBeVisible();
  });
}
