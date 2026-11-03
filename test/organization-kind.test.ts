// 組織の種類（kind: 'team' | 'personal'）を返す応答（#733）。my-organizations の organizations と suspended、organization の organization、
// 運用者の list-organizations の各行に kind が付く。チーム用の組織は 'team'
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { listOrganizations } from '../src/shared/operations/operator/index.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { createOrganization, createPersonalOrganizationRow, createUser } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createPersonalTarget, getOperator, SUSPENDED_AT, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations);

type Listed = {
  organizations: { slug: string; name: string; kind: string }[];
  suspended: { slug: string; name: string; kind: string }[];
};

async function listedFor(token: string): Promise<Listed> {
  const res = await post(app, myOrganizations, { token });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

describe('my-organizations', () => {
  test('チーム用の組織は kind が team', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const listed = await listedFor(person.token);
    expect(listed.organizations).toEqual([{ slug: organization.slug, name: organization.name, kind: 'team' }]);
  });

  test('自分用は kind が personal で、チーム用と並ぶ', async () => {
    const team = await createOrganization({ name: 'ひばり工房' });
    const person = await createPerson({ organization: team, admin: true });
    const personal = await createPersonalOrganizationRow(person.accountId);
    await createUser(personal, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    const listed = await listedFor(person.token);
    expect(listed.organizations).toHaveLength(2);
    expect(listed.organizations).toContainEqual({ slug: team.slug, name: 'ひばり工房', kind: 'team' });
    expect(listed.organizations).toContainEqual({ slug: personal.slug, name: '自分用', kind: 'personal' });
  });

  test('停止した組織の行にも kind が付く（チーム用も自分用も）', async () => {
    const team = await createOrganization({ suspended_at: SUSPENDED_AT });
    const person = await createPerson({ organization: team, admin: true });
    const personal = await createPersonalOrganizationRow(person.accountId, { suspended_at: SUSPENDED_AT });
    await createUser(personal, {
      account_id: person.accountId,
      login_provider: person.login.provider,
      login_subject: person.login.subject,
      is_admin: 1,
    });
    const listed = await listedFor(person.token);
    expect(listed.organizations).toEqual([]);
    expect(listed.suspended).toHaveLength(2);
    expect(listed.suspended).toContainEqual({ slug: team.slug, name: team.name, kind: 'team' });
    expect(listed.suspended).toContainEqual({ slug: personal.slug, name: '自分用', kind: 'personal' });
  });
});

describe('organization', () => {
  test('チーム用の組織の応答の organization に kind: team', async () => {
    const organization = await createOrganization();
    const person = await createPerson({ organization, admin: true });
    const res = await post(app, organizationInfo, { slug: organization.slug, token: person.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { organization: { kind: string } }).organization.kind).toBe('team');
  });

  test('自分用の応答の organization に kind: personal', async () => {
    const target = await createPersonalTarget();
    const res = await post(app, organizationInfo, { slug: target.slug, token: target.admin.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { organization: { kind: string; name: string } }).organization).toMatchObject({
      kind: 'personal',
      name: '自分用',
    });
  });
});

describe('list-organizations（運用者）', () => {
  test('各行に kind が付く。チーム用は team、自分用は personal', async () => {
    const operator = await withNewSession(await getOperator());
    const team = await createOrganization();
    const owner = await createPerson();
    const personal = await createPersonalOrganizationRow(owner.accountId);
    await createUser(personal, {
      account_id: owner.accountId,
      login_provider: owner.login.provider,
      login_subject: owner.login.subject,
      is_admin: 1,
    });

    const res = await post(app, listOrganizations, { token: operator.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: { slug: string; kind: string; name: string }[] };
    expect(body.organizations.find((item) => item.slug === team.slug)?.kind).toBe('team');
    expect(body.organizations.find((item) => item.slug === personal.slug)).toMatchObject({
      kind: 'personal',
      name: '自分用',
    });
    for (const item of body.organizations) expect(['team', 'personal']).toContain(item.kind);
  });
});
