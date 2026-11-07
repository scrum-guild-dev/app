// エピックの引き出し（#848）: 木のエピックの題を押すと開き、タイトル、本文、期日、リンクを押せば書けて自動で保存される。
// 引き出しの下から、エピックの画面（討伐隊、報酬、依頼主、クリア）へ移れる。ほかの人が先に同じ欄を直していたら、保存せずに知らせる。
// 一本道は作ったワークスペースで行い、seed の行は書き換えない。CSP の違反も確かめる
import { expect, test } from './fixtures.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { epicUpdate } from '../src/shared/operations/epic/epic-update.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { addEpicRow, createWorkspace, fillEpicFields, signIn, waitForResponses, watchViolations } from './helpers.ts';
import { rewriteOperation } from './operations.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
});

const SEED_WORKSPACE = '/aoba/w/019a0000-0000-7000-8000-000000000401';
const SEED_EPIC_TITLE = 'ポイントの交換先を増やす';

test('木のエピックの題を押すと引き出しが開き、タイトル、本文、期日、リンクを押せば書けて保存される。読み直しても残る', async ({
  page,
}) => {
  const collect = await watchViolations(page);
  await createWorkspace(page, 'エピックの引き出しのワークスペース');
  await addEpicRow(page, '会員ポイント制度を公開する');

  await page.getByRole('link', { name: '会員ポイント制度を公開する', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会員ポイント制度を公開する', exact: true })).toBeVisible();
  // タイトルを直すと引き出しの名前も替わるので、枠そのもので指す
  const drawer = page.locator('.drawer');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(page).toHaveURL(/\?epic=[0-9a-f-]{36}$/);
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  // 保存のボタンは無い。書いていない本文は「まだ書かれていません」
  await expect(drawer.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(drawer.locator('.doc-box.is-empty')).toHaveCount(1);

  // 本文を押して書き、欄を離れると保存されて、Markdown の箇条書きが描かれる
  const bodySaved = waitForResponses(page, '/epic-update');
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });
  await expect(body).toBeFocused();
  await body.fill('- 残高が見える\n- 失効日が分かる');
  await body.blur();
  await bodySaved;
  await expect(drawer.getByRole('listitem').filter({ hasText: '残高が見える' })).toBeVisible();
  await expect(drawer.getByRole('status').filter({ hasText: '保存しました' }).first()).toBeVisible();

  // タイトルは押して直し、Enter で保存する。引き出しの名前と木の題も替わる
  const titleSaved = waitForResponses(page, '/epic-update');
  await drawer.getByRole('heading', { level: 2 }).getByRole('button').click();
  const title = drawer.getByRole('textbox', { name: 'タイトル' });
  await title.fill('会員ポイント制度を春に公開する');
  await title.press('Enter');
  await titleSaved;
  await expect(page.getByRole('dialog', { name: '会員ポイント制度を春に公開する', exact: true })).toBeVisible();

  // 期日は選ぶと、少し待ってから保存される
  const dueSaved = waitForResponses(page, '/epic-update');
  const due = drawer.getByLabel('期日', { exact: true });
  await due.fill('2027-03-31');
  await due.blur();
  await dueSaved;

  // リンクは押して書く。使える URL なら「開く」が出る
  const linkSaved = waitForResponses(page, '/epic-update');
  await drawer.getByRole('button', { name: /リンクを/ }).click();
  const link = drawer.getByRole('textbox', { name: 'リンク' });
  await link.fill('https://example.com/spec');
  await link.press('Enter');
  await linkSaved;
  await expect(drawer.getByRole('link', { name: 'リンクを新しいタブで開く' })).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );

  // 閉じると URL から epic が外れ、フォーカスは題のリンクへ戻る。木の行に期日が出る
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/\?epic=/);
  const row = page.locator('.tree-row.is-epic', { hasText: '会員ポイント制度を春に公開する' });
  await expect(row.getByRole('link', { name: '会員ポイント制度を春に公開する', exact: true })).toBeFocused();
  await expect(row.locator('.chip')).toHaveText('03/31');

  // 読み直しても同じ。URL の ?epic= だけで引き出しが開く
  await page.reload();
  await row.getByRole('link', { name: '会員ポイント制度を春に公開する', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '会員ポイント制度を春に公開する', exact: true });
  await expect(reopened.getByRole('listitem').filter({ hasText: '失効日が分かる' })).toBeVisible();
  await expect(reopened.getByLabel('期日', { exact: true })).toHaveValue('2027-03-31');
  expect(await collect()).toEqual([]);
});

