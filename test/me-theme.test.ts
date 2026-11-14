// 自分のテーマの変更（me-theme-update）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは、呼んだ人の行だけが変わること、別の組織の同じアカウントの行と同じ組織の別の人の行が変わらないこと、
// 選んでいない人（NULL）と消した中世風（medieval）の行がシンプル（自動）として返ること、変更の履歴に出ないこと、入力の検証を確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { meThemeUpdate, organizationHistory, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createUser, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function update(target: Target, person: Person, body: unknown) {
  return post(app, meThemeUpdate, { slug: target.slug, token: person.token, body });
}

async function userRow(organization: OrganizationFixture, userId: string) {
  const db = orgDb(env, organization.verified);
  const row = await db.first(
    db.statement((q) => q.selectFrom('users').select(['theme', 'updated_at']).where('id', '=', userId)),
  );
  return row!;
}

async function changeLogCount(organization: OrganizationFixture): Promise<number> {
  const db = orgDb(env, organization.verified);
  return (
    await db.rows(
      db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', organization.id)),
    )
  ).length;
}

async function infoOf(target: Target, person: Person) {
  const res = await post(app, organizationInfo, { slug: target.slug, token: person.token });
  expect(res.status).toBe(200);
  return (await res.json()) as { organization: Record<string, unknown>; me: { theme: string } };
}

describe('me-theme-update', () => {
  test('呼んだ人の users.theme だけを書き、書いた後の値を返す。ほかの人の行は変わらない', async () => {
    const target = await createTarget();
    const before = await userRow(target.organization, target.member.userId!);
    const others = {
      admin: await userRow(target.organization, target.admin.userId!),
      leader: await userRow(target.organization, target.leader.userId!),
    };

    const res = await update(target, target.member, { theme: 'modern' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'modern' });

    const after = await userRow(target.organization, target.member.userId!);
    expect(after.theme).toBe('modern');
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(await userRow(target.organization, target.admin.userId!)).toEqual(others.admin);
    expect(await userRow(target.organization, target.leader.userId!)).toEqual(others.leader);

    // 組織の枠の値: 自分のテーマが入る。組織の既定のテーマは返さない。選んでいないほかの人はシンプル（自動）
    const info = await infoOf(target, target.member);
    expect(info.me.theme).toBe('modern');
    expect(info.organization).not.toHaveProperty('theme');
    expect((await infoOf(target, target.leader)).me.theme).toBe('simple');
  });

  test('4つのテーマをどれも書ける', async () => {
    const target = await createTarget();
    for (const theme of ['simple', 'simple_light', 'simple_dark', 'modern']) {
      const res = await update(target, target.leader, { theme });
      expect(res.status).toBe(200);
      expect((await userRow(target.organization, target.leader.userId!)).theme).toBe(theme);
    }
  });

  test('null（組織の既定に従う）と、消した中世風（medieval）は 400 で、何も書かれない', async () => {
    const target = await createTarget();
    await update(target, target.member, { theme: 'modern' });
    for (const theme of [null, 'medieval']) {
      const res = await update(target, target.member, { theme });
      expect(res.status).toBe(400);
    }
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('modern');
  });

  test('DB に残った中世風（medieval）の行は、組織の枠でシンプル（自動）として返る', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ theme: 'medieval' })
          .where('id', '=', target.member.userId!)
          .where('organization_id', '=', target.organization.id),
      ),
    ]);
    expect((await infoOf(target, target.member)).me.theme).toBe('simple');
  });

  test('同じ値をもう一度送っても成功する（最後に書いた値が残る）', async () => {
    const target = await createTarget();
    expect((await update(target, target.member, { theme: 'simple_dark' })).status).toBe(200);
    expect((await update(target, target.member, { theme: 'simple_dark' })).status).toBe(200);
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('simple_dark');
  });

  test('ワークスペースに所属しない管理者も、別のワークスペースだけに所属する人も、自分の行を書ける', async () => {
    const target = await createTarget();
    expect((await update(target, target.admin, { theme: 'simple_light' })).status).toBe(200);
    expect((await userRow(target.organization, target.admin.userId!)).theme).toBe('simple_light');
    expect((await update(target, target.bystander, { theme: 'modern' })).status).toBe(200);
    expect((await userRow(target.organization, target.bystander.userId!)).theme).toBe('modern');
  });

  test('変更の履歴（change_logs）に残さず、組織の変更の履歴の画面にも出ない', async () => {
    const target = await createTarget();
    const readHistory = async () => {
      const history = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token, body: {} });
      expect(history.status).toBe(200);
      return ((await history.json()) as { entries: unknown[] }).entries;
    };
    const before = await changeLogCount(target.organization);
    const entriesBefore = await readHistory();
    await update(target, target.member, { theme: 'modern' });
    await update(target, target.member, { theme: 'simple_light' });
    expect(await changeLogCount(target.organization)).toBe(before);
    expect(await readHistory()).toEqual(entriesBefore);
  });

  test('同じアカウントの別の組織の users の行は変わらない（組織で絞る）', async () => {
    const target = await createTarget();
    const other = await createTarget();
    // target の一般のメンバーと同じアカウントの行を、other の組織にも作る
    const there = await createUser(other.organization, {
      account_id: target.member.accountId,
      login_provider: target.member.login.provider,
      login_subject: target.member.login.subject,
    });

    const res = await post(app, meThemeUpdate, {
      slug: target.slug,
      token: target.member.token,
      body: { theme: 'modern' },
    });
    expect(res.status).toBe(200);
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('modern');
    expect((await userRow(other.organization, there.id)).theme).toBeNull();
  });

  test('別の組織の slug で呼ぶと、自分の組織の行は変わらない（その組織に入れない人は 404）', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const res = await update(other, target.member, { theme: 'modern' });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
    expect((await userRow(target.organization, target.member.userId!)).theme).toBeNull();
    expect((await userRow(other.organization, other.member.userId!)).theme).toBeNull();
  });

  test('承諾待ちの招待だけの人（users の行が無い人）は 404 で、何も書かれない', async () => {
    const target = await createTarget();
    const res = await update(target, target.invitee, { theme: 'modern' });
    expect(res.status).toBe(404);
    const db = orgDb(env, target.organization.verified);
    const themed = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select('id')
          .where('organization_id', '=', target.organization.id)
          .where('theme', 'is not', null),
      ),
    );
    expect(themed).toEqual([]);
  });

  test('テーマの値でない文字、欠けた項目は 400 で、何も書かれない。入力に user_id を足しても捨てられ、ほかの人の行は書けない', async () => {
    const target = await createTarget();
    for (const body of [{ theme: 'neon' }, {}, { theme: '' }, { theme: 3 }, { theme: null }]) {
      const res = await update(target, target.member, body);
      expect(res.status).toBe(400);
    }
    expect((await userRow(target.organization, target.member.userId!)).theme).toBeNull();

    const res = await update(target, target.member, { theme: 'modern', user_id: target.admin.userId });
    expect(res.status).toBe(200);
    expect((await userRow(target.organization, target.admin.userId!)).theme).toBeNull();
    expect((await userRow(target.organization, target.member.userId!)).theme).toBe('modern');
  });
});
