import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { notificationList, notificationRead } from '../src/shared/operations/notification.ts';
import { AT, uuidv7 } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

async function add(target: Target, userId = target.admin.userId!, readAt: string | null = null) {
  const id = uuidv7();
  const db = orgDb(env, target.organization.verified);
  await db.batch([
    db.statement((q) =>
      q.insertInto('notifications').values({
        id,
        user_id: userId,
        kind: 'attachment_quota_warning',
        payload_json: JSON.stringify({ used_bytes: 900, quota_bytes: 1000 }),
        read_at: readAt,
        created_at: AT,
      }),
    ),
  ]);
  return id;
}

async function list(target: Target, input = {}) {
  const response = await post(app, notificationList, { slug: target.slug, token: target.admin.token, body: input });
  expect(response.status).toBe(200);
  return notificationList.output.parse(await response.json());
}

describe('本人の通知', () => {
  test('自分宛てだけを返し、未読の総数はページと絞り込みに依存しない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const unread = await add(target);
    const read = await add(target, target.admin.userId!, AT);
    await add(target, target.member.userId!);
    await add(other);
    const all = await list(target);
    expect(all.notifications.map((row) => row.id).sort()).toEqual([unread, read].sort());
    expect(all.unread_count).toBe(1);
    expect(all.notifications[0].payload).toEqual({ used_bytes: 900, quota_bytes: 1000 });
    const filtered = await list(target, { unread_only: true });
    expect(filtered.notifications.map((row) => row.id)).toEqual([unread]);
    expect(filtered.next).toBeNull();
  });

  test('同じ時刻の51件を重複や取りこぼしなく読む', async () => {
    const target = await createTarget();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await add(target));
    const first = await list(target);
    expect(first.notifications).toHaveLength(50);
    expect(first.unread_count).toBe(51);
    expect(first.next).not.toBeNull();
    const second = await list(target, { before: first.next });
    expect(second.notifications).toHaveLength(1);
    expect(second.next).toBeNull();
    expect([...first.notifications, ...second.notifications].map((row) => row.id).sort()).toEqual(ids.sort());
  });

  test('自分の通知だけ既読にでき、再実行で日時を変えない', async () => {
    const target = await createTarget();
    const other = await createTarget();
    const id = await add(target);
    const read = (value: string) =>
      post(app, notificationRead, {
        slug: target.slug,
        token: target.admin.token,
        body: { id: value },
      });
    const first = await read(id);
    expect(first.status).toBe(200);
    const result = notificationRead.output.parse(await first.json());
    const again = await read(id);
    expect(await again.json()).toEqual(result);
    expect((await list(target, { unread_only: true })).notifications).toEqual([]);
    for (const inaccessible of [await add(target, target.member.userId!), await add(other), uuidv7()]) {
      expect((await read(inaccessible)).status).toBe(404);
    }
  });
});
