import type { Page } from '@playwright/test';
import type { OutputOf } from '../src/shared/operations/define.ts';
import type { TodayTask } from '../src/shared/operations/organization/today.ts';
import { today } from '../src/shared/operations/organization/today.ts';
import { listOrganizations } from '../src/shared/operations/operator/list-organizations.ts';
import { organizationResume } from '../src/shared/operations/operator/organization-resume.ts';
import { organizationSuspend } from '../src/shared/operations/operator/organization-suspend.ts';
import { organizationSuspensionUpdate } from '../src/shared/operations/operator/organization-suspension-update.ts';
import { organizationQuotaUpdate } from '../src/shared/operations/operator/organization-quota-update.ts';
import { taskComplete } from '../src/shared/operations/task/task-complete.ts';
import { expect, test } from './fixtures.ts';
import {
  A11Y_THEMES,
  addEpicRow,
  addStoryRow,
  addTaskRow,
  applyTheme,
  createWorkspace,
  signIn,
  waitForSettled,
} from './helpers.ts';
import { failOperation, routeOperation } from './operations.ts';

type Motion = { name: string; target: string; element: string; label: string; duration: string };

// 260ms の途中をポーリングせず、操作前からブラウザが発火した演出を記録する。
async function watchMotion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: Motion[] = [];
    Reflect.set(window, '__rowMotion', events);
    const record = (event: AnimationEvent | TransitionEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (
        !target.matches(
          '.entry, .tree-row, .drawer, .scrim, .dialog-sheet, .table tbody tr, .table tbody td.is-actions',
        )
      )
        return;
      const animation = event instanceof AnimationEvent;
      const labelled = target.matches('td') ? target.closest('tr') : target;
      events.push({
        name: animation ? event.animationName : event.propertyName,
        target: target.className,
        element: target.tagName,
        label: labelled?.querySelector('.entry-title, .tree-title a, td')?.textContent?.trim() ?? '',
        duration: animation ? getComputedStyle(target).animationDuration : getComputedStyle(target).transitionDuration,
      });
    };
    document.addEventListener('animationstart', record);
    document.addEventListener('transitionrun', record);
  });
}

async function motions(page: Page): Promise<Motion[]> {
  return page.evaluate(() => Reflect.get(window, '__rowMotion') as Motion[]);
}

async function clearMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    (Reflect.get(window, '__rowMotion') as Motion[]).length = 0;
  });
}

async function expectDrawerEntrance(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      (await motions(page))
        .filter((entry) => /\bdrawer\b/.test(entry.target))
        .map((entry) => entry.name)
        .sort(),
    )
    .toEqual(['opacity', 'transform']);
  const entering = (await motions(page)).filter((entry) => /\bdrawer\b/.test(entry.target));
  expect(entering.every((entry) => entry.duration.split(',').every((part) => parseFloat(part) <= 0.26))).toBe(true);
  await expect
    .poll(async () => (await motions(page)).some((entry) => /\bscrim\b/.test(entry.target) && entry.name === 'opacity'))
    .toBe(true);
  // networkidle は CSS の開始・終了を待たない。開始を観測して、対象の演出が終わってから
  // 記録を消す。直前の出現が、次の「動かない」操作の記録に混ざるのを防ぐ。
  await page.evaluate(async () => {
    const animations = [...document.querySelectorAll('.drawer, .scrim')].flatMap((element) => element.getAnimations());
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test('4テーマで引き出しは最初だけ出現し、前後移動とページ全体では動かない。ダイアログも短く出る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await watchMotion(page);
  await createWorkspace(page, '面の出現を確かめる');
  await addTaskRow(page, '出現の一');
  await addTaskRow(page, '出現の二');
  await waitForSettled(page);

  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    await clearMotion(page);
    await page.getByRole('link', { name: '出現の一', exact: true }).click();
    const drawer = page.locator('.drawer');
    await expect(drawer).toBeVisible();
    await expectDrawerEntrance(page);
    await waitForSettled(page);
    await clearMotion(page);
    await drawer.getByRole('button', { name: '次のタスク', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '出現の二' })).toBeVisible();
    await waitForSettled(page);
    expect((await motions(page)).filter((entry) => /\bdrawer\b|\bscrim\b/.test(entry.target))).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  }

  await clearMotion(page);
  await page.getByRole('link', { name: '出現の一', exact: true }).click();
  await expectDrawerEntrance(page);
  await waitForSettled(page);
  await clearMotion(page);
  await page.locator('.drawer').getByRole('button', { name: 'ページ全体', exact: true }).click();
  await expect(page.locator('.drawer.is-page')).toBeVisible();
  await waitForSettled(page);
  expect((await motions(page)).filter((entry) => /\bdrawer\b|\bscrim\b/.test(entry.target))).toEqual([]);

  await page.goto('/aoba/admin');
  await waitForSettled(page);
  await clearMotion(page);
  await page.getByRole('button', { name: 'ワークスペースを作る' }).first().click();
  await expect
    .poll(async () =>
      (await motions(page)).filter((entry) => /\bdialog-sheet\b/.test(entry.target)).map((entry) => entry.name),
    )
    .toEqual(['toast-in']);
  expect(
    (await motions(page))
      .filter((entry) => /\bdialog-sheet\b/.test(entry.target))
      .every((entry) => parseFloat(entry.duration) <= 0.26),
  ).toBe(true);
});

