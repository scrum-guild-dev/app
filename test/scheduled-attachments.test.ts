// #746: 付く先のない添付ファイルの掃除を、Workers の D1 と R2 で確かめる。
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import { cleanupAttachments } from '../src/server/scheduled/cleanup-attachments.ts';
import {
  createAttachment,
  createOrganization,
  createTask,
  createUser,
  createWorkspace,
  type OrganizationFixture,
} from './factories.ts';

const NOW = new Date('2026-11-05T12:34:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const before = (age: number) => new Date(NOW.getTime() - age).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(options: { suspended?: boolean; closed?: boolean } = {}) {
  const organization = await createOrganization({ suspended_at: options.suspended ? before(DAY * 2) : null });
  const user = await createUser(organization);
  const workspace = await createWorkspace(organization, user.id, {
    closed_at: options.closed ? before(DAY * 2) : null,
  });
  return { organization, user, workspace };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function storedAttachment(target: Fixture, overrides: Parameters<typeof createAttachment>[3] = {}) {
  const row = await createAttachment(target.organization, target.workspace.id, target.user.id, {
    created_at: before(DAY + 1),
    ...overrides,
  });
  await env.ATTACHMENTS.put(row.object_key, 'x');
  return row;
}

async function rowsOf(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('attachments')
        .selectAll()
        .where('workspace_id', 'in', (eb) =>
          eb.selectFrom('workspaces').select('id').where('organization_id', '=', db.organizationId),
        ),
    ),
  );
}

