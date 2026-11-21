// 組織のホームの「最近の更新」（recent-activity）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる。
// ここでは、どの行が返るか（所属、閉じたワークスペース、権限の範囲、消した行）、混ぜた並び、本文の切り方、カーソルを確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { OutputOf } from '../src/shared/operations/define.ts';
import {
  RECENT_ACTIVITY_BODY_LENGTH,
  RECENT_ACTIVITY_PAGE_SIZE,
  RECENT_ACTIVITY_WORKSPACE_LIMIT,
  recentActivity,
} from '../src/shared/operations/organization/recent-activity.ts';
import { organizationHistoryStatement } from '../src/server/operations/organization-history.ts';
import { taskHistoryStatement } from '../src/server/operations/task-history.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { queryPlanForTest, runStatementsForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  cutBody,
  readMemberWorkspaces,
  recentChangesStatement,
  recentCommentsStatement,
} from '../src/server/operations/recent-activity.ts';
import {
  createChangeLog,
  createComment,
  createEpic,
  createMembership,
  createStory,
  createTask,
  createWorkspace,
  uuidv7,
} from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type Activity = OutputOf<typeof recentActivity>;
type Cursor = NonNullable<Activity['next']>;

function call(target: Target, person: Person, body: unknown = {}) {
  return post(app, recentActivity, { slug: target.slug, token: person.token, body });
}

async function read(target: Target, person: Person, before?: Cursor): Promise<Activity> {
  const res = await call(target, person, before === undefined ? {} : { before });
  expect(res.status).toBe(200);
  return (await res.json()) as Activity;
}

// 2030-01-01T00:00:00.000Z から minutes 分後
function minutesLater(minutes: number): string {
  return new Date(Date.UTC(2030, 0, 1) + minutes * 60_000).toISOString();
}

type LogOptions = {
  target: Target;
  workspaceId?: string;
  entityType?: string;
  entityId: string;
  action?: string;
  changes?: Record<string, unknown>;
  at: string;
  actorUserId?: string | null;
};

function log(options: LogOptions) {
  return createChangeLog(options.target.organization, {
    workspace_id: options.workspaceId ?? options.target.workspace.id,
    actor_user_id: options.actorUserId === undefined ? options.target.leader.userId : options.actorUserId,
    entity_type: options.entityType ?? 'task',
    entity_id: options.entityId,
    action: options.action ?? 'update',
    changes_json: JSON.stringify(options.changes ?? { title: ['前', '後'] }),
    created_at: options.at,
  });
}

function expectCommentListLookups(list: string, count: string) {
  const byTask = /SEARCH comments USING (?:COVERING )?INDEX comments_task \(task_id=\?\)/;
  const byWorkspaceAndTask =
    /SEARCH comments USING (?:COVERING )?INDEX comments_workspace_task_fk \(workspace_id=\? AND task_id=\?\)/;
  const lookup = new RegExp(`${byTask.source}|${byWorkspaceAndTask.source}`);
  expect(list, list).toMatch(lookup);
  expect(list, list).not.toMatch(/TEMP B-TREE|comments_workspace_created/);
  expect(count, count).toMatch(lookup);
  expect(count, count).not.toMatch(/comments_workspace_created/);
}