test('追加したタスク・ストーリー・エピックだけが一度光り、読み直しても光り直さない', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await watchMotion(page);
  await createWorkspace(page, '行の合図を確かめる');
  for (const [title, add] of [
    ['光るタスク', addTaskRow],
    ['光るストーリー', addStoryRow],
    ['光るエピック', addEpicRow],
  ] as const) {
    await clearMotion(page);
    await add(page, title);
    await expect
      .poll(
        async () =>
          (await motions(page)).filter((entry) => entry.name === 'drop-flash' && entry.label === title).length,
      )
      .toBe(1);
  }
  await page.reload();
  await waitForSettled(page);
  expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
});

const taskId = '019a0000-0000-7000-8000-000000009101';
const workspaceId = '019a0000-0000-7000-8000-000000000401';

function todayTask(): TodayTask {
  return {
    id: taskId,
    title: '移った行の合図',
    points: null,
    due_on: null,
    today_on: '2026-11-04',
    completed_at: null,
    workspace_id: workspaceId,
    workspace_name: '受託開発チーム',
    today: '2026-11-04',
    week_start: 1,
    position: 'a0',
    carry_days: 0,
    sprint_active: false,
    is_today_completed: false,
    reopenable: false,
    assignee: null,
    repository: null,
    sprint: null,
  };
}

for (const reduced of [false, true]) {
  test(`今日の完了に移った行は${reduced ? '動きを減らす設定では光らない' : '成功時だけ光る'}`, async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await watchMotion(page);
    const task = todayTask();
    await routeOperation(page, today, { slug: 'aoba' }, (call) => call.fulfill({ tasks: [task], sprint_goals: [] }));
    await routeOperation(page, taskComplete, { slug: 'aoba' }, (call) => {
      task.completed_at = '2026-11-04T03:00:00.000Z';
      task.is_today_completed = true;
      task.reopenable = true;
      return call.fulfill({ task_id: taskId, completed_at: task.completed_at, left_sprint: false, xp_granted: 0 });
    });
    const removeFailure = await failOperation(page, taskComplete, { slug: 'aoba' }, 500, 'internal');
    await page.goto('/aoba');
    await page.getByRole('button', { name: '完了にする: 移った行の合図' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'できませんでした' })).toBeVisible();
    expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
    await removeFailure();
    await page.getByRole('button', { name: '完了にする: 移った行の合図' }).click();
    await expect(
      page
        .getByRole('region', { name: '今日の完了', exact: true })
        .getByRole('link', { name: task.title, exact: true }),
    ).toBeVisible();
    await frames(page);
    if (reduced) expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
    else
      await expect
        .poll(
          async () =>
            (await motions(page)).filter((entry) => entry.name === 'drop-flash' && entry.label === task.title).length,
        )
        .toBe(1);
    await page.reload();
    await waitForSettled(page);
    expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
  });
}

test('運用の再開に成功して読み直した行だけが光り、失敗や初回表示は光らない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'operator');
  await watchMotion(page);
  const organization = {
    slug: 'hibari',
    name: 'ひばり工房',
    kind: 'team' as const,
    suspended_at: '2026-10-10T00:00:00.000Z' as string | null,
    purge_on: null,
    purge_due: false,
    created_at: '2026-10-01T09:30:00.000Z',
    admin_status: 'active' as const,
    seats: { used: 5, limit: 15 },
    workspace_count: 3,
    task_count: 12,
    attachment_quota_bytes: 32212254720,
    last_used_at: '2026-10-20T00:12:00.000Z',
    self_created: false,
    trial_ends_on: null,
    trial_expired: false,
  };
  await routeOperation(page, listOrganizations, (call) => call.fulfill({ organizations: [organization] }));
  await routeOperation(page, organizationResume, (call) => {
    organization.suspended_at = null;
    return call.fulfill({ slug: organization.slug });
  });
  const removeFailure = await failOperation(page, organizationResume, 500, 'internal');
  await page.goto('/operator');
  await waitForSettled(page);
  expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
  await page.getByRole('button', { name: '「ひばり工房」を再開する' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'できませんでした' })).toBeVisible();
  expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
  await removeFailure();
  await page.getByRole('button', { name: '「ひばり工房」を再開する' }).click();
  await expect
    .poll(
      async () =>
        (await motions(page)).filter(
          (entry) => entry.name === 'drop-flash' && entry.element === 'TR' && entry.label.includes('ひばり工房'),
        ).length,
    )
    .toBe(1);
  await page.reload();
  await waitForSettled(page);
  expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
});

type ListedOrganization = OutputOf<typeof listOrganizations>['organizations'][number];