function withDelete(onDelete: (keys: string[]) => Promise<void>, base: Env = env): Env {
  const bucket = new Proxy(env.ATTACHMENTS, {
    get(target, property) {
      if (property === 'delete') return (keys: string | string[]) => onDelete(typeof keys === 'string' ? [keys] : keys);
      const member: unknown = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return Object.assign({}, base, { ATTACHMENTS: bucket });
}

const deletesAttachments = (sqls: readonly string[]) => sqls.some((sql) => sql.startsWith('delete from "attachments"'));

function scheduled(target: Env = env, cron = '0 * * * *') {
  return worker.scheduled(createScheduledController({ scheduledTime: NOW.getTime(), cron }), target);
}

describe('未添付の期限と残す行', () => {
  test('1日を過ぎた未添付の行と R2 のファイルが消える', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test.each([
    [DAY, '1日ちょうど'],
    [DAY - 1, '1日の1ミリ秒前'],
    [0, '基準日時ちょうど'],
    [-1, '基準日時より後'],
  ])('%s ミリ秒前（%s）の未添付の行とファイルは残る', async (age) => {
    const target = await fixture();
    const row = await storedAttachment(target, { created_at: before(age) });

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([row]);
    expect(await (await env.ATTACHMENTS.get(row.object_key))?.text()).toBe('x');
  });

  test('付く先のある行とファイルは、古くても残る', async () => {
    const target = await fixture();
    const task = await createTask(target.organization, target.workspace.id, target.user.id);
    const row = await storedAttachment(target, {
      created_at: before(DAY * 10),
      task_id: task.id,
      attached_at: before(DAY * 9),
    });

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([row]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });

  test('基準は実行時の時計でなく渡された scheduledTime', async () => {
    const target = await fixture();
    const row = await storedAttachment(target, { created_at: before(DAY - 1) });
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime() + DAY * 100);

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([row]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });

  test('R2 のファイルが既に無くても未添付の行を消せる', async () => {
    const target = await fixture();
    const row = await createAttachment(target.organization, target.workspace.id, target.user.id, {
      created_at: before(DAY + 1),
    });

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('2回実行しても結果が変わらず、新しい行と付いた行は残る', async () => {
    const target = await fixture();
    const old = await storedAttachment(target);
    const recent = await storedAttachment(target, { created_at: before(DAY - 1) });
    const task = await createTask(target.organization, target.workspace.id, target.user.id);
    const attached = await storedAttachment(target, { task_id: task.id, attached_at: before(1) });

    await cleanupAttachments(env, NOW);
    const first = await rowsOf(target.organization);
    await cleanupAttachments(env, NOW);

    expect((await rowsOf(target.organization)).map((row) => row.id).sort()).toEqual([recent.id, attached.id].sort());
    expect(await rowsOf(target.organization)).toEqual(first);
    expect(await env.ATTACHMENTS.get(old.object_key)).toBeNull();
    expect(await env.ATTACHMENTS.get(recent.object_key)).not.toBeNull();
    expect(await env.ATTACHMENTS.get(attached.object_key)).not.toBeNull();
  });
});

describe('組織とワークスペースの境界', () => {
  test('異なる組織と同じ組織の別ワークスペースを、それぞれの期限で処理する', async () => {
    const a = await fixture();
    const b = await fixture();
    const anotherWorkspace = await createWorkspace(a.organization, a.user.id);
    const oldA = await storedAttachment(a);
    const oldB = await storedAttachment(b);
    const recentB = await storedAttachment(b, { created_at: before(DAY - 1) });
    const oldOther = await storedAttachment({ ...a, workspace: anotherWorkspace });

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(a.organization)).toEqual([]);
    expect(await rowsOf(b.organization)).toEqual([recentB]);
    for (const row of [oldA, oldB, oldOther]) {
      expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    }
    expect(await env.ATTACHMENTS.get(recentB.object_key)).not.toBeNull();
  });

  test('停止した組織は消さず、停止していない組織の未添付は消す', async () => {
    const stopped = await fixture({ suspended: true });
    const active = await fixture();
    const stoppedRow = await storedAttachment(stopped);
    const activeRow = await storedAttachment(active);

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(stopped.organization)).toEqual([stoppedRow]);
    expect(await env.ATTACHMENTS.get(stoppedRow.object_key)).not.toBeNull();
    expect(await rowsOf(active.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(activeRow.object_key)).toBeNull();
  });

  test('閉じたワークスペースの未添付の行も期限を過ぎれば消す', async () => {
    const target = await fixture({ closed: true });
    const row = await storedAttachment(target);

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });
});

describe('1回の件数の上限', () => {
  test('1組織の繰り返し回数に達したら残りを次の実行に回す', async () => {
    const target = await fixture();
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await storedAttachment(target));

    await cleanupAttachments(env, NOW, { limit: 2, maxRounds: 2 });

    const remaining = await rowsOf(target.organization);
    expect(remaining).toHaveLength(1);
    for (const row of rows) {
      const object = await env.ATTACHMENTS.get(row.object_key);
      if (remaining.some((value) => value.id === row.id)) expect(object).not.toBeNull();
      else expect(object).toBeNull();
    }

    await cleanupAttachments(env, NOW, { limit: 2, maxRounds: 2 });
    expect(await rowsOf(target.organization)).toEqual([]);
    for (const row of rows) expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('ある組織が回数を使い切っても別の組織を処理する', async () => {
    const a = await fixture();
    const b = await fixture();
    for (let i = 0; i < 3; i++) {
      await storedAttachment(a);
      await storedAttachment(b);
    }

    await cleanupAttachments(env, NOW, { limit: 2, maxRounds: 1 });

    expect(await rowsOf(a.organization)).toHaveLength(1);
    expect(await rowsOf(b.organization)).toHaveLength(1);
  });

  test('既定の1文の上限は50件で、51件目は次の文で消す', async () => {
    const target = await fixture();
    for (let i = 0; i < 51; i++) await storedAttachment(target);
    const batches: string[][] = [];
    const observed = withDelete(async (keys) => {
      const mine = keys.filter((key) => key.startsWith(`${target.organization.id}/`));
      if (mine.length > 0) batches.push(mine);
      await env.ATTACHMENTS.delete(keys);
    });

    await cleanupAttachments(observed, NOW);

    expect(batches.map((keys) => keys.length)).toEqual([50, 1]);
    expect(await rowsOf(target.organization)).toEqual([]);
  });

  test('既定の繰り返しは1組織20回まで', async () => {
    const target = await fixture();
    for (let i = 0; i < 21; i++) await storedAttachment(target);

    await cleanupAttachments(env, NOW, { limit: 1 });

    expect(await rowsOf(target.organization)).toHaveLength(1);
  });

  test('全体の20秒に達したら次の文と残りの組織を始めない', async () => {
    const a = await fixture();
    const b = await fixture();
    for (const target of [a, b]) {
      await storedAttachment(target);
      await storedAttachment(target);
    }
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const targetPrefixes = [a, b].map((target) => `${target.organization.id}/`);
    const observed = withDelete(async (keys) => {
      await env.ATTACHMENTS.delete(keys);
      if (keys.some((key) => targetPrefixes.some((prefix) => key.startsWith(prefix)))) clock = 20_000;
    });

    await cleanupAttachments(observed, NOW, { limit: 1 });

    expect((await rowsOf(a.organization)).length + (await rowsOf(b.organization)).length).toBe(3);
  });

  test('DBで消した後に時間切れになっても、そのキーのR2削除の完了を待つ', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let enter!: () => void;
    const entered = new Promise<'entered'>((resolve) => {
      enter = () => resolve('entered');
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = withDelete(async (keys) => {
      if (keys.includes(row.object_key)) {
        clock = 20_000;
        enter();
        await released;
      }
      await env.ATTACHMENTS.delete(keys);
    });
    let settled = false;
    const running = cleanupAttachments(observed, NOW).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      expect(await Promise.race([entered, running])).toBe('entered');
      expect(await rowsOf(target.organization)).toEqual([]);
      expect(settled).toBe(false);
      expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
    } finally {
      release();
      await running;
    }
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });
});

describe('削除順と保存との競合', () => {
  test('DELETE RETURNINGの1文で消えた行のキーだけを、DB削除の後にR2から消す', async () => {
    const target = await fixture();
    const old = await storedAttachment(target);
    const recent = await storedAttachment(target, { created_at: before(DAY - 1) });
    const statements: string[][] = [];
    const database = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (deletesAttachments(sqls)) statements.push([...sqls]);
      },
    });
    const deletedKeys: string[] = [];
    const observed = withDelete(async (keys) => {
      if (keys.includes(old.object_key)) {
        expect((await rowsOf(target.organization)).map((row) => row.id)).toEqual([recent.id]);
        deletedKeys.push(...keys.filter((key) => key.startsWith(`${target.organization.id}/`)));
      }
      await env.ATTACHMENTS.delete(keys);
    }, database);

    await cleanupAttachments(observed, NOW);

    expect(deletedKeys).toEqual([old.object_key]);
    expect(statements.length).toBeGreaterThan(0);
    for (const sqls of statements) {
      expect(sqls).toHaveLength(1);
      expect(sqls[0]).toMatch(/returning .*object_key/);
    }
    expect(await env.ATTACHMENTS.get(recent.object_key)).not.toBeNull();
  });

  test('組織の一覧を読んだ後で保存が先に付けた行は、掃除で消さない', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const task = await createTask(target.organization, target.workspace.id, target.user.id);
    let attached = false;
    const racing = envWithD1Hooks(env, {
      async afterQuery(sql) {
        if (attached || !sql.includes('from "organizations"')) return;
        attached = true;
        const db = orgDb(env, target.organization.verified);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('attachments')
              .set({ task_id: task.id, attached_at: NOW.toISOString() })
              .where('id', '=', row.id)
              .where('workspace_id', '=', target.workspace.id)
              .where('attached_at', 'is', null),
          ),
        ]);
      },
    });

    await cleanupAttachments(racing, NOW);

    expect(attached).toBe(true);
    expect(await rowsOf(target.organization)).toMatchObject([{ id: row.id, task_id: task.id }]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });

  test('掃除のDELETEが先に勝った行は、その直後の保存のUPDATEでは付かない', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const task = await createTask(target.organization, target.workspace.id, target.user.id);
    let raced = false;
    let changed = -1;
    const racing = envWithD1Hooks(env, {
      async afterBatch(sqls) {
        if (raced || !deletesAttachments(sqls) || (await rowsOf(target.organization)).length > 0) return;
        raced = true;
        const db = orgDb(env, target.organization.verified);
        const [result] = await db.batch([
          db.statement((q) =>
            q
              .updateTable('attachments')
              .set({ task_id: task.id, attached_at: NOW.toISOString() })
              .where('id', '=', row.id)
              .where('workspace_id', '=', target.workspace.id)
              .where('attached_at', 'is', null),
          ),
        ]);
        changed = result.changes;
      },
    });

    await cleanupAttachments(racing, NOW);

    expect(raced).toBe(true);
    expect(changed).toBe(0);
    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });
});