describe('recent-activity', () => {
  test('変更とコメントを新しい順に混ぜ、した人の今の名前、ワークスペース名、対象の題、内容の種類を返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId, { title: '見積もりを送る' });
    const story = await createStory(organization, workspace.id, leaderId, { title: '見積もりを整える' });
    const epic = await createEpic(organization, workspace.id, leaderId, { title: '会員ポイント制度を公開する' });
    await log({
      target,
      entityId: task.id,
      action: 'create',
      changes: { title: [null, '見積もりを送る'] },
      at: minutesLater(1),
    });
    await createComment(organization, workspace.id, task.id, target.member.userId!, {
      body_md: '確認しました。',
      created_at: minutesLater(2),
    });
    await log({
      target,
      entityType: 'story',
      entityId: story.id,
      changes: { title: ['前', '後'], due_on: [null, '2030-02-01'], body_md: [null, '長い本文'], mystery: [1, 2] },
      at: minutesLater(3),
    });
    await log({
      target,
      entityId: task.id,
      action: 'complete',
      changes: { completed_at: [null, minutesLater(4)] },
      at: minutesLater(4),
    });
    await log({ target, entityType: 'epic', entityId: epic.id, action: 'reopen', changes: {}, at: minutesLater(5) });
    await log({ target, entityId: task.id, action: 'restore', changes: {}, at: minutesLater(6), actorUserId: null });

    const result = await read(target, target.member);
    expect(result.next).toBeNull();
    expect(
      result.entries.map((entry) => [entry.created_at, entry.target.kind, entry.target.title, entry.event.kind]),
    ).toEqual([
      [minutesLater(6), 'task', '見積もりを送る', 'other'],
      [minutesLater(5), 'epic', '会員ポイント制度を公開する', 'reopen'],
      [minutesLater(4), 'task', '見積もりを送る', 'complete'],
      [minutesLater(3), 'story', '見積もりを整える', 'update'],
      [minutesLater(2), 'task', '見積もりを送る', 'comment'],
      [minutesLater(1), 'task', '見積もりを送る', 'create'],
    ]);
    const [restored, , , updated, comment, created] = result.entries;
    // 変えた欄の名前だけで、値は返さない
    expect(updated!.event).toEqual({ kind: 'update', fields: ['title', 'due_on', 'body_md', 'mystery'] });
    expect(JSON.stringify(result)).not.toContain('長い本文');
    expect(comment!.event).toEqual({ kind: 'comment', body: '確認しました。', truncated: false });
    expect(comment!.target).toEqual({ kind: 'task', id: task.id, title: '見積もりを送る' });
    expect(comment!.actor).toEqual({ id: target.member.userId, name: '星野 澪' });
    expect(created!.actor).toEqual({ id: leaderId, name: '星野 澪' });
    expect(created!.workspace).toEqual({ id: workspace.id, name: '青葉チーム' });
    // 定期処理か運用者の行は、した人が null
    expect(restored!.actor).toBeNull();
    expect(updated!.id).toEqual(expect.any(String));
  });

  test('した人の名前は今の名前で返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const writer = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const db = orgDb(env, organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('users')
          .set({ name: '白川 葵' })
          .where('id', '=', writer.userId!)
          .where('organization_id', '=', organization.id),
      ),
    );
    const task = await createTask(organization, workspace.id, writer.userId!);
    await log({ target, entityId: task.id, actorUserId: writer.userId, at: minutesLater(1) });
    const result = await read(target, target.member);
    expect(result.entries[0]!.actor).toEqual({ id: writer.userId, name: '白川 葵' });
  });

  test('所属していないワークスペースは、管理者でも返さない。抜けたワークスペースと閉じたワークスペースも返さない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const adminId = target.admin.userId!;
    const task = await createTask(organization, target.workspace.id, adminId, { title: '自分のチームの作業' });
    const other = await createTask(organization, target.otherWorkspace.id, adminId, { title: '別のチームの作業' });
    await log({ target, entityId: task.id, at: minutesLater(1) });
    await log({ target, workspaceId: target.otherWorkspace.id, entityId: other.id, at: minutesLater(2) });
    await createComment(organization, target.otherWorkspace.id, other.id, adminId, { created_at: minutesLater(3) });

    // 管理者はどのワークスペースにも所属していない
    expect((await read(target, target.admin)).entries).toEqual([]);
    // メンバーは所属するワークスペースの分だけ。bystander は別のワークスペースの分だけ
    expect((await read(target, target.member)).entries.map((entry) => entry.target.title)).toEqual([
      '自分のチームの作業',
    ]);
    expect((await read(target, target.bystander)).entries.map((entry) => entry.target.title)).toEqual([
      '別のチームの作業',
      '別のチームの作業',
    ]);

    // 所属を抜けると出ない（抜けた後も入れる管理者で確かめる）
    const db = orgDb(env, organization.verified);
    const adminMember = await createPerson({
      organization,
      admin: true,
      membership: { workspaceId: target.otherWorkspace.id, role: 'member' },
    });
    expect((await read(target, adminMember)).entries).toHaveLength(2);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: minutesLater(10), left_on: '2030-01-01' })
          .where('user_id', '=', adminMember.userId!),
      ),
    );
    expect((await read(target, adminMember)).entries).toEqual([]);

    // 閉じたワークスペースは出ない
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: minutesLater(11) })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', organization.id),
      ),
    );
    expect((await read(target, target.member)).entries).toEqual([]);
  });

  test('複数のワークスペースに所属していれば、まとめて新しい順に並べる', async () => {
    const target = await createTarget();
    const { organization } = target;
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    const first = await createTask(organization, target.workspace.id, target.leader.userId!, { title: '青葉の作業' });
    const second = await createTask(organization, target.otherWorkspace.id, target.leader.userId!, {
      title: '別のチームの作業',
    });
    await log({ target, entityId: first.id, at: minutesLater(1) });
    await log({ target, workspaceId: target.otherWorkspace.id, entityId: second.id, at: minutesLater(2) });
    await log({ target, entityId: first.id, at: minutesLater(3) });
    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.workspace.id === target.workspace.id, entry.target.title])).toEqual([
      [true, '青葉の作業'],
      [false, '別のチームの作業'],
      [true, '青葉の作業'],
    ]);
  });

  test('別の組織の行は返さない。別の組織の人を指す行は、した人を null にする', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const foreignTask = await createTask(foreign.organization, foreign.workspace.id, foreign.leader.userId!, {
      title: '別の組織の作業',
    });
    await log({ target, entityId: task.id, actorUserId: foreign.leader.userId, at: minutesLater(1) });
    await log({ target: foreign, entityId: foreignTask.id, at: minutesLater(2) });
    await createComment(foreign.organization, foreign.workspace.id, foreignTask.id, foreign.leader.userId!, {
      created_at: minutesLater(3),
    });
    // 別の組織の ID を、この組織の行として書いた壊れた行（組織と一致しないので読まない）
    await createChangeLog(foreign.organization, {
      workspace_id: target.workspace.id,
      entity_type: 'task',
      entity_id: task.id,
      action: 'update',
      created_at: minutesLater(4),
    });

    const result = await read(target, target.member);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.actor).toBeNull();
    expect((await read(foreign, foreign.member)).entries.map((entry) => entry.target.title)).toEqual([
      '別の組織の作業',
      '別の組織の作業',
    ]);
  });

  test('リーダーと管理者だけが見られる履歴と、コメントの編集と削除の履歴、削除の履歴は返さない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId);
    await log({ target, entityId: task.id, at: minutesLater(1) });
    await log({
      target,
      entityType: 'membership',
      entityId: target.member.userId!,
      action: 'update',
      changes: { role: ['member', 'leader'] },
      at: minutesLater(2),
    });
    await log({ target, entityType: 'allocation', entityId: uuidv7(), action: 'create', at: minutesLater(3) });
    await log({ target, entityType: 'connection', entityId: uuidv7(), action: 'update', at: minutesLater(4) });
    await log({ target, entityType: 'sprint', entityId: uuidv7(), action: 'update', at: minutesLater(5) });
    await log({ target, entityType: 'category', entityId: uuidv7(), action: 'create', at: minutesLater(6) });
    await log({
      target,
      entityType: 'comment',
      entityId: uuidv7(),
      action: 'delete',
      changes: { task_id: [task.id, task.id] },
      at: minutesLater(7),
    });
    await log({ target, entityType: 'workspace', entityId: workspace.id, action: 'update', at: minutesLater(8) });
    await log({
      target,
      entityId: task.id,
      action: 'delete',
      changes: { deleted_at: [null, minutesLater(9)] },
      at: minutesLater(9),
    });
    // ワークスペースの外の行（組織の変更）
    await createChangeLog(organization, {
      entity_type: 'organization',
      entity_id: organization.id,
      created_at: minutesLater(10),
    });

    const result = await read(target, target.leader);
    expect(result.entries.map((entry) => [entry.created_at, entry.event.kind])).toEqual([[minutesLater(1), 'update']]);
  });

  test('消したタスク、ストーリー、エピックの変更とコメントと、消したコメントは返さない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const live = await createTask(organization, workspace.id, leaderId, { title: '残るタスク' });
    const gone = await createTask(organization, workspace.id, leaderId, {
      title: '消したタスク',
      deleted_at: minutesLater(20),
    });
    const goneStory = await createStory(organization, workspace.id, leaderId, {
      title: '消したストーリー',
      deleted_at: minutesLater(20),
    });
    const goneEpic = await createEpic(organization, workspace.id, leaderId, {
      title: '消したエピック',
      deleted_at: minutesLater(20),
    });
    await log({ target, entityId: live.id, at: minutesLater(1) });
    await log({ target, entityId: gone.id, at: minutesLater(2) });
    await log({ target, entityType: 'story', entityId: goneStory.id, at: minutesLater(3) });
    await log({ target, entityType: 'epic', entityId: goneEpic.id, at: minutesLater(4) });
    // 対象の行が無い（物理的に消えた、別のワークスペースの対象を指す）行
    await log({ target, entityId: uuidv7(), at: minutesLater(5) });
    await createComment(organization, workspace.id, live.id, leaderId, {
      body_md: '残るコメント',
      created_at: minutesLater(6),
    });
    await createComment(organization, workspace.id, live.id, leaderId, {
      body_md: '',
      deleted_at: minutesLater(7),
      deleted_by: leaderId,
      created_at: minutesLater(7),
    });
    await createComment(organization, workspace.id, gone.id, leaderId, {
      body_md: '消したタスクのコメント',
      created_at: minutesLater(8),
    });

    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.target.title, entry.event.kind])).toEqual([
      ['残るタスク', 'comment'],
      ['残るタスク', 'update'],
    ]);
    expect(JSON.stringify(result)).not.toContain('消した');
  });

  test('コメントの本文は先頭の 200 字（コードポイント）までを返し、切ったかを添える', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const task = await createTask(organization, workspace.id, target.leader.userId!);
    const exact = '😀'.repeat(RECENT_ACTIVITY_BODY_LENGTH);
    const long = `${'あ'.repeat(RECENT_ACTIVITY_BODY_LENGTH)}余り`;
    const huge = `# 見出し\n${'あ'.repeat(100_000 - 6)}`;
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: exact,
      created_at: minutesLater(1),
    });
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: long,
      created_at: minutesLater(2),
    });
    await createComment(organization, workspace.id, task.id, target.leader.userId!, {
      body_md: huge,
      created_at: minutesLater(3),
    });
    const [third, second, first] = (await read(target, target.member)).entries;
    expect(first!.event).toEqual({ kind: 'comment', body: exact, truncated: false });
    expect(second!.event).toEqual({ kind: 'comment', body: 'あ'.repeat(RECENT_ACTIVITY_BODY_LENGTH), truncated: true });
    expect(third!.event).toMatchObject({ kind: 'comment', truncated: true });
    // 切った本文は Markdown のまま（描かない）。長さは 200 字
    const body = (third!.event as { body: string }).body;
    expect(Array.from(body)).toHaveLength(RECENT_ACTIVITY_BODY_LENGTH);
    expect(body.startsWith('# 見出し\n')).toBe(true);
  });

  test('21 件以上は 20 件ずつ、続きのカーソルで重なりも抜けもなく読め、同じ created_at の行も境目で落ちない', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const leaderId = target.leader.userId!;
    const task = await createTask(organization, workspace.id, leaderId);
    const expected: { id: string; created_at: string }[] = [];
    // 変更 30 件とコメント 25 件。ちょうど 20 件目と 21 件目をまたぐ 3 件と、ページの境目の 3 件が同じ created_at
    for (let i = 0; i < 30; i++) {
      const at = minutesLater(i < 6 ? 100 : 100 + i);
      expected.push(await log({ target, entityId: task.id, at }));
    }
    for (let i = 0; i < 25; i++) {
      const at = minutesLater(i < 6 ? 100 : 100 + i);
      expected.push(
        await createComment(organization, workspace.id, task.id, leaderId, { created_at: at, id: uuidv7() }),
      );
    }
    const order = [...expected].sort((a, b) =>
      a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? 1 : -1,
    );

    const seen: string[] = [];
    let before: Cursor | undefined;
    const sizes: number[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await read(target, target.member, before);
      sizes.push(result.entries.length);
      seen.push(...result.entries.map((entry) => entry.id));
      if (result.next === null) break;
      expect(result.entries).toHaveLength(RECENT_ACTIVITY_PAGE_SIZE);
      const last = result.entries.at(-1)!;
      expect(result.next).toEqual({ created_at: last.created_at, id: last.id });
      before = result.next;
    }
    expect(sizes).toEqual([20, 20, 15]);
    expect(seen).toEqual(order.map((row) => row.id));
    expect(new Set(seen).size).toBe(55);
  });

  test('ちょうど 20 件なら続きは無く、21 件目があれば続きがある', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const task = await createTask(organization, workspace.id, target.leader.userId!);
    for (let i = 0; i < 20; i++) await log({ target, entityId: task.id, at: minutesLater(i) });
    expect((await read(target, target.member)).next).toBeNull();
    await log({ target, entityId: task.id, at: minutesLater(30) });
    const first = await read(target, target.member);
    expect(first.entries).toHaveLength(20);
    expect(first.next).not.toBeNull();
    const second = await read(target, target.member, first.next!);
    expect(second.entries).toHaveLength(1);
    expect(second.next).toBeNull();
  });

  test('カーソルは created_at が ISO 8601（ミリ秒まで）でなければ 400', async () => {
    const target = await createTarget();
    for (const before of [
      { created_at: 'あした', id: uuidv7() },
      { created_at: '2030-01-01', id: uuidv7() },
      { id: uuidv7() },
      'x',
    ]) {
      const res = await call(target, target.member, { before });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
  });

  test('「今日やる」の印だけを付け外しした行は出さず、ほかの欄も一緒に変えた行は出す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const task = await createTask(organization, workspace.id, target.leader.userId!);
    const story = await createStory(organization, workspace.id, target.leader.userId!);
    await log({ target, entityId: task.id, changes: { today_on: [null, '2030-01-01'] }, at: minutesLater(1) });
    await log({ target, entityId: task.id, changes: { today_on: ['2030-01-01', null] }, at: minutesLater(2) });
    await log({
      target,
      entityType: 'story',
      entityId: story.id,
      changes: { today_on: [null, 'x'] },
      at: minutesLater(3),
    });
    await log({
      target,
      entityId: task.id,
      changes: { today_on: [null, '2030-01-01'], title: ['前', '後'] },
      at: minutesLater(4),
    });
    await log({ target, entityId: task.id, changes: { due_on: [null, '2030-01-02'] }, at: minutesLater(5) });
    // 印の行はほかの action（create）では除かない
    await log({ target, entityId: task.id, action: 'create', changes: { today_on: [null, 'x'] }, at: minutesLater(6) });

    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.created_at, entry.event])).toEqual([
      [minutesLater(6), { kind: 'create' }],
      [minutesLater(5), { kind: 'update', fields: ['due_on'] }],
      [minutesLater(4), { kind: 'update', fields: ['today_on', 'title'] }],
    ]);
  });

  test('印だけの行が続いても、20 件の数えは崩れず、続きを重なりも抜けも無く読める', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const shown: string[] = [];
    for (let i = 0; i < 30; i++) {
      // 印だけの行（出さない）を、出す行の間に 2 つずつ挟む
      await log({ target, entityId: task.id, changes: { today_on: [null, 'x'] }, at: minutesLater(i * 3) });
      await log({ target, entityId: task.id, changes: { today_on: ['x', null] }, at: minutesLater(i * 3 + 1) });
      shown.unshift((await log({ target, entityId: task.id, at: minutesLater(i * 3 + 2) })).id);
    }
    const seen: string[] = [];
    let before: Cursor | undefined;
    const sizes: number[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await read(target, target.member, before);
      sizes.push(result.entries.length);
      seen.push(...result.entries.map((entry) => entry.id));
      if (result.next === null) break;
      before = result.next;
    }
    expect(sizes).toEqual([20, 10]);
    expect(seen).toEqual(shown);
  });

  test('所属するワークスペースは新しく作った順に 50 個までで、50 個目まで出て 51 個目は出ない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const person = await createPerson({ organization });
    const base = Date.UTC(2031, 0, 1);
    const names: string[] = [];
    // i が大きいほど新しく作ったワークスペース（id の時刻が後）。51 個に所属し、それぞれに変更を1件持つ
    for (let i = 0; i <= RECENT_ACTIVITY_WORKSPACE_LIMIT; i++) {
      const workspace = await createWorkspace(organization, target.admin.userId!, {
        id: uuidv7(base + i * 1000),
        name: `作った順 ${i}`,
      });
      await createMembership(organization, workspace.id, person.userId!);
      const task = await createTask(organization, workspace.id, target.admin.userId!, { title: `作業 ${i}` });
      await log({ target, workspaceId: workspace.id, entityId: task.id, at: minutesLater(i) });
      names.push(workspace.name);
    }
    // 51 個に所属するので、最も古い 1 つ（i = 0）は読まない。残り 50 個は新しい更新の順に、20 件ずつ読める
    const seen: string[] = [];
    let before: Cursor | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await read(target, person, before);
      seen.push(...result.entries.map((entry) => entry.workspace.name));
      if (result.next === null) break;
      before = result.next;
    }
    expect(seen).toEqual(names.slice(1).reverse());
    expect(seen).toHaveLength(RECENT_ACTIVITY_WORKSPACE_LIMIT);
    expect(seen).not.toContain('作った順 0');

    // 所属を 1 つ抜けて 50 個にすると、最も古い 1 つ（i = 0）が入る
    const db = orgDb(env, organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('memberships')
          .set({ left_at: minutesLater(999), left_on: '2031-01-01' })
          .where('user_id', '=', person.userId!)
          .where('workspace_id', '=', (eb) =>
            eb
              .selectFrom('workspaces')
              .select('id')
              .where('name', '=', '作った順 50')
              .where('organization_id', '=', organization.id),
          ),
      ),
    );
    const names2: string[] = [];
    before = undefined;
    for (let page = 0; page < 5; page++) {
      const result = await read(target, person, before);
      names2.push(...result.entries.map((entry) => entry.workspace.name));
      if (result.next === null) break;
      before = result.next;
    }
    expect(names2).toEqual(names.slice(0, 50).reverse());
    expect(names2).toContain('作った順 0');
  });

  test('2つのワークスペースに所属すると、変更もコメントも両方から読み、ワークスペース名を取り違えない', async () => {
    const target = await createTarget();
    const { organization } = target;
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    const first = await createTask(organization, target.workspace.id, target.leader.userId!, { title: '青葉の作業' });
    const second = await createTask(organization, target.otherWorkspace.id, target.leader.userId!, {
      title: '別チームの作業',
    });
    await log({ target, entityId: first.id, at: minutesLater(1) });
    await createComment(organization, target.workspace.id, first.id, target.leader.userId!, {
      created_at: minutesLater(2),
    });
    await log({ target, workspaceId: target.otherWorkspace.id, entityId: second.id, at: minutesLater(3) });
    await createComment(organization, target.otherWorkspace.id, second.id, target.leader.userId!, {
      created_at: minutesLater(4),
    });

    const result = await read(target, target.member);
    expect(
      result.entries.map((entry) => [
        entry.created_at,
        entry.event.kind,
        entry.workspace.id === target.workspace.id,
        entry.workspace.name,
        entry.target.title,
      ]),
    ).toEqual([
      [minutesLater(4), 'comment', false, '青葉チーム', '別チームの作業'],
      [minutesLater(3), 'update', false, '青葉チーム', '別チームの作業'],
      [minutesLater(2), 'comment', true, '青葉チーム', '青葉の作業'],
      [minutesLater(1), 'update', true, '青葉チーム', '青葉の作業'],
    ]);
  });

  test('2つのワークスペースに 21 件ずつ（変更とコメント）あっても、20 件ずつ読んで重なりも抜けも無い', async () => {
    const target = await createTarget();
    const { organization } = target;
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    const leaderId = target.leader.userId!;
    const expected: { id: string; created_at: string }[] = [];
    let minute = 0;
    for (const workspaceId of [target.workspace.id, target.otherWorkspace.id]) {
      const task = await createTask(organization, workspaceId, leaderId);
      for (let i = 0; i < 21; i++) {
        expected.push(await log({ target, workspaceId, entityId: task.id, at: minutesLater(minute++) }));
        expected.push(
          await createComment(organization, workspaceId, task.id, leaderId, { created_at: minutesLater(minute++) }),
        );
      }
    }
    const order = [...expected].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((row) => row.id);
    const seen: string[] = [];
    const sizes: number[] = [];
    let before: Cursor | undefined;
    for (let page = 0; page < 6; page++) {
      const result = await read(target, target.member, before);
      sizes.push(result.entries.length);
      seen.push(...result.entries.map((entry) => entry.id));
      if (result.next === null) break;
      before = result.next;
    }
    expect(sizes).toEqual([20, 20, 20, 20, 4]);
    expect(seen).toEqual(order);
  });

  test('別のワークスペースの対象を指す変更と、別のワークスペースのタスクを指すコメントは出さない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const leaderId = target.leader.userId!;
    const mine = await createTask(organization, target.workspace.id, leaderId, { title: '自分のタスク' });
    const foreign = await createTask(organization, target.otherWorkspace.id, leaderId, {
      title: '別のワークスペースのタスク',
    });
    const foreignStory = await createStory(organization, target.otherWorkspace.id, leaderId, {
      title: '別のストーリー',
    });
    await log({ target, entityId: mine.id, at: minutesLater(1) });
    // 自分のワークスペースの行として書いたが、対象は別のワークスペースにある
    await log({ target, entityId: foreign.id, at: minutesLater(2) });
    await log({ target, entityType: 'story', entityId: foreignStory.id, at: minutesLater(3) });
    await createComment(organization, target.workspace.id, foreign.id, leaderId, { created_at: minutesLater(4) });
    await createComment(organization, target.workspace.id, mine.id, leaderId, { created_at: minutesLater(5) });

    const result = await read(target, target.member);
    expect(result.entries.map((entry) => [entry.target.title, entry.event.kind])).toEqual([
      ['自分のタスク', 'comment'],
      ['自分のタスク', 'update'],
    ]);
    expect(JSON.stringify(result)).not.toContain('別の');
  });

  test('コメントの本文は、書記素（国旗、結合文字、ZWJ の絵文字）を割らず、200 コードポイント以内で切る', async () => {
    const flag = '🇯🇵';
    const family = '👨‍👩‍👧‍👦';
    const accent = 'e\u0301';
    const a = (count: number) => 'あ'.repeat(count);
    const cases: [string, string, boolean][] = [
      [a(198) + flag, a(198) + flag, false],
      [a(199) + flag, a(199), true],
      [a(196) + family + 'い', a(196), true],
      [a(198) + accent + 'い', a(198) + accent, true],
      [a(199) + accent, a(199), true],
      [a(200) + 'い', a(200), true],
      [a(200), a(200), false],
      ['', '', false],
    ];
    for (const [text, body, truncated] of cases) {
      expect(cutBody(text), JSON.stringify(text)).toEqual({ body, truncated });
    }
    // 1つの書記素だけで 200 コードポイントを超えるとき（結合文字が続く）は、コードポイントで切る
    const stacked = 'a' + '\u0301'.repeat(300);
    const cut = cutBody(stacked);
    expect(Array.from(cut.body)).toHaveLength(RECENT_ACTIVITY_BODY_LENGTH);
    expect(cut.truncated).toBe(true);

    // 応答でも同じ（200 コードポイントの境目をまたぐ国旗）
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    await createComment(target.organization, target.workspace.id, task.id, target.leader.userId!, {
      body_md: a(199) + flag,
      created_at: minutesLater(1),
    });
    expect((await read(target, target.member)).entries[0]!.event).toEqual({
      kind: 'comment',
      body: a(199),
      truncated: true,
    });
  });

  test('未ログインは 401、組織に入れない人は 404', async () => {
    const target = await createTarget();
    const anonymous = await post(app, recentActivity, { slug: target.slug, body: {} });
    expect(anonymous.status).toBe(401);
    expect(await errorCodeOf(anonymous)).toBe('unauthenticated');
    const outsider = await createPerson();
    const res = await call(target, outsider);
    expect(res.status).toBe(404);
    // 承諾待ちの招待だけの人は、組織の中のデータを読めない
    expect((await call(target, target.invitee)).status).toBe(404);
  });

  test('変更の文とコメントの文は、部分索引で新しい順に読み、1ページ目も2ページ目も並べ替えを持たない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const [workspace] = await readMemberWorkspaces(db, target.member.userId!);
    for (const before of [undefined, { created_at: minutesLater(0), id: uuidv7() }]) {
      const changes = (await queryPlanForTest(env, recentChangesStatement(db, workspace!, before))).join('\n');
      expect(changes, changes).toMatch(/SEARCH cl USING INDEX change_logs_recent_activity \(workspace_id=\?/);
      expect(changes, changes).not.toMatch(/TEMP B-TREE/);
      expect(changes, changes).not.toMatch(/^SCAN cl\b/m);
      const comments = (await queryPlanForTest(env, recentCommentsStatement(db, workspace!, before))).join('\n');
      expect(comments, comments).toMatch(
        /SEARCH c USING (COVERING )?INDEX comments_workspace_created \(workspace_id=\?/,
      );
      expect(comments, comments).not.toMatch(/TEMP B-TREE/);
      expect(comments, comments).not.toMatch(/^SCAN c\b/m);
      // 2ページ目は、カーソルの日時が索引の範囲に付く（OR の外の created_at <= を足した理由。`<` と `<=` は同じ表示）。
      // 1ページ目は workspace_id の等号だけ
      const range = /\(workspace_id=\? AND created_at<\?\)/;
      if (before === undefined) {
        expect(changes, changes).not.toMatch(/created_at/);
        expect(comments, comments).not.toMatch(/created_at/);
      } else {
        expect(changes, changes).toMatch(range);
        expect(comments, comments).toMatch(range);
      }
    }
  });

  test('前の版の comment-list の一覧と件数の文は、索引で対象のタスクに絞る', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const workspaceId = target.workspace.id;
    // この PR の前の版（main）の comment-list の文の写し。写した元は src/server/operations/comment.ts の commentPageStatement（一覧）と、
    // comment-list の処理の中の件数の文（この PR の前は関数に切り出していない）。一覧は消したコメントも返し、件数は deleted_at IS NULL を持つ
    const list = db.statement((q) =>
      q
        .selectFrom('comments')
        .innerJoin('tasks', (join) =>
          join
            .onRef('tasks.id', '=', 'comments.task_id')
            .on('tasks.workspace_id', '=', workspaceId)
            .on('tasks.deleted_at', 'is', null),
        )
        .select(['comments.id', 'comments.body_md', 'comments.created_at'])
        .where('comments.workspace_id', '=', workspaceId)
        .where('comments.task_id', '=', 'x')
        .orderBy('comments.created_at', 'desc')
        .orderBy('comments.id', 'desc')
        .limit(51),
    );
    const count = db.statement((q) =>
      q
        .selectFrom('comments')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('comments.task_id', '=', 'x')
        .where('comments.workspace_id', '=', workspaceId)
        .where('comments.deleted_at', 'is', null),
    );
    expectCommentListLookups(
      (await queryPlanForTest(env, list)).join('\n'),
      (await queryPlanForTest(env, count)).join('\n'),
    );
  });

  test('行を入れて ANALYZE した後も、ワークスペースの行数が偏っていても、変更とコメントの文は同じ部分索引を使い、ほかの文は取られない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const leaderId = target.leader.userId!;
    // 2つのワークスペース。行数を偏らせる（一方は多く、一方は少ない）。タスクが多く、コメントはいろいろなタスクに付く（実際の形）
    await createMembership(organization, target.otherWorkspace.id, target.member.userId!);
    const tasks: Awaited<ReturnType<typeof createTask>>[] = [];
    for (const [workspaceId, rows] of [
      [target.workspace.id, 120],
      [target.otherWorkspace.id, 6],
    ] as const) {
      const own = [];
      for (let i = 0; i < 40; i++) own.push(await createTask(organization, workspaceId, leaderId));
      tasks.push(...own);
      for (let i = 0; i < rows; i++) {
        const task = own[i % own.length]!;
        await log({ target, workspaceId, entityId: task.id, at: minutesLater(i) });
        await log({ target, workspaceId, entityType: 'sprint', entityId: uuidv7(), at: minutesLater(i) });
        await createComment(organization, workspaceId, task.id, leaderId, { created_at: minutesLater(i) });
      }
    }
    await runStatementsForTest(env, ['ANALYZE']);
    const db = orgDb(env, organization.verified);
    const members = await readMemberWorkspaces(db, target.member.userId!);
    expect(members).toHaveLength(2);
    for (const member of members) {
      for (const before of [undefined, { created_at: minutesLater(30), id: uuidv7() }]) {
        const changes = (await queryPlanForTest(env, recentChangesStatement(db, member, before))).join('\n');
        expect(changes, changes).toMatch(/SEARCH cl USING INDEX change_logs_recent_activity \(workspace_id=\?/);
        expect(changes, changes).not.toMatch(/TEMP B-TREE/);
        const comments = (await queryPlanForTest(env, recentCommentsStatement(db, member, before))).join('\n');
        expect(comments, comments).toMatch(
          /SEARCH c USING (COVERING )?INDEX comments_workspace_created \(workspace_id=\?/,
        );
        expect(comments, comments).not.toMatch(/TEMP B-TREE/);
      }
    }

    // 前の版の comment-list の一覧と件数の文は、ANALYZE の後も索引で対象のタスクに絞る。
    // 文の写しは、上のテストと同じ（commentPageStatement と、comment-list の処理の中の件数の文）
    const workspaceId = target.workspace.id;
    const taskId = tasks[0]!.id;
    const list = db.statement((q) =>
      q
        .selectFrom('comments')
        .innerJoin('tasks', (join) =>
          join
            .onRef('tasks.id', '=', 'comments.task_id')
            .on('tasks.workspace_id', '=', workspaceId)
            .on('tasks.deleted_at', 'is', null),
        )
        .select(['comments.id', 'comments.body_md', 'comments.created_at'])
        .where('comments.workspace_id', '=', workspaceId)
        .where('comments.task_id', '=', taskId)
        .orderBy('comments.created_at', 'desc')
        .orderBy('comments.id', 'desc')
        .limit(51),
    );
    const count = db.statement((q) =>
      q
        .selectFrom('comments')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('comments.task_id', '=', taskId)
        .where('comments.workspace_id', '=', workspaceId)
        .where('comments.deleted_at', 'is', null),
    );
    expectCommentListLookups(
      (await queryPlanForTest(env, list)).join('\n'),
      (await queryPlanForTest(env, count)).join('\n'),
    );

    // task-history と organization-history の文は、新しい部分索引に取られない
    for (const statement of [
      taskHistoryStatement(db, workspaceId, taskId),
      taskHistoryStatement(db, workspaceId, taskId, { created_at: minutesLater(30), id: uuidv7() }),
      organizationHistoryStatement(db, null),
      organizationHistoryStatement(db, { created_at: minutesLater(30), id: uuidv7() }),
    ]) {
      const plan = (await queryPlanForTest(env, statement)).join('\n');
      expect(plan, plan).not.toMatch(/change_logs_recent_activity/);
    }
  });

  test('閉じたワークスペースは 50 個の枠を使わない', async () => {
    const target = await createTarget();
    const { organization } = target;
    const person = await createPerson({ organization });
    const base = Date.UTC(2031, 0, 1);
    const names: string[] = [];
    // 開いた 50 個（古い）。それぞれに変更を 1 件持つ
    for (let i = 0; i < RECENT_ACTIVITY_WORKSPACE_LIMIT; i++) {
      const workspace = await createWorkspace(organization, target.admin.userId!, {
        id: uuidv7(base + i * 1000),
        name: `開いた ${i}`,
      });
      await createMembership(organization, workspace.id, person.userId!);
      const task = await createTask(organization, workspace.id, target.admin.userId!);
      await log({ target, workspaceId: workspace.id, entityId: task.id, at: minutesLater(i) });
      names.push(workspace.name);
    }
    // それより新しい、閉じたワークスペース 2 個。所属しているが、枠を使わない
    for (let i = 0; i < 2; i++) {
      const closed = await createWorkspace(organization, target.admin.userId!, {
        id: uuidv7(base + (100 + i) * 1000),
        name: `閉じた ${i}`,
        closed_at: minutesLater(500),
      });
      await createMembership(organization, closed.id, person.userId!);
      const task = await createTask(organization, closed.id, target.admin.userId!);
      await log({ target, workspaceId: closed.id, entityId: task.id, at: minutesLater(600 + i) });
    }
    const seen: string[] = [];
    let before: Cursor | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await read(target, person, before);
      seen.push(...result.entries.map((entry) => entry.workspace.name));
      if (result.next === null) break;
      before = result.next;
    }
    expect(seen).toEqual(names.reverse());
    expect(seen.some((name) => name.startsWith('閉じた'))).toBe(false);
  });
});