function motionOrganization(): ListedOrganization {
  return {
    slug: 'motion-organization',
    name: '合図の組織',
    kind: 'team',
    suspended_at: null,
    purge_on: null,
    purge_due: false,
    created_at: '2026-10-01T09:30:00.000Z',
    admin_status: 'active',
    seats: { used: 5, limit: 15 },
    workspace_count: 3,
    task_count: 12,
    attachment_quota_bytes: 30 * 1024 ** 3,
    last_used_at: '2026-10-20T00:12:00.000Z',
    self_created: false,
    trial_ends_on: null,
    trial_expired: false,
  };
}

for (const operation of ['停止', '理由変更', '上限変更'] as const) {
  for (const outcome of ['成功', 'state_changed', 'unavailable'] as const) {
    test(`運用の${operation}は${outcome === '成功' ? '成功時だけ行と操作セルが一度光る' : `${outcome}では行も操作セルも光らない`}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await signIn(context, baseURL, 'operator');
      await watchMotion(page);
      const organization = motionOrganization();
      const other = { ...motionOrganization(), slug: 'untouched', name: '変えない組織' };
      if (operation === '理由変更') organization.suspended_at = '2026-10-10T00:00:00.000Z';
      await routeOperation(page, listOrganizations, (call) => call.fulfill({ organizations: [organization, other] }));
      if (operation === '停止') {
        await routeOperation(page, organizationSuspend, (call) => {
          if (outcome !== '成功')
            return call.fail(
              outcome === 'state_changed' ? 409 : 404,
              outcome === 'state_changed' ? 'conflict' : 'not_found',
            );
          organization.suspended_at = '2026-11-10T00:00:00.000Z';
          return call.fulfill({ slug: organization.slug, suspended_at: organization.suspended_at, purge_on: null });
        });
      } else if (operation === '理由変更') {
        await routeOperation(page, organizationSuspensionUpdate, (call) => {
          if (outcome !== '成功')
            return call.fail(
              outcome === 'state_changed' ? 409 : 404,
              outcome === 'state_changed' ? 'conflict' : 'not_found',
            );
          organization.purge_on = '2026-12-10';
          return call.fulfill({ slug: organization.slug, purge_on: organization.purge_on });
        });
      } else {
        await routeOperation(page, organizationQuotaUpdate, (call) => {
          if (outcome !== '成功')
            return call.fail(
              outcome === 'state_changed' ? 409 : 404,
              outcome === 'state_changed' ? 'conflict' : 'not_found',
            );
          organization.seats.limit = call.input.member_limit;
          organization.attachment_quota_bytes = call.input.attachment_quota_bytes;
          return call.fulfill({
            slug: organization.slug,
            member_limit: call.input.member_limit,
            attachment_quota_bytes: call.input.attachment_quota_bytes,
          });
        });
      }
      await page.goto('/operator');
      await waitForSettled(page);
      expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
      const openLabel =
        operation === '停止'
          ? '「合図の組織」を停止する'
          : operation === '理由変更'
            ? '「合図の組織」の停止の理由を変える'
            : '「合図の組織」の人数と容量の上限を変える';
      await page.getByRole('button', { name: openLabel }).click();
      const dialog = page.getByRole('dialog', {
        name:
          operation === '停止'
            ? '組織を停止する'
            : operation === '理由変更'
              ? '停止の理由を変える'
              : '人数と添付ファイルの上限を変える',
      });
      if (operation === '理由変更') await dialog.getByRole('radio', { name: /解約/ }).check();
      if (operation === '上限変更') await dialog.getByRole('radio', { name: /標準/ }).check();
      await dialog
        .getByRole('button', { name: operation === '停止' ? '「合図の組織」を停止する' : '変える', exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await waitForSettled(page);
      await frames(page);
      if (outcome === '成功') {
        // 狭い幅では操作セルが地の色を持つ。行だけでなく、そのセルにも同じ光が出る。
        await expect
          .poll(async () =>
            (await motions(page))
              .filter((entry) => entry.name === 'drop-flash')
              .map((entry) => ({ element: entry.element, target: entry.label.includes(organization.name) }))
              .sort((a, b) => a.element.localeCompare(b.element)),
          )
          .toEqual([
            { element: 'TD', target: true },
            { element: 'TR', target: true },
          ]);
      } else {
        const notice = outcome === 'state_changed' ? '状態が変わっていました' : '操作できませんでした';
        await expect(page.getByRole('status').filter({ hasText: notice })).toBeVisible();
        expect((await motions(page)).filter((entry) => entry.name === 'drop-flash')).toEqual([]);
      }
    });
  }
}

test('動きを減らす設定では面の出現も追加行の光も出ない', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await watchMotion(page);
  await createWorkspace(page, '動かさない見本');
  await clearMotion(page);
  await addTaskRow(page, '動かない追加行');
  await page.getByRole('link', { name: '動かない追加行', exact: true }).click();
  await expect(page.locator('.drawer')).toBeVisible();
  await frames(page);
  expect(
    (await motions(page)).filter(
      (entry) => entry.name === 'drop-flash' || /\bdrawer\b|\bscrim\b|\bdialog-sheet\b/.test(entry.target),
    ),
  ).toEqual([]);
  await expect(page.locator('.drawer')).toHaveCSS('transition-duration', '0s');
});
