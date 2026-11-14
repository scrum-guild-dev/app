// #267: seed の所属は変えず、作ったワークスペースの離脱を本物の API で確認する。
import { operationPath } from '../src/shared/operations/define.ts';
import { epicCreate, epicPartyJoin } from '../src/shared/operations/epic/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn } from './helpers.ts';

test('メンバーの画面から抜けると、エピックの参加者から外れ、作成者の表示は離脱済みで残る', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  const name = `討伐隊離脱確認${Date.now()}`;
  await createWorkspace(page, name);
  const workspacePath = new URL(page.url()).pathname;
  const workspaceId = workspacePath.split('/').at(-1)!;
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post(operationPath(epicCreate, 'aoba'), {
    headers,
    data: epicCreate.input.parse({ workspace_id: workspaceId, title: '離脱後の討伐隊を確認する' }),
  });
  expect(created.ok()).toBe(true);
  const { epic } = epicCreate.output.parse(await created.json());
  const joined = await page.request.post(operationPath(epicPartyJoin, 'aoba'), {
    headers,
    data: epicPartyJoin.input.parse({ workspace_id: workspaceId, epic_id: epic.id }),
  });
  expect(joined.ok()).toBe(true);

  const epicPath = `${workspacePath}/epics/${epic.id}`;
  await page.goto(epicPath);
  const party = page.getByRole('region', { name: '参加者' });
  await expect(party.locator('.party-list > li')).toHaveCount(1);
  await expect(party).toContainText('ミナト');

  await page.goto(`${workspacePath}/members`);
  await page.getByRole('button', { name: `${name}から抜ける` }).click();
  await page
    .getByRole('dialog', { name: `${name}から抜けますか` })
    .getByRole('button', { name: '抜ける' })
    .click();
  await expect(page).toHaveURL(/\/aoba$/);
  // 管理者は所属を終えたワークスペースも読める。
  await page.goto(epicPath);
  await expect(party.locator('.party-list > li')).toHaveCount(0);
  await expect(party.getByText('参加者はまだいません')).toBeVisible();
  await expect(page.getByRole('region', { name: '概要' }).locator('dd').nth(0)).toContainText('離脱済み');
});