describe('R2のキーと失敗の分離', () => {
  test('別の組織のキーと組織IDだけ前方一致するキーは消さず、件数だけを記録する', async () => {
    const target = await fixture();
    const elsewhere = await fixture({ suspended: true });
    const protectedRow = await storedAttachment(elsewhere);
    // object_key は表全体で一意なので、別の組織の行でなく、行の無いR2のファイルを指させる。
    const foreignKey = `${elsewhere.organization.id}/${elsewhere.workspace.id}/orphan-secret`;
    const nearKey = `${target.organization.id}-other/${target.workspace.id}/orphan-secret`;
    await env.ATTACHMENTS.put(foreignKey, 'foreign');
    await env.ATTACHMENTS.put(nearKey, 'near');
    await createAttachment(target.organization, target.workspace.id, target.user.id, {
      created_at: before(DAY + 1),
      object_key: foreignKey,
    });
    await createAttachment(target.organization, target.workspace.id, target.user.id, {
      created_at: before(DAY + 1),
      object_key: nearKey,
    });
    const good = await storedAttachment(target);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cleanupAttachments(env, NOW);

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(good.object_key)).toBeNull();
    expect(await (await env.ATTACHMENTS.get(foreignKey))?.text()).toBe('foreign');
    expect(await (await env.ATTACHMENTS.get(nearKey))?.text()).toBe('near');
    expect(await env.ATTACHMENTS.get(protectedRow.object_key)).not.toBeNull();
    const lines = [...warn.mock.calls, ...error.mock.calls].map(([line]) => String(line));
    expect(lines.some((line) => JSON.parse(line).count === 2)).toBe(true);
    expect(lines.join('\n')).not.toContain('orphan-secret');
    expect(lines.join('\n')).not.toContain(foreignKey);
    expect(lines.join('\n')).not.toContain(nearKey);
  });

  test('D1の削除に失敗したらR2を触らず、行とファイルは次の実行で消せる', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (deletesAttachments(sqls)) throw new Error('secret-d1-query');
      },
    });
    const deleted: string[] = [];
    const observed = withDelete(async (keys) => {
      deleted.push(...keys);
      await env.ATTACHMENTS.delete(keys);
    }, failing);

    await expect(cleanupAttachments(observed, NOW)).rejects.toThrow();

    expect(deleted).toEqual([]);
    expect(await rowsOf(target.organization)).toEqual([row]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-d1-query');
    await cleanupAttachments(env, NOW);
    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('1つの組織のD1削除が失敗しても後の組織を処理する', async () => {
    const a = await fixture();
    const b = await fixture();
    const rows = [await storedAttachment(a), await storedAttachment(b)];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const failing = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (!deletesAttachments(sqls)) return;
        attempts++;
        if (attempts === 1) throw new Error('first-organization-failed');
      },
    });

    await expect(cleanupAttachments(failing, NOW)).rejects.toThrow();

    expect(attempts).toBeGreaterThan(1);
    const remaining = [...(await rowsOf(a.organization)), ...(await rowsOf(b.organization))];
    expect(remaining.length).toBeLessThanOrEqual(1);
    for (const row of rows) {
      if (remaining.some((value) => value.id === row.id))
        expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
      else expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    }
  });

  test('1つの組織のR2削除が失敗しても残りを消し、消せなかった件数を残して最後に失敗する', async () => {
    const a = await fixture();
    const b = await fixture();
    const rows = [await storedAttachment(a), await storedAttachment(b)];
    let failedKey: string | undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observed = withDelete(async (keys) => {
      const mine = keys.find((key) => rows.some((row) => row.object_key === key));
      if (mine !== undefined && failedKey === undefined) {
        failedKey = mine;
        throw new Error(`secret-r2-detail ${mine}`);
      }
      await env.ATTACHMENTS.delete(keys);
    });

    await expect(cleanupAttachments(observed, NOW)).rejects.toThrow();

    expect(failedKey).toBeDefined();
    expect(await rowsOf(a.organization)).toEqual([]);
    expect(await rowsOf(b.organization)).toEqual([]);
    for (const row of rows) {
      if (row.object_key === failedKey) expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
      else expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    }
    const lines = error.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => JSON.parse(line).count === 1)).toBe(true);
    expect(lines.join('\n')).not.toContain('secret-r2-detail');
    expect(lines.join('\n')).not.toContain(failedKey);
  });
});

