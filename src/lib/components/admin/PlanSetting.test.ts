// プランの節（PlanSetting.svelte）を svelte/server で HTML にして、契約のある組織、未契約のチーム用、契約の無い自分用の出し分けを確かめる
import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import PlanSetting from './PlanSetting.svelte';

const GIB = 1024 ** 3;
type Props = Parameters<typeof render<typeof PlanSetting>>[1] extends { props?: infer P } ? P : never;

const bodyOf = (props: Props) =>
  render(PlanSetting, { props })
    .body.replace(/<!--.*?-->/gs, '')
    .replaceAll('\u00a0', ' ');

test('契約のある組織は、契約、追加容量の口数、人数と添付ファイルの上限、問い合わせの案内を出す', () => {
  const body = bodyOf({
    kind: 'team',
    plan: {
      contract: { plan: 'team', billing_interval: 'monthly', extra_10gb_units: 2, extra_50gb_units: 1 },
      member_limit: 15,
      attachment_quota_bytes: 100 * GIB,
    },
  });
  expect(body).toContain('チーム・月払い');
  expect(body).toContain('+10 GB × 2 口、+50 GB × 1 口');
  expect(body).toContain('15 人');
  expect(body).toContain('100 GB');
  expect(body).toContain('運用者に問い合わせてください');
  expect(body).not.toContain('未契約');
});

test('追加容量の口数が無い契約は「なし」と出す', () => {
  const body = bodyOf({
    kind: 'team',
    plan: {
      contract: { plan: 'business', billing_interval: 'yearly', extra_10gb_units: 0, extra_50gb_units: 0 },
      member_limit: 50,
      attachment_quota_bytes: 100 * GIB,
    },
  });
  expect(body).toContain('ビジネス・年払い');
  expect(body).toMatch(/<dt>追加容量<\/dt>\s*<dd>\s*なし\s*<\/dd>/);
});

test('未契約のチーム用の組織は「未契約」と今の上限を出し、追加容量は出さない', () => {
  const body = bodyOf({
    kind: 'team',
    plan: { contract: null, member_limit: 20, attachment_quota_bytes: 40 * GIB },
  });
  expect(body).toContain('<span class="chip">未契約</span>');
  expect(body).toContain('20 人');
  expect(body).toContain('40 GB');
  expect(body).toContain('まだ契約していません');
  expect(body).not.toContain('<dt>追加容量</dt>');
  expect(body).toContain('運用者に問い合わせてください');
});

test('契約の無い自分用の組織は「パーソナル」と出し、「未契約」とは出さない', () => {
  const body = bodyOf({
    kind: 'personal',
    plan: { contract: null, member_limit: 1, attachment_quota_bytes: GIB },
  });
  expect(body).toContain('パーソナル');
  expect(body).not.toContain('未契約');
  expect(body).toContain('1 人');
  expect(body).toContain('1 GB');
});