test('引き出しの下から、エピックの画面へ移れる。エピックの画面の「エピックを直す」でも同じ引き出しが開き、その画面では移るリンクを出さない', async ({
  page,
}) => {
  await page.goto(SEED_WORKSPACE);
  await page.getByRole('link', { name: SEED_EPIC_TITLE, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: SEED_EPIC_TITLE, exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'エピックの画面を開く' }).click();
  await expect(page.getByRole('heading', { level: 1, name: SEED_EPIC_TITLE })).toBeVisible();
  await expect(drawer).toBeHidden();

  const edit = page.getByRole('link', { name: 'エピックを直す' });
  await edit.click();
  const again = page.getByRole('dialog', { name: SEED_EPIC_TITLE, exact: true });
  await expect(again.getByRole('button', { name: '本文を書く' })).toBeVisible();
  await expect(again.getByRole('link', { name: 'エピックの画面を開く' })).toHaveCount(0);
  // 閉じると、開いたリンクへフォーカスが戻る
  await page.keyboard.press('Escape');
  await expect(again).toBeHidden();
  await expect(edit).toBeFocused();
});

test('ほかの人が先に同じ欄を直していたら、保存せずに今の値を知らせ、書いた分は欄に残る。続けて書くと上書きする', async ({
  page,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await createWorkspace(page, 'エピックが先に直されるワークスペース');
  await addEpicRow(page, '先に直される');
  await fillEpicFields(page, baseURL, '先に直される', { body_md: '元の本文' });
  const workspaceId = new URL(page.url()).pathname.split('/')[3]!;
  const epicId = (await page.getByRole('link', { name: '先に直される', exact: true }).getAttribute('data-epic-id'))!;

  await page.getByRole('link', { name: '先に直される', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '先に直される', exact: true });
  await drawer.getByRole('button', { name: '本文を書く' }).click();
  const body = drawer.getByRole('textbox', { name: '本文' });
  await expect(body).toHaveValue('元の本文');

  // 書き始めた後に、ほかの人が同じ欄を直した形にする（本物の API へ、別の経路から書く）
  const other = await page.request.post(operationPath(epicUpdate, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin, 'Content-Type': 'application/json' },
    data: { workspace_id: workspaceId, epic_id: epicId, body_md: '先に直された本文' },
  });
  expect(other.status()).toBe(200);

  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(operationPath(epicUpdate, 'aoba'))) requests.push(request.postDataJSON());
  });
  await body.fill('自分が書いた本文');
  await body.blur();
  const alert = drawer.getByRole('alert').filter({ hasText: 'ほかの人が先に直しました' });
  await expect(alert).toContainText('今の内容は「先に直された本文」です');
  await expect(alert).toContainText('書いた内容は残してあります');
  await expect(body).toHaveValue('自分が書いた本文');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ body_md: '自分が書いた本文', expected: { body_md: '元の本文' } });

  // 続けて書くと、今の値を読んだものとして送るので、書いた内容で上書きされる
  const saved = waitForResponses(page, '/epic-update');
  await body.fill('読んだ上で書き直した本文');
  await saved;
  await expect(alert).toHaveCount(0);
  expect(requests[1]).toMatchObject({ expected: { body_md: '先に直された本文' } });
});

test('終了したワークスペースでは、引き出しを読み取り専用で開く。直す口も「⋯」も出さない', async ({ page }) => {
  await rewriteOperation(page, workspaceInfo, { slug: 'aoba' }, (output) => ({
    ...output,
    closed_at: '2026-10-21T00:00:00.000Z',
  }));
  await page.goto(SEED_WORKSPACE);
  await expect(page.getByRole('textbox', { name: /エピックを足す/ })).toHaveCount(0);
  await page.getByRole('link', { name: SEED_EPIC_TITLE, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: SEED_EPIC_TITLE, exact: true });
  await expect(drawer.getByText(/読み取りだけできます/)).toBeVisible();
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: `操作: ${SEED_EPIC_TITLE}` })).toHaveCount(0);
  await expect(drawer.getByRole('link', { name: 'エピックの画面を開く' })).toBeVisible();
});
