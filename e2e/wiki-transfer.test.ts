import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, watchViolations } from './helpers.ts';
import { resetWikiRateLimits } from './local-d1.ts';
import { failOperation, routeOperation } from './operations.ts';
import { orgWikiUpload } from '../src/shared/operations/wiki/index.ts';

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await resetWikiRateLimits();
});

for (const scope of ['organization', 'workspace'] as const) {
  test(`${scope}: 不正なファイルを外して一括作成し、.mdを落として上げ直せる`, async ({ page }) => {
    const violations = await watchViolations(page);
    const suffix = `${test.info().repeatEachIndex}-${test.info().retry}-${crypto.randomUUID().slice(0, 8)}`;
    if (scope === 'workspace') await createWorkspace(page, `Wiki取り込みの確認-${suffix}`);
    const root = scope === 'organization' ? '/aoba/wiki' : new URL(page.url()).pathname + '/wiki';
    await page.goto(root);
    const title = `手順-${suffix}`;
    const markdown = `---\ntitle: "${title}"\nowner: 青葉\n---\n# 本文\n手順を残す\n`;
    let requests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('-wiki-upload')) requests++;
    });
    await page.getByRole('button', { name: '.md を上げる', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '.md を上げる', exact: true });
    await dialog.locator('input[type=file]').setInputFiles([
      { name: `取り込み元-${suffix}.md`, mimeType: 'text/markdown', buffer: Buffer.from(markdown) },
      { name: `補足-${suffix}.md`, mimeType: 'text/markdown', buffer: Buffer.from('補足の本文') },
      { name: '取り込めない.txt', mimeType: 'text/plain', buffer: Buffer.from('本文') },
    ]);
    await expect(dialog.getByText('.md ではないため、足せません。', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '3 件をページとして足す', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await dialog.getByRole('button', { name: '3 件をページとして足す', exact: true }).click({ force: true });
    expect(requests).toBe(0);
    await dialog.getByRole('button', { name: '取り込めない.txtを外す', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toBeFocused();
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await dialog.getByRole('button', { name: '2 件をページとして足す', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('link', { name: title, exact: true }).first()).toBeVisible();
    await page.getByRole('link', { name: title, exact: true }).first().click();
    await expect(page.locator('.wiki-main h2').first()).toHaveText(title);
    await expect(page.locator('.wiki-main').getByRole('cell', { name: '青葉', exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '.md で落とす', exact: true }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).not.toBeNull();
    expect(await readFile(path!, 'utf8')).toBe(markdown);
    await page.getByRole('button', { name: '.md を上げる', exact: true }).click();
    await dialog.getByLabel('足す場所（親のページ）').selectOption('');
    await dialog.locator('input[type=file]').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'text/markdown',
      buffer: await readFile(path!),
    });
    await dialog.getByRole('button', { name: '1 件をページとして足す', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.goto(root);
    await expect(page.locator('.wiki-tree').getByRole('link', { name: title, exact: true })).toHaveCount(2);
    expect(await violations()).toEqual([]);
  });
}

test('取り込みの失敗でも選択と親を残し、UTF-8以外をファイルごとに示す', async ({ page }) => {
  await page.goto('/aoba/wiki');
  await page.getByRole('button', { name: '.md を上げる', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '.md を上げる', exact: true });
  await dialog.locator('input[type=file]').setInputFiles([
    { name: '正常.md', mimeType: 'text/markdown', buffer: Buffer.from('本文') },
    { name: '文字コード.md', mimeType: 'text/markdown', buffer: Buffer.from([0x82, 0xa0]) },
  ]);
  await expect(dialog.getByText('UTF-8のファイルを選んでください。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '文字コード.mdを外す', exact: true }).click();
  await failOperation(page, orgWikiUpload, { slug: 'aoba' }, 429, 'rate_limited');
  await dialog.getByRole('button', { name: '1 件をページとして足す', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('取り込む件数の上限に達しました');
  await expect(dialog.locator('.file-name')).toHaveText('正常.md');
  await expect(dialog.getByLabel('足す場所（親のページ）')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '1 件をページとして足す', exact: true })).toHaveAttribute(
    'aria-disabled',
    'false',
  );
});

for (const lostResponse of ['通信失敗', '壊れた成功応答'] as const) {
  test(`保存後に${lostResponse}となったとき、一覧の確認を済ませるまで再送しない`, async ({ page }) => {
    const title = `応答を失った取り込み-${crypto.randomUUID().slice(0, 8)}`;
    await page.goto('/aoba/wiki');
    await page.getByRole('button', { name: '.md を上げる', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '.md を上げる', exact: true });
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: title + '.md', mimeType: 'text/markdown', buffer: Buffer.from('本文') });
    let sent = 0;
    const unroute = await routeOperation(page, orgWikiUpload, { slug: 'aoba' }, async (call) => {
      sent++;
      await call.fetch();
      if (lostResponse === '通信失敗') await call.abort();
      else await call.route.fulfill({ status: 200, contentType: 'application/json', body: '{"pages":[' });
    });
    const submit = dialog.getByRole('button', { name: '1 件をページとして足す', exact: true });
    await submit.click();
    await expect(dialog.getByText('保存されたか確認できません。', { exact: false })).toBeVisible();
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await dialog.getByRole('button', { name: 'ページの一覧を読み直す', exact: true }).click();
    await expect(dialog.getByText(title, { exact: true })).toBeVisible();
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(sent).toBe(1);
    await unroute();
    await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(page.locator('.wiki-tree').getByRole('link', { name: title, exact: true })).toHaveCount(1);
  });
}