describe('cronへの登録と既存処理との分離', () => {
  test('毎時0分のcronから未添付の行とファイルが消える', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);

    await scheduled();

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });

  test('毎分のcronは未添付の行とファイルを消さない', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);

    await scheduled(env, '* * * * *');

    expect(await rowsOf(target.organization)).toEqual([row]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });

  test('毎時の試用期限切れの停止に失敗しても添付の掃除は行う', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(env, {
      beforeBatch(sqls) {
        if (sqls.some((sql) => sql.startsWith('update "organizations"'))) throw new Error('trial-stop-failed');
      },
    });

    await expect(scheduled(failing)).rejects.toThrow();

    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
    expect(JSON.stringify(error.mock.calls)).not.toContain('trial-stop-failed');
  });

  test('添付の掃除に失敗しても毎時の試用期限切れの停止は行う', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const expired = await createOrganization({ trial_ends_on: '2026-11-04' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = withDelete(async (keys) => {
      if (keys.includes(row.object_key)) throw new Error('attachment-cleanup-failed');
      await env.ATTACHMENTS.delete(keys);
    });

    await expect(scheduled(failing)).rejects.toThrow();

    const db = commonDb(env);
    const organization = await db.first(
      db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', expired.id)),
    );
    expect(organization?.suspended_at).toBe(NOW.toISOString());
    expect(await rowsOf(target.organization)).toEqual([]);
    expect(await env.ATTACHMENTS.get(row.object_key)).not.toBeNull();
  });
});

describe('R2 の実行環境の前提', () => {
  test('R2 の一括削除は存在しないキーを含んでも繰り返し成功する', async () => {
    const target = await fixture();
    const row = await storedAttachment(target);
    const keys = [row.object_key, `${target.organization.id}/${target.workspace.id}/missing`];

    await env.ATTACHMENTS.delete(keys);
    await env.ATTACHMENTS.delete(keys);

    expect(await env.ATTACHMENTS.get(row.object_key)).toBeNull();
  });
});
