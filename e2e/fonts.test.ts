import { expect, test } from './fixtures.ts';
import { applyTheme, signIn, watchViolations } from './helpers.ts';

test('4テーマで日本語と数字の全ての太さを自前の書体で描く（#1069）', async ({ page, context, baseURL }) => {
  const violations = await watchViolations(page);
  const fontUrls: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontUrls.push(request.url());
  });
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba');
  await expect(page.getByRole('heading', { name: '今日やること', exact: true })).toBeVisible();
  for (const theme of ['simple_light', 'simple_dark', 'medieval', 'modern']) {
    await applyTheme(page, theme);
    for (const [selector, weight] of [
      ['h1', theme === 'medieval' ? '900' : '700'],
      ['body', '400'],
      ['.pts', '500'],
    ]) {
      const element = page.locator(selector).first();
      await expect(element).toBeVisible();
      await expect(element).toHaveCSS('font-weight', weight);
      const font = await element.evaluate(async (el) => {
        const style = getComputedStyle(el);
        const loaded = await Promise.all(
          [...'今日012'].map(async (character) => {
            const faces = await document.fonts.load(
              `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
              character,
            );
            return faces.length > 0 && faces.every((face) => face.status === 'loaded');
          }),
        );
        return { family: style.fontFamily, loaded: loaded.every(Boolean) };
      });
      expect(font.family).toContain('Noto Sans JP');
      expect(font.loaded).toBe(true);
    }
  }
  // 全ての太さの字形の比較はテーマに依存しないため1回だけ行う。
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 60;
    const ctx = canvas.getContext('2d')!;
    const samples = [];
    for (const text of ['今日やること経験値バックログ', 'Aa0123456789']) {
      const weights = [];
      for (const weight of [400, 500, 600, 700, 900]) {
        const font = `${weight} 24px "Noto Sans JP"`;
        // 混在文字列の一部だけを読み込んで成功にしない。各文字の範囲が必要。
        const loaded = await Promise.all(
          [...text].map(async (character) => {
            const faces = await document.fonts.load(font, character);
            return faces.length > 0 && faces.every((face) => face.status === 'loaded');
          }),
        );
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = font;
        ctx.fillText(text, 0, 40);
        weights.push({ loaded: loaded.every(Boolean), pixels: canvas.toDataURL() });
      }
      samples.push(weights);
    }
    return { family: getComputedStyle(document.body).fontFamily, samples };
  });
  expect(result.family).toContain('Noto Sans JP');
  for (const weights of result.samples) {
    expect(weights.every((weight) => weight.loaded)).toBe(true);
    // 太さを削ってブラウザの擬似太字や同じ描画へ置き換える回帰を検出する。
    expect(new Set(weights.map((weight) => weight.pixels)).size).toBe(5);
  }
  expect(fontUrls.length).toBeGreaterThan(0);
  expect(fontUrls.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(await violations()).toEqual([]);
});
