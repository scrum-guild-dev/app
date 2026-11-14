// 組織の枠の load（routes/[slug]/+layout.ts）が、組織に入れる人に届いた招待の件数（invitationCount）を数えることを、fetch を差し替えて確かめる。
// 組織の選択の届いた招待にこの slug が無い人は、invitation-list を呼ばない（追加の呼び出しを増やさない）
import { expect, test, vi } from 'vitest';
// $app/paths は SvelteKit の仮想モジュールで、node の vitest では解決できない。resolve('/') は base が空なので '/' を返す
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import { load } from '../routes/[slug]/+layout.ts';
import { operationPath } from '../shared/operations/define.ts';
import { myOrganizations, organizationInfo } from '../shared/operations/organization/index.ts';
import { tokenNotice } from '../shared/operations/session/token-notice.ts';
import { invitationList } from '../shared/operations/workspace/index.ts';

type Reply = { status: number; body: unknown };

const orgPath = operationPath(organizationInfo, 'aoba');
const minePath = operationPath(myOrganizations);
const listPath = operationPath(invitationList, 'aoba');

const organization: Reply = {
  status: 200,
  body: {
    organization: { name: 'あおば開発', has_workspaces: true },
    me: { id: 'u1', name: 'ミナト', is_admin: false, theme: 'simple', level: 1 },
    workspaces: [],
  },
};
const mine = (slugs: string[]): Reply => ({
  status: 200,
  body: {
    organizations: [{ slug: 'aoba', name: 'あおば開発' }],
    invitations: slugs.map((slug) => ({ organization_name: '招待元', slug })),
    suspended: [],
    operator: false,
  },
});
const invitationItem = (id: string) => ({
  invitation_id: id,
  workspace_id: `w-${id}`,
  workspace_name: 'デザイン相談室',
  closed: false,
  role: 'member',
  invited_by_name: 'ユイ',
  invited_on: '2026-10-19',
});

async function run(replies: Record<string, Reply>, delayed: Partial<Record<string, Promise<Response>>> = {}) {
  const calls: string[] = [];
  const fake = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    if (delayed[String(input)]) return delayed[String(input)];
    const reply = replies[String(input)] ?? { status: 500, body: 'no reply' };
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  }) as typeof fetch;
  const depends = vi.fn();
  const event = { params: { slug: 'aoba' }, fetch: fake, url: new URL('http://localhost/aoba'), depends };
  const data = (await (
    load as (e: unknown) => Promise<{ invitationCount: Promise<number | null>; tokenNotice: unknown }>
  )(event)) as {
    invitationCount: Promise<number | null>;
    tokenNotice: unknown;
  };
  return { data, calls, depends };
}

test('この組織に招待が届いていれば、invitation-list の件数を invitationCount に入れる', async () => {
  const { data } = await run({
    [orgPath]: organization,
    [minePath]: mine(['aoba']),
    [listPath]: {
      status: 200,
      body: {
        organization: { name: 'あおば開発' },
        invitations: [invitationItem('a'), invitationItem('b')],
      },
    },
  });
  expect(await data.invitationCount).toBe(2);
});

test('この組織に招待が無ければ（ほかの組織だけ）0 で、invitation-list を呼ばない', async () => {
  const { data, calls } = await run({ [orgPath]: organization, [minePath]: mine(['hibari']) });
  expect(await data.invitationCount).toBe(0);
  expect(calls).not.toContain(listPath);
});

test('招待が届いていても invitation-list が読めなければ null（失敗を区別し、枠は開く）', async () => {
  const { data } = await run({
    [orgPath]: organization,
    [minePath]: mine(['aoba']),
    [listPath]: { status: 500, body: { error: { code: 'internal', message: 'x' } } },
  });
  expect(await data.invitationCount).toBeNull();
});

test('発行の知らせは専用の操作で読み、読めなくても組織の画面を残す', async () => {
  const notice = {
    count: 1,
    latest: { name: '手元の CLI', scope: 'read', created_at: '2026-11-04T01:30:00.000Z', revoked: false },
  };
  const success = await run({
    [orgPath]: organization,
    [minePath]: mine([]),
    [operationPath(tokenNotice)]: { status: 200, body: notice },
  });
  expect(await success.data.tokenNotice).toEqual(notice);
  const failure = await run({ [orgPath]: organization, [minePath]: mine([]) });
  expect(await failure.data.tokenNotice).toBeNull();
  expect(await failure.data.invitationCount).toBe(0);
});

test('日常の書き込みの再取得を組織の枠の load に依存させない', async () => {
  const { depends } = await run({ [orgPath]: organization, [minePath]: mine([]) });
  expect(depends).not.toHaveBeenCalled();
});

function gate() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve: (body: unknown) => resolve(new Response(JSON.stringify(body))) };
}

test('通知と招待件数を保留しても主が返り、件数は通知を待たずに解決する', async () => {
  const notice = gate();
  const invitations = gate();
  let loaded = false;
  const pending = run(
    { [orgPath]: organization, [minePath]: mine(['aoba']) },
    {
      [operationPath(tokenNotice)]: notice.promise,
      [listPath]: invitations.promise,
    },
  ).then((result) => {
    loaded = true;
    return result;
  });
  try {
    await vi.waitFor(() => expect(loaded).toBe(true));
    const { data } = await pending;
    let notified = false;
    void (data.tokenNotice as Promise<unknown>).then(() => {
      notified = true;
    });
    invitations.resolve({ invitations: [invitationItem('a'), invitationItem('b')] });
    expect(await data.invitationCount).toBe(2);
    expect(notified).toBe(false);
  } finally {
    notice.resolve({ count: 0, latest: null });
    invitations.resolve({ invitations: [] });
    await pending;
  }
});

test('招待だけの人は招待一覧を主として待ち、件数を別に読まない', async () => {
  const invitations = gate();
  const notFound = { status: 404, body: { error: { code: 'not_found' } } };
  let loaded = false;
  const pending = run(
    { [orgPath]: notFound, [minePath]: mine(['aoba']) },
    {
      [listPath]: invitations.promise,
    },
  ).then((result) => {
    loaded = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(loaded).toBe(false);
  const inbox = { organization: { name: 'あおば開発' }, invitations: [invitationItem('a')] };
  invitations.resolve(inbox);
  const { data, calls } = await pending;
  expect(data).toMatchObject({ organization: null, invitationInbox: inbox });
  expect(calls.filter((path) => path === listPath)).toHaveLength(1);
  expect(await data.invitationCount).toBe(0);
});
