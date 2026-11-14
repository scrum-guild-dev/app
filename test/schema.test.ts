// スキーマの CHECK と一意のうち、壊れると事故になるもの（docs/data-model.md）。
// 確かめたいのは SQL の制約そのものなので、Kysely の入口を通さず D1 の binding に直に書く
// （索引の実行計画のうち、処理が組み立てる文そのものを見るものは、その文を queryPlanForTest に渡す）
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { compiledQueryForTest, queryPlanForTest, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import {
  experienceGrantsOperation,
  experienceSummaryOperation,
  userExperienceTotalStatement,
} from '../src/server/operations/experience.ts';
import { revokeSameEmailStatements } from '../src/server/operations/invitation.ts';
import { todayOperation } from '../src/server/operations/today.ts';
import {
  createComment,
  createDelegatee,
  createEpic,
  createOrganization,
  createStory,
  createTask,
  createUser,
  createWorkspace,
  uuidv7,
} from './factories.ts';

const AT = '2026-10-20T00:00:00.000Z';
const CLAIM_EXPIRES_AT = '2026-11-03T00:00:00.000Z';

describe('容量通知のスキーマ', () => {
  test('通知本文はJSONで、日時はUTCミリ秒の形だけを受け付ける', async () => {
    const insert = (payload: string, created: string, read: string | null = null) =>
      run(
        'INSERT INTO notifications (id, user_id, kind, payload_json, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)',
        id(),
        id(),
        'attachment_quota_warning',
        payload,
        created,
        read,
      );
    await insert('{"used_bytes":81,"quota_bytes":100}', AT);
    await expect(insert('{', AT)).rejects.toThrow(/CHECK/);
    await expect(insert('{}', '2026-11-10')).rejects.toThrow(/CHECK/);
    await expect(insert('{}', AT, '2026-11-10')).rejects.toThrow(/CHECK/);
  });

  test('配信待ちの日時は空かUTCミリ秒の形だけを受け付ける', async () => {
    const orgId = await organization();
    await expect(
      run('UPDATE organizations SET attachment_quota_warning_pending_at = ? WHERE id = ?', 'invalid', orgId),
    ).rejects.toThrow(/CHECK/);
    await run('UPDATE organizations SET attachment_quota_warning_pending_at = ? WHERE id = ?', AT, orgId);
    await run('UPDATE organizations SET attachment_quota_warning_pending_at = NULL WHERE id = ?', orgId);
  });
});

describe('0029_drop_organization_theme', () => {
  test('組織のテーマの列を持たず、ユーザーのテーマと組織の言葉づかいの列は残す', async () => {
    const organizationColumns = await env.DB.prepare('PRAGMA table_info(organizations)').all<{ name: string }>();
    const userColumns = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();

    expect(organizationColumns.results.map((column) => column.name)).not.toContain('theme');
    expect(organizationColumns.results.map((column) => column.name)).toContain('vocabulary');
    expect(userColumns.results.map((column) => column.name)).toContain('theme');
  });
});

describe('0027_remove_medieval_theme', () => {
  // 前の版で書かれた行を作ってから、0027 の SQL を当て直す（テストの D1 には全マイグレーションが当て済み）
  test('中世風（medieval）を選んでいた行だけを NULL に戻し、ほかのテーマと NULL の行は変えない', async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0027_'));
    expect(migration).toBeDefined();
    const organization = await createOrganization();
    const other = await createOrganization();
    const medieval = [
      await createUser(organization, { theme: 'medieval' }),
      await createUser(other, { theme: 'medieval' }),
    ];
    const kept = await Promise.all(
      (['simple', 'simple_light', 'simple_dark', 'modern', null] as const).map(async (theme) => ({
        theme,
        user: await createUser(organization, { theme }),
      })),
    );
    const themeOf = async (userId: string) =>
      (await env.DB.prepare('SELECT theme FROM users WHERE id = ?').bind(userId).first<{ theme: string | null }>())!
        .theme;

    await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)));

    for (const user of medieval) expect(await themeOf(user.id)).toBeNull();
    for (const { theme, user } of kept) expect(await themeOf(user.id)).toBe(theme);
  });
});

function id(): string {
  return crypto.randomUUID();
}

function run(sql: string, ...values: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...values)
    .run();
}

async function organization(slug = `org-${id().slice(0, 8)}`): Promise<string> {
  const orgId = id();
  await run(
    `INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES (?, ?, '組織', 'github:9000000000000001', ?, ?)`,
    orgId,
    slug,
    AT,
    AT,
  );
  return orgId;
}

type UserColumns = {
  loginProvider?: string;
  loginSubject?: string | null;
  loginEmail?: string | null;
  claimTokenHash?: string | null;
  claimExpiresAt?: string | null;
};

function insertUser(orgId: string, columns: UserColumns = {}) {
  const userId = id();
  return {
    userId,
    result: run(
      `INSERT INTO users (id, organization_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', ?, ?)`,
      userId,
      orgId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      AT,
      AT,
    ),
  };
}

async function user(orgId: string): Promise<string> {
  const { userId, result } = insertUser(orgId);
  await result;
  return userId;
}

async function workspace(): Promise<{ orgId: string; userId: string; workspaceId: string }> {
  const orgId = await organization();
  const userId = await user(orgId);
  const workspaceId = id();
  await run(
    `INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) VALUES (?, ?, 'ワークスペース', 'Asia/Tokyo', ?, ?, ?)`,
    workspaceId,
    orgId,
    userId,
    AT,
    AT,
  );
  return { orgId, userId, workspaceId };
}

// テストファイルの中では前のテストの行が残るので、一意の列は呼ぶたびに新しい値にする
function googlePending() {
  return {
    loginProvider: 'google',
    loginSubject: null,
    loginEmail: 'mio.hoshino@example.com',
    claimTokenHash: (id() + id()).replaceAll('-', ''),
    claimExpiresAt: CLAIM_EXPIRES_AT,
  };
}

describe('外部キー', () => {
  test('0030 で削除した xp_grants_user_workspace は残っていない', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'xp_grants_user_workspace'`,
    ).all();
    expect(results).toEqual([]);
  });

  test('D1 は外部キーを検査する', async () => {
    await expect(insertUser(id()).result).rejects.toThrow(/FOREIGN KEY/);
  });

  // 待っていた users の行を消すとき（Google の招待で同じ sub の行と統合する）、外部キーの検査が子の表を全件読まないこと
  test('users の行を消す文は、users を指すどの列も索引で引く', async () => {
    // D1 は pragma_foreign_key_list を表の列で結合すると断るので、表ごとに引く
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'`,
    ).all<{ name: string }>();
    const children: string[] = [];
    for (const { name } of tables) {
      const { results: keys } = await env.DB.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`)
        .bind(name)
        .all<{ parent: string }>();
      children.push(...keys.filter((key) => key.parent === 'users').map(() => name));
    }
    const { results: plan } = await env.DB.prepare(`EXPLAIN QUERY PLAN DELETE FROM users WHERE id = ?`)
      .bind(id())
      .all<{ detail: string }>();
    const details = plan.map((row) => row.detail);

    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^SEARCH xp_grants USING (COVERING )?INDEX xp_grants_user_(workspace_amount|confirmed) \(user_id=\?\)$/,
        ),
      ]),
    );
    expect(details.filter((detail) => detail.startsWith('SCAN '))).toEqual([]);
    // その場で作る索引（AUTOMATIC）でなく、張った索引で引くこと
    expect(details.filter((detail) => !/^SEARCH \w+ USING (COVERING )?INDEX \w+ /.test(detail))).toEqual([]);
    // 外部キーの列ごとに1行ずつ SEARCH が出る。実行計画が検査を載せなくなったら、上の確かめが空振りするので数も見る
    const searched = details
      .map((detail) => /^SEARCH (\w+) /.exec(detail)?.[1])
      .filter((table) => table !== undefined && table !== 'users');
    expect(children.length).toBeGreaterThan(0);
    expect(searched.sort()).toEqual(children.sort());
  });

  // 外部キーの検査の索引が、担当の未完了のタスク（今日やること、積載量）も引く。完了した行と消した行を読まないこと
  test('担当の未完了のタスクを引く文は、tasks_assignee_user の3列で絞る', async () => {
    const { results: plan } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE assignee_user_id = ? AND deleted_at IS NULL AND completed_at IS NULL`,
    )
      .bind(id())
      .all<{ detail: string }>();
    const details = plan.map((row) => row.detail).join('\n');

    expect(details).toContain(
      'USING INDEX tasks_assignee_user (assignee_user_id=? AND deleted_at=? AND completed_at=?)',
    );
    expect(details).not.toMatch(/^SCAN tasks\b/m);
  });

  // 今日やること（today）は未完了と完了を別の文にして、どちらも tasks_assignee_user の範囲で引く。
  // memberships、workspaces、tasks を結合する本物の文で、別の索引が選ばれて tasks を全件走査していないこと
  test('今日やることの未完了と完了の文は、tasks_assignee_user で引き、tasks を SCAN しない', async () => {
    const db = orgDb(env, verifiedOrganizationForTest(id()));
    const batch = vi.spyOn(db, 'batch');
    try {
      await todayOperation.handler({ db, actor: { userId: id() }, input: {} } as never);
      const statements = batch.mock.calls[0][0].filter((candidate) =>
        compiledQueryForTest(candidate).sql.includes('"tasks" as "t"'),
      );
      // 未完了と完了の2文。位置でなく、絞り込みの条件で見分ける
      expect(statements).toHaveLength(2);
      const open = statements.find((candidate) =>
        compiledQueryForTest(candidate).sql.includes('"completed_at" is null'),
      );
      const completed = statements.find((candidate) =>
        compiledQueryForTest(candidate).sql.includes('"completed_at" >= ?'),
      );
      expect(open).toBeDefined();
      expect(completed).toBeDefined();
      for (const statement of [open!, completed!]) {
        const details = await queryPlanForTest(env, statement);
        const text = details.join('\n');
        // 未完了は completed_at=?（IS NULL）、完了は completed_at>?（範囲）まで索引に乗る
        expect(text).toMatch(
          /SEARCH t USING INDEX tasks_assignee_user \(assignee_user_id=\? AND deleted_at=\? AND completed_at[=>]\?\)/,
        );
        expect(
          details.filter((detail) => /^SCAN (tasks|t)\b/.test(detail)),
          text,
        ).toEqual([]);
      }
    } finally {
      batch.mockRestore();
    }
  });

  // 進行中のスプリントを引く文（activeSprintRowFilter）は、'active' を束縛せず文字のまま書くので、部分索引 sprints_active を使う。
  // 束縛の値（?）で書くと、SQLite は索引の条件を含むと示せず、使わない
  test('進行中のスプリントを引く文は、部分索引 sprints_active を使う', async () => {
    const plan = async (sql: string) => {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(id()).all<{ detail: string }>();
      return results.map((row) => row.detail).join('\n');
    };

    expect(
      await plan(
        `SELECT act.id FROM sprints AS act WHERE act.workspace_id = ? AND (act.status = 'active' AND act.deleted_at IS NULL)`,
      ),
    ).toContain('USING INDEX sprints_active');
    expect(
      await plan(
        `SELECT act.id FROM sprints AS act WHERE act.workspace_id = ? AND act.status = 'active' AND act.deleted_at IS NULL`,
      ),
    ).toContain('USING INDEX sprints_active');
  });

  // Google で招待し直すときの取り消しの2文（記録と UPDATE）は、'pending' を束縛せず文字のまま書くので、
  // 部分索引 invitations_pending_email（WHERE status = 'pending' AND login_subject IS NULL）を使い、invitations を SCAN しない
  test('Google の招待し直しの取り消しの文は、部分索引 invitations_pending_email を使う', async () => {
    const db = orgDb(env, verifiedOrganizationForTest(id()));
    const statements = revokeSameEmailStatements(db, {
      workspaceId: id(),
      email: 'mio.hoshino@example.com',
      actorUserId: id(),
      at: new Date(AT),
    });
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const details = await queryPlanForTest(env, statement);
      // 索引の条件は、束縛でなく文字のまま書く（値を見て計画し直す SQLite の働きに頼らない）
      expect(compiledQueryForTest(statement).sql).toContain(`"status" = 'pending' AND`);
      const invitations = details.filter((detail) => /^(SEARCH|SCAN) (invitations|i)\b/.test(detail));
      expect(invitations.length, details.join('\n')).toBeGreaterThan(0);
      expect(
        invitations.every((detail) => detail.includes('USING INDEX invitations_pending_email')),
        details.join('\n'),
      ).toBe(true);
      expect(
        details.filter((detail) => detail.startsWith('SCAN ')),
        details.join('\n'),
      ).toEqual([]);
    }
  });

  // 使わない索引も書くたびに更新され、D1 の書いた行数に数えられる。統計の無い空の表では計画が変わらないので、残っていないことを直に見る
  test('外部キーの検査の索引と重なる部分索引は残っていない', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('memberships_user_current', 'tasks_assignee_open')`,
    ).all<{ name: string }>();

    expect(results).toEqual([]);
  });
});

describe('経験値の読み取りの索引', () => {
  test.each([undefined, { confirmed_at: AT, id: 'cursor' }])(
    '明細の頁送り（before: %j）は索引の順で読み、並べ替えない',
    async (before) => {
      const db = orgDb(env, verifiedOrganizationForTest(id()));
      // 処理が実際に作った文を捕まえる。結合、カーソル、LIMIT も本番と同じ文で確かめる
      const rows = vi.spyOn(db, 'rows');
      try {
        await experienceGrantsOperation.handler({ db, actor: { userId: id() }, input: { before } } as never);
        expect(rows).toHaveBeenCalledTimes(1);
        const statement = rows.mock.calls[0][0];
        const query = compiledQueryForTest(statement);
        expect(query.sql).toMatch(/order by "g"\."confirmed_at" desc, "g"\."id" desc limit \?$/);
        expect(query.parameters.at(-1)).toBe(51);
        const details = (await queryPlanForTest(env, statement)).join('\n');
        // 続きの頁は、カーソルの位置を索引の範囲にして、新しい側の項目を読まない
        expect(details).toContain(
          before === undefined
            ? 'SEARCH g USING INDEX xp_grants_user_confirmed (user_id=?)'
            : 'SEARCH g USING INDEX xp_grants_user_confirmed (user_id=? AND (confirmed_at,id)<(?,?))',
        );
        // 索引に id が無いと「LAST TERM OF ORDER BY」の一時 B-tree が出るので、種類を問わず出ないことを見る
        expect(details).not.toContain('TEMP B-TREE');
      } finally {
        rows.mockRestore();
      }
    },
  );

  test('経験値の見込みは、部分索引 tasks_created_by_open で本人の未完了のタスクだけを引く', async () => {
    const db = orgDb(env, verifiedOrganizationForTest(id()));
    // 処理が実際に作った3つ目の文（見込み）を捕まえる
    const batch = vi.spyOn(db, 'batch');
    try {
      await experienceSummaryOperation.handler({ db, actor: { userId: id() }, input: {} } as never);
      // 位置でなく、tasks を引いている文として選ぶ（文の順が変わっても別の文を見ない）
      const statement = batch.mock.calls[0][0].find((candidate) =>
        compiledQueryForTest(candidate).sql.includes('"tasks" as "t"'),
      );
      expect(statement).toBeDefined();
      const details = (await queryPlanForTest(env, statement!)).join('\n');
      expect(details).toContain('SEARCH t USING INDEX tasks_created_by_open (created_by=? AND completed_at=?)');
    } finally {
      batch.mockRestore();
    }
  });

  test('組織の経験値の合計は、xp_grants の表の行を引かず索引だけで読む', async () => {
    const db = orgDb(env, verifiedOrganizationForTest(id()));
    const details = (await queryPlanForTest(env, userExperienceTotalStatement(db, id()))).join('\n');
    expect(details).toContain('SEARCH g USING COVERING INDEX xp_grants_user_workspace_amount (user_id=?)');
  });
});

// SQLite の通常の表では、PRIMARY KEY だけでは NULL を拒まない
describe('主キー', () => {
  test.each([
    ['省いた', `INSERT INTO accounts (created_at, updated_at) VALUES (?, ?)`],
    ['NULL を渡した', `INSERT INTO accounts (id, created_at, updated_at) VALUES (NULL, ?, ?)`],
  ])('ID を%sら当たる', async (_, sql) => {
    await expect(run(sql, AT, AT)).rejects.toThrow(/NOT NULL/);
  });
});

describe('セッションとログインの途中の状態', () => {
  async function account(): Promise<string> {
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    return accountId;
  }

  function session(accountId: string, tokenHash: string) {
    return run(
      `INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      tokenHash,
      accountId,
      AT,
      AT,
      AT,
    );
  }

  function oauthState(columns: { claimTokenHash?: string; returnTo?: string }) {
    return run(
      `INSERT INTO oauth_states (state, login_provider, code_verifier, claim_token_hash, return_to, expires_at) VALUES (?, 'google', 'v', ?, ?, ?)`,
      id(),
      columns.claimTokenHash ?? null,
      columns.returnTo ?? null,
      AT,
    );
  }

  test('token_hash は SHA-256 の小文字の16進64文字', async () => {
    const accountId = await account();
    await expect(session(accountId, (id() + id()).replaceAll('-', ''))).resolves.toBeTruthy();
  });

  test.each([
    ['ハッシュする前のトークン', 'dev-seed-admin-0000000000000000000000000000'],
    ['大文字の16進', 'A'.repeat(64)],
    ['63文字', 'a'.repeat(63)],
  ])('%sは当たる', async (_, tokenHash) => {
    await expect(session(await account(), tokenHash)).rejects.toThrow(/CHECK/);
    await expect(oauthState({ claimTokenHash: tokenHash })).rejects.toThrow(/CHECK/);
  });

  const oauthStateWithSignup = (signup: number) =>
    run(
      `INSERT INTO oauth_states (state, login_provider, code_verifier, expires_at, is_signup) VALUES (?, 'google', 'v', ?, ?)`,
      id(),
      AT,
      signup,
    );

  test.each([0, 1])('会員登録の印 signup=%i は通る（#640）', async (signup) => {
    await expect(oauthStateWithSignup(signup)).resolves.toBeTruthy();
  });

  test.each([2, -1])('会員登録の印 signup=%i は当たる（#640）', async (signup) => {
    await expect(oauthStateWithSignup(signup)).rejects.toThrow(/CHECK/);
  });

  test('会員登録の印の列を省くと 0 になる（#640）', async () => {
    const state = id();
    await run(
      `INSERT INTO oauth_states (state, login_provider, code_verifier, expires_at) VALUES (?, 'google', 'v', ?)`,
      state,
      AT,
    );
    const row = await env.DB.prepare('SELECT is_signup FROM oauth_states WHERE state = ?').bind(state).first();
    expect(row).toEqual({ is_signup: 0 });
  });

  test.each(['/aoba', '/invite', '/'])('戻り先 %s は通る', async (returnTo) => {
    await expect(oauthState({ returnTo })).resolves.toBeTruthy();
  });

  test.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example/',
    'aoba',
    '/\t/evil.example',
    '/\n/evil.example',
  ])('戻り先 %s は当たる', async (returnTo) => {
    await expect(oauthState({ returnTo })).rejects.toThrow(/CHECK/);
  });
});

describe('organizations.slug', () => {
  test.each(['ab', 'aoba', 'ab-1', '0a', 'a'.repeat(40)])('%s は通る', async (slug) => {
    await expect(organization(slug)).resolves.toBeTypeOf('string');
  });

  test.each(['a', 'a'.repeat(41), 'Aoba', '-ab', 'ab_c', 'ab c', 'あおば'])('%s は CHECK に当たる', async (slug) => {
    await expect(organization(slug)).rejects.toThrow(/CHECK/);
  });

  test('同じ slug は2つ作れない', async () => {
    await organization('same-slug');
    await expect(organization('same-slug')).rejects.toThrow(/UNIQUE/);
  });
});

// users と invitations は同じ3つの CHECK を持つ
describe.each(['users', 'invitations'] as const)('%s の待つ列', (table) => {
  async function insert(columns: UserColumns) {
    if (table === 'users') return insertUser(await organization(), columns).result;
    const { userId, workspaceId } = await workspace();
    return run(
      `INSERT INTO invitations (id, workspace_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, login_name, role, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', 'member', ?, 'pending', ?)`,
      id(),
      workspaceId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      userId,
      AT,
    );
  }

  test('Google でメールアドレスと招待の URL の秘密で待つ行は入る', async () => {
    await expect(insert(googlePending())).resolves.toBeTruthy();
  });

  // 待つ列をすべて空にして、1つ目の CHECK だけが働く形にする
  test('待つ列が無いのに login_subject も空なら当たる', async () => {
    await expect(insert({ loginSubject: null })).rejects.toThrow(/CHECK/);
  });

  test('login_subject と login_email の両方が空なら当たる', async () => {
    await expect(insert({ ...googlePending(), loginEmail: null })).rejects.toThrow(/CHECK/);
  });

  test('login_subject と login_email の両方が入っていれば当たる', async () => {
    await expect(insert({ ...googlePending(), loginSubject: '1234567890' })).rejects.toThrow(/CHECK/);
  });

  test.each([
    ['claim_token_hash', { claimTokenHash: null }],
    ['claim_expires_at', { claimExpiresAt: null }],
  ])('%s が欠けたら当たる', async (_, missing) => {
    await expect(insert({ ...googlePending(), ...missing })).rejects.toThrow(/CHECK/);
  });

  test('login_email は google の行だけ', async () => {
    await expect(insert({ ...googlePending(), loginProvider: 'github' })).rejects.toThrow(/CHECK/);
  });

  test.each(['Mio.Hoshino@example.com', ' mio.hoshino@example.com'])(
    'そろえていないメールアドレス（%j）は当たる',
    async (loginEmail) => {
      await expect(insert({ ...googlePending(), loginEmail })).rejects.toThrow(/CHECK/);
    },
  );
});

describe('users の一意', () => {
  test('同じ組織に同じログインの ID の行は2つ作れない', async () => {
    const orgId = await organization();
    await insertUser(orgId, { loginSubject: '1000101' }).result;
    await expect(insertUser(orgId, { loginSubject: '1000101' }).result).rejects.toThrow(/UNIQUE/);
  });

  test('別の組織なら同じログインの ID でも作れる', async () => {
    await insertUser(await organization(), { loginSubject: '1000101' }).result;
    await expect(insertUser(await organization(), { loginSubject: '1000101' }).result).resolves.toBeTruthy();
  });

  test('login_subject が空の待つ行は同じ組織に2つあってよい', async () => {
    const orgId = await organization();
    await insertUser(orgId, googlePending()).result;
    await expect(insertUser(orgId, googlePending()).result).resolves.toBeTruthy();
  });

  test('同じアカウントは同じ組織に1行だけ', async () => {
    const orgId = await organization();
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    const withAccount = (loginProvider: string) =>
      run(
        `INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '人', ?, ?)`,
        id(),
        orgId,
        accountId,
        loginProvider,
        id(),
        AT,
        AT,
      );
    await withAccount('github');
    await expect(withAccount('google')).rejects.toThrow(/UNIQUE/);
  });

  test('同じ claim_token_hash は2つ作れない', async () => {
    const orgId = await organization();
    const pending = googlePending();
    await insertUser(orgId, pending).result;
    await expect(insertUser(orgId, { ...pending, loginEmail: 'kotone@example.com' }).result).rejects.toThrow(/UNIQUE/);
  });
});

describe('invitations の承諾待ちの一意', () => {
  async function invite(workspaceId: string, invitedBy: string, status: string, columns: UserColumns) {
    return run(
      `INSERT INTO invitations (id, workspace_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, login_name, role, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', 'member', ?, ?, ?)`,
      id(),
      workspaceId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      invitedBy,
      status,
      AT,
    );
  }

  test('同じ人への承諾待ちの招待は1つだけ', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'pending', { loginSubject: '1000102' });
    await expect(invite(workspaceId, userId, 'pending', { loginSubject: '1000102' })).rejects.toThrow(/UNIQUE/);
  });

  test('承諾待ちでなくなった招待があれば、もう一度招待できる', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'revoked', { loginSubject: '1000102' });
    await expect(invite(workspaceId, userId, 'pending', { loginSubject: '1000102' })).resolves.toBeTruthy();
  });

  test('同じメールアドレスへの承諾待ちの招待は1つだけ', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'pending', googlePending());
    await expect(invite(workspaceId, userId, 'pending', googlePending())).rejects.toThrow(/UNIQUE/);
  });

  test('status は決まった値だけ', async () => {
    const { userId, workspaceId } = await workspace();
    await expect(invite(workspaceId, userId, 'expired', {})).rejects.toThrow(/CHECK/);
  });
});

describe('memberships の今の所属', () => {
  async function join(workspaceId: string, userId: string, leftAt: string | null) {
    return run(
      `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, left_on, joined_at, left_at) VALUES (?, ?, ?, 'member', '2026-10-01', ?, ?, ?)`,
      id(),
      workspaceId,
      userId,
      leftAt ? '2026-10-10' : null,
      AT,
      leftAt,
    );
  }

  test('今の所属は1人1行', async () => {
    const { userId, workspaceId } = await workspace();
    await join(workspaceId, userId, null);
    await expect(join(workspaceId, userId, null)).rejects.toThrow(/UNIQUE/);
  });

  test('抜けた行があっても、戻った新しい行を作れる', async () => {
    const { userId, workspaceId } = await workspace();
    await join(workspaceId, userId, AT);
    await expect(join(workspaceId, userId, null)).resolves.toBeTruthy();
  });

  test.each([
    ['離脱日だけ入っている', '2026-10-10', null],
    ['離脱の日時だけ入っている', null, AT],
    ['離脱日が参加日より前', '2026-09-30', AT],
  ])('%s行は当たる', async (_, leftOn, leftAt) => {
    const { userId, workspaceId } = await workspace();
    await expect(
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, left_on, joined_at, left_at) VALUES (?, ?, ?, 'member', '2026-10-01', ?, ?, ?)`,
        id(),
        workspaceId,
        userId,
        leftOn,
        AT,
        leftAt,
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('board_columns', () => {
  async function column(workspaceId: string, name: string | null, isDone: number) {
    return run(
      `INSERT INTO board_columns (id, workspace_id, name, is_done, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'a0', ?, ?)`,
      id(),
      workspaceId,
      name,
      isDone,
      AT,
      AT,
    );
  }

  test('完了の列はワークスペースに1つ', async () => {
    const { workspaceId } = await workspace();
    await column(workspaceId, null, 1);
    await expect(column(workspaceId, null, 1)).rejects.toThrow(/UNIQUE/);
  });

  test('完了でない列は名前が要る', async () => {
    const { workspaceId } = await workspace();
    await expect(column(workspaceId, null, 0)).rejects.toThrow(/CHECK/);
  });
});

describe('tasks', () => {
  type TaskColumns = {
    isImported?: number;
    tray?: string;
    linkUrl?: string | null;
    createdBy?: string | null;
    storyId?: string | null;
    sprintId?: string | null;
    columnId?: string | null;
  };

  async function setup() {
    const ws = await workspace();
    const columnId = id();
    await run(
      `INSERT INTO board_columns (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, '出発前', 'a0', ?, ?)`,
      columnId,
      ws.workspaceId,
      AT,
      AT,
    );
    const sprintId = id();
    await run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, '2026-10-13', '2026-10-26', 'active', ?, ?)`,
      sprintId,
      ws.workspaceId,
      AT,
      AT,
    );
    const storyId = id();
    await run(
      `INSERT INTO stories (id, workspace_id, title, created_by, position, created_at, updated_at) VALUES (?, ?, 'ストーリー', ?, 'a0', ?, ?)`,
      storyId,
      ws.workspaceId,
      ws.userId,
      AT,
      AT,
    );
    const task = (columns: TaskColumns = {}) =>
      run(
        `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, link_url, story_id, sprint_id, column_id, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'タスク', ?, ?, ?, ?, 'a0', ?, ?, ?)`,
        id(),
        ws.workspaceId,
        columns.isImported ?? 0,
        columns.tray ?? 'backlog',
        columns.linkUrl ?? null,
        columns.storyId ?? null,
        columns.sprintId ?? null,
        columns.columnId ?? null,
        columns.createdBy === undefined ? ws.userId : columns.createdBy,
        AT,
        AT,
      );
    return { ...ws, columnId, sprintId, storyId, task };
  }

  test('手で作ったタスクと取り込んだタスクの決まった形は入る', async () => {
    const { task, sprintId, columnId, storyId } = await setup();
    await expect(task({ sprintId, columnId, storyId, linkUrl: 'https://example.com/' })).resolves.toBeTruthy();
    await expect(task({ isImported: 1, tray: 'inbox', createdBy: null })).resolves.toBeTruthy();
  });

  test.each(['javascript:alert(1)', 'ftp://example.com/', 'example.com'])(
    'http と https 以外のリンク（%s）は当たる',
    async (linkUrl) => {
      const { task } = await setup();
      await expect(task({ linkUrl })).rejects.toThrow(/CHECK/);
    },
  );

  test('手で作ったタスクはバックログにしか置けない', async () => {
    const { task } = await setup();
    await expect(task({ tray: 'inbox' })).rejects.toThrow(/CHECK/);
  });

  test('取り込んだタスクはリンクを持たない', async () => {
    const { task } = await setup();
    await expect(task({ isImported: 1, linkUrl: 'https://example.com/', createdBy: null })).rejects.toThrow(/CHECK/);
  });

  test('手で作ったタスクは起票した人が要る', async () => {
    const { task } = await setup();
    await expect(task({ createdBy: null })).rejects.toThrow(/CHECK/);
  });

  test.each([
    ['スプリント', 'sprint'],
    ['親', 'story'],
  ] as const)('受信箱のタスクは%sを持たない', async (_, kind) => {
    const { task, sprintId, columnId, storyId } = await setup();
    const columns = kind === 'sprint' ? { sprintId, columnId } : { storyId };
    await expect(task({ isImported: 1, tray: 'inbox', createdBy: null, ...columns })).rejects.toThrow(/CHECK/);
  });

  test('スプリントに入っていれば列を持ち、列を持てばスプリントに入っている', async () => {
    const { task, sprintId, columnId } = await setup();
    await expect(task({ sprintId })).rejects.toThrow(/CHECK/);
    await expect(task({ columnId })).rejects.toThrow(/CHECK/);
  });
});

describe('sprints', () => {
  async function sprint(workspaceId: string, startOn: string, endOn: string, status = 'planned') {
    return run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id(),
      workspaceId,
      startOn,
      endOn,
      status,
      AT,
      AT,
    );
  }

  test('進行中のスプリントはワークスペースに1つ', async () => {
    const { workspaceId } = await workspace();
    await sprint(workspaceId, '2026-10-13', '2026-10-26', 'active');
    await expect(sprint(workspaceId, '2026-10-27', '2026-11-09', 'active')).rejects.toThrow(/UNIQUE/);
  });

  test.each([
    ['2026-10-13', '2026-10-13'],
    ['2026-10-01', '2026-10-28'],
  ])('%s〜%s は長さの範囲に入る', async (startOn, endOn) => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, startOn, endOn)).resolves.toBeTruthy();
  });

  test.each([
    ['2026-10-01', '2026-10-29'],
    ['2026-10-13', '2026-10-12'],
  ])('%s〜%s は長さの CHECK に当たる', async (startOn, endOn) => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, startOn, endOn)).rejects.toThrow(/CHECK/);
  });

  test('日付の形でなければ当たる', async () => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, '2026/10/13', '2026-10-26')).rejects.toThrow(/CHECK/);
  });
});

// date() は形の崩れた値に NULL を返すので、= で比べると CHECK が NULL になって通ってしまう。IS で比べている
describe('月の形', () => {
  test.each([
    ['2026-10', true],
    ['2026-13', false],
    ['2026-1', false],
    ['202610', false],
  ])('%s', async (month, ok) => {
    const { workspaceId } = await workspace();
    const insert = run(
      `INSERT INTO workspace_point_rates (workspace_id, effective_month, hours_per_point, created_at) VALUES (?, ?, 4, ?)`,
      workspaceId,
      month,
      AT,
    );
    await (ok ? expect(insert).resolves.toBeTruthy() : expect(insert).rejects.toThrow(/CHECK/));
  });
});

describe('organization_holidays', () => {
  async function holiday(orgId: string, userId: string, holidayOn: string | null, name: string | null = null) {
    return run(
      `INSERT INTO organization_holidays (organization_id, holiday_on, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      orgId,
      holidayOn,
      name,
      userId,
      AT,
    );
  }

  test('同じ組織の同じ日付は1行だけ。別の組織なら同じ日付を持てる', async () => {
    const { orgId, userId } = await workspace();
    const other = await workspace();
    await holiday(orgId, userId, '2026-11-03');
    await expect(holiday(orgId, userId, '2026-11-03')).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await expect(holiday(other.orgId, other.userId, '2026-11-03')).resolves.toBeTruthy();
  });

  test.each([['2026/11/03'], ['2026-02-30'], ['2026-11-3'], ['1999-12-31'], ['2100-01-01']])(
    '日付 %s は CHECK に当たる',
    async (holidayOn) => {
      const { orgId, userId } = await workspace();
      await expect(holiday(orgId, userId, holidayOn)).rejects.toThrow(/CHECK/);
    },
  );

  test('2000-01-01 と 2099-12-31 は入る', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, '2000-01-01')).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2099-12-31')).resolves.toBeTruthy();
  });

  test('日付は空にできない', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, null)).rejects.toThrow(/NOT NULL/);
  });

  test('名前は NULL か 1〜40 字。空の文字列は持たない。字数はコードポイントで数える', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, '2026-11-03', null)).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2026-11-06', '')).rejects.toThrow(/CHECK/);
    await expect(holiday(orgId, userId, '2026-11-04', '🎌'.repeat(40))).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2026-11-05', 'あ'.repeat(41))).rejects.toThrow(/CHECK/);
  });
});

describe('comments', () => {
  async function comment(columns: { body: string; deletedAt?: string | null; deletedBy?: 'self' | null }) {
    const { userId, workspaceId } = await workspace();
    const taskId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    return run(
      `INSERT INTO comments (id, workspace_id, task_id, author_user_id, body_md, deleted_at, deleted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id(),
      workspaceId,
      taskId,
      userId,
      columns.body,
      columns.deletedAt ?? null,
      columns.deletedBy === 'self' ? userId : null,
      AT,
    );
  }

  test('本文は 10 万字まで。字数はコードポイントで数える', async () => {
    await expect(comment({ body: '😀'.repeat(100_000) })).resolves.toBeTruthy();
    await expect(comment({ body: 'あ'.repeat(100_001) })).rejects.toThrow(/CHECK/);
  });

  test('消していないコメントの本文は空にできず、消したコメントの本文は空', async () => {
    await expect(comment({ body: '' })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '残った本文', deletedAt: AT, deletedBy: 'self' })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '', deletedAt: AT, deletedBy: 'self' })).resolves.toBeTruthy();
  });

  test('消した日時と消した人は、両方入るか両方空', async () => {
    await expect(comment({ body: '', deletedAt: AT, deletedBy: null })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '本文', deletedAt: null, deletedBy: 'self' })).rejects.toThrow(/CHECK/);
  });
});

describe('attachments', () => {
  const targetColumns = ['task_id', 'story_id', 'epic_id', 'comment_id'] as const;

  async function setup() {
    const org = await createOrganization();
    const uploader = await createUser(org);
    const ws = await createWorkspace(org, uploader.id);
    const epic = await createEpic(org, ws.id, uploader.id);
    const story = await createStory(org, ws.id, uploader.id, { epic_id: epic.id });
    const task = await createTask(org, ws.id, uploader.id, { story_id: story.id });
    const comment = await createComment(org, ws.id, task.id, uploader.id);
    const targets = { task_id: task.id, story_id: story.id, epic_id: epic.id, comment_id: comment.id };

    function attachment(
      columns: Partial<Record<(typeof targetColumns)[number], string | null>> & {
        attached_at?: string | null;
        size_bytes?: number | string;
        object_key?: string | Uint8Array;
        file_name?: string | Uint8Array;
        content_type?: string | Uint8Array;
      } = {},
    ) {
      const attachmentId = id();
      return run(
        `INSERT INTO attachments (id, workspace_id, task_id, story_id, epic_id, comment_id, object_key, file_name, content_type, size_bytes, uploaded_by, attached_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attachmentId,
        ws.id,
        columns.task_id ?? null,
        columns.story_id ?? null,
        columns.epic_id ?? null,
        columns.comment_id ?? null,
        columns.object_key ?? `${org.id}/${ws.id}/${attachmentId}`,
        columns.file_name ?? '手順.txt',
        columns.content_type ?? 'text/plain',
        columns.size_bytes ?? 1,
        uploader.id,
        columns.attached_at ?? null,
        AT,
      );
    }
    return { attachment, targets };
  }

  test.each(Array.from({ length: 16 }, (_, mask) => mask))(
    '付く先の組み合わせ %i は、多くても1つのときだけ保存できる',
    async (mask) => {
      const { attachment, targets } = await setup();
      const selected = targetColumns.filter((_, index) => mask & (1 << index));
      const columns = Object.fromEntries(selected.map((column) => [column, targets[column]]));
      const result = attachment({ ...columns, attached_at: selected.length ? AT : null });
      await (selected.length <= 1 ? expect(result).resolves.toBeTruthy() : expect(result).rejects.toThrow(/CHECK/));
    },
  );

  test.each(targetColumns)('%s があるとき attached_at を空にできない', async (column) => {
    const { attachment, targets } = await setup();
    await expect(attachment({ [column]: targets[column], attached_at: null })).rejects.toThrow(/CHECK/);
  });

  test('付く先のない行に attached_at を入れられない', async () => {
    const { attachment } = await setup();
    await expect(attachment({ attached_at: AT })).rejects.toThrow(/CHECK/);
  });

  test.each([1, 52428800])('size_bytes の境界 %i は保存できる', async (size_bytes) => {
    const { attachment } = await setup();
    await expect(attachment({ size_bytes })).resolves.toBeTruthy();
  });

  test.each([-1, 0, 52428801])('size_bytes の範囲外 %i は保存できない', async (size_bytes) => {
    const { attachment } = await setup();
    await expect(attachment({ size_bytes })).rejects.toThrow(/CHECK/);
  });

  // INTEGER の列は整数に直せない値をそのまま REAL か TEXT で持つので、型も CHECK で断る
  test.each([1.5, '1.5'])('size_bytes の整数でない値 %s は保存できない', async (size_bytes) => {
    const { attachment } = await setup();
    await expect(attachment({ size_bytes })).rejects.toThrow(/CHECK/);
  });

  test.each(['a', 'あ'.repeat(255)])('file_name は 1〜255 字なら保存できる（%#）', async (file_name) => {
    const { attachment } = await setup();
    await expect(attachment({ file_name })).resolves.toBeTruthy();
  });

  test.each(['', 'あ'.repeat(256)])('file_name は空と 256 字以上を保存できない（%#）', async (file_name) => {
    const { attachment } = await setup();
    await expect(attachment({ file_name })).rejects.toThrow(/CHECK/);
  });

  test('content_type と object_key は空文字を保存できない', async () => {
    const { attachment } = await setup();
    await expect(attachment({ content_type: '' })).rejects.toThrow(/CHECK/);
    await expect(attachment({ object_key: '' })).rejects.toThrow(/CHECK/);
  });

  // BLOB で渡すと length がバイト数を数え、空文字の比較もすり抜けるので、TEXT の型も CHECK で断る
  test.each(['file_name', 'content_type', 'object_key'] as const)('%s は BLOB で保存できない', async (column) => {
    const { attachment } = await setup();
    await expect(attachment({ [column]: new TextEncoder().encode('手順.txt') })).rejects.toThrow(/CHECK/);
  });

  test.each(['workspace_id', 'uploaded_by'])('外部キーの検査の %s は索引で引く', async (column) => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE ${column} = ?`)
      .bind(id())
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join('\n')).toContain(`USING INDEX attachments_${column}`);
  });

  test('object_key は、別の ID の添付でも重ねられない', async () => {
    const { attachment } = await setup();
    const object_key = `organization/workspace/${id()}`;
    await expect(attachment({ object_key })).resolves.toBeTruthy();
    await expect(attachment({ object_key })).rejects.toThrow(/UNIQUE/);
    await expect(attachment()).resolves.toBeTruthy();
  });

  test.each(targetColumns)('%s ごとの一覧は索引で引く', async (column) => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE ${column} = ?`)
      .bind(id())
      .all<{ detail: string }>();
    expect(results.map((row) => row.detail).join('\n')).toContain(`USING INDEX attachments_${column}`);
  });

  // docs/data-model.md の「付く先のない行を消す定期処理」の文の内側の SELECT。組織のワークスペースで絞るので、
  // 部分索引の先頭は workspace_id にする（created_at だけだと workspace_id の索引が選ばれ、付いた行までなめる）
  test('付く先のない期限切れの行は、組織のワークスペースごとに部分索引で引く', async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ?) AND attached_at IS NULL AND created_at < ? LIMIT 50`,
    )
      .bind(id(), AT)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join('\n');
    expect(plan).toContain('USING INDEX attachments_workspace_created_at_unattached');
    expect(plan).not.toMatch(/INDEX attachments_workspace_id\b/);
  });
});

describe('task_field_values', () => {
  async function setup() {
    const { userId, workspaceId } = await workspace();
    const taskId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    const fieldId = id();
    await run(
      `INSERT INTO detail_fields (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, '受け入れ基準', 'a0', ?, ?)`,
      fieldId,
      workspaceId,
      AT,
      AT,
    );
    return { userId, taskId, fieldId };
  }

  function value(columns: { taskId: string; fieldId: string; userId: string; body?: string }) {
    return run(
      `INSERT INTO task_field_values (task_id, field_id, value_md, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`,
      columns.taskId,
      columns.fieldId,
      columns.body ?? '- 確かめる手順がある',
      columns.userId,
      AT,
    );
  }

  test('1 タスクの 1 つの欄に値は 1 行。別の欄は書ける', async () => {
    const { userId, taskId, fieldId } = await setup();
    await expect(value({ taskId, fieldId, userId })).resolves.toBeTruthy();
    await expect(value({ taskId, fieldId, userId })).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  test('値は空にできず（空は行を消す）、10 万字まで。字数はコードポイントで数える', async () => {
    const { userId, taskId, fieldId } = await setup();
    await expect(value({ taskId, fieldId, userId, body: '' })).rejects.toThrow(/CHECK/);
    await expect(value({ taskId, fieldId, userId, body: 'あ'.repeat(100_001) })).rejects.toThrow(/CHECK/);
    await expect(value({ taskId, fieldId, userId, body: '😀'.repeat(100_000) })).resolves.toBeTruthy();
  });

  test('無いタスク、無い欄、無い人を指せない', async () => {
    const { userId, taskId, fieldId } = await setup();
    await expect(value({ taskId: id(), fieldId, userId })).rejects.toThrow(/FOREIGN KEY/);
    await expect(value({ taskId, fieldId: id(), userId })).rejects.toThrow(/FOREIGN KEY/);
    await expect(value({ taskId, fieldId, userId: id() })).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('sprint_entries', () => {
  async function taskAndSprint() {
    const { userId, workspaceId } = await workspace();
    const taskId = id();
    const sprintId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    await run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, '2026-11-02', '2026-11-15', 'planned', ?, ?)`,
      sprintId,
      workspaceId,
      AT,
      AT,
    );
    const entry = (endedAt: string | null, outcome: string | null) =>
      run(
        `INSERT INTO sprint_entries (id, workspace_id, sprint_id, task_id, added_at, added_by, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id(),
        workspaceId,
        sprintId,
        taskId,
        AT,
        userId,
        endedAt,
        outcome,
      );
    return { entry };
  }

  test('1つのタスクが入っている行（ended_at が空）は1つ。出た行はいくつでも持てる', async () => {
    const { entry } = await taskAndSprint();
    await expect(entry(AT, 'removed')).resolves.toBeTruthy();
    await expect(entry(AT, 'removed')).resolves.toBeTruthy();
    await expect(entry(null, null)).resolves.toBeTruthy();
    await expect(entry(null, null)).rejects.toThrow(/UNIQUE/);
  });

  test('出た日時と出方は、両方入るか両方空。出方は completed、carried_over、removed のどれか', async () => {
    const { entry } = await taskAndSprint();
    await expect(entry(AT, null)).rejects.toThrow(/CHECK/);
    await expect(entry(null, 'removed')).rejects.toThrow(/CHECK/);
    await expect(entry(AT, 'deleted')).rejects.toThrow(/CHECK/);
    await expect(entry(AT, 'completed')).resolves.toBeTruthy();
    await expect(entry(AT, 'carried_over')).resolves.toBeTruthy();
  });
});

describe('epic_party_members', () => {
  async function epicAndUsers() {
    const { orgId, userId, workspaceId } = await workspace();
    const otherUserId = await user(orgId);
    const epicId = id();
    await run(
      `INSERT INTO epics (id, workspace_id, title, reward_tier, requester_user_id, created_by, position, created_at, updated_at) VALUES (?, ?, 'エピック', 'medium', ?, ?, 'a0', ?, ?)`,
      epicId,
      workspaceId,
      userId,
      userId,
      AT,
      AT,
    );
    const join = (user: string, joinedVia: string) =>
      run(
        `INSERT INTO epic_party_members (epic_id, user_id, joined_via, added_by, joined_at) VALUES (?, ?, ?, ?, ?)`,
        epicId,
        user,
        joinedVia,
        userId,
        AT,
      );
    return { userId, otherUserId, join };
  }

  test('同じエピックに同じ人は1回だけ入れる', async () => {
    const { userId, otherUserId, join } = await epicAndUsers();
    await expect(join(userId, 'self')).resolves.toBeTruthy();
    await expect(join(otherUserId, 'assigned')).resolves.toBeTruthy();
    await expect(join(userId, 'self')).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  test('入り方は self、assigned、task_assignee のどれか', async () => {
    const { userId, otherUserId, join } = await epicAndUsers();
    await expect(join(userId, 'task_assignee')).resolves.toBeTruthy();
    await expect(join(otherUserId, 'invited')).rejects.toThrow(/CHECK/);
  });
});

describe('thanks', () => {
  async function taskAndUsers() {
    const { orgId, userId, workspaceId } = await workspace();
    const recipientId = await user(orgId);
    const taskId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    const thank = (sender: string, recipient: string) =>
      run(
        `INSERT INTO thanks (id, workspace_id, task_id, sender_user_id, recipient_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id(),
        workspaceId,
        taskId,
        sender,
        recipient,
        AT,
      );
    return { userId, recipientId, thank };
  }

  test('自分には送れない', async () => {
    const { userId, thank } = await taskAndUsers();
    await expect(thank(userId, userId)).rejects.toThrow(/CHECK/);
  });

  test('同じタスクで同じ相手への感謝は1回。相手が違えば別に送れる', async () => {
    const { userId, recipientId, thank } = await taskAndUsers();
    await expect(thank(userId, recipientId)).resolves.toBeTruthy();
    await expect(thank(userId, recipientId)).rejects.toThrow(/UNIQUE/);
    await expect(thank(recipientId, userId)).resolves.toBeTruthy();
  });
});

describe('xp_grants.dedupe_key', () => {
  test('同じキーの付与は2つ作れない', async () => {
    const { userId, workspaceId } = await workspace();
    const grant = () =>
      run(
        `INSERT INTO xp_grants (id, workspace_id, user_id, action, amount, dedupe_key, confirmed_at) VALUES (?, ?, ?, 'task_completed', 10, ?, ?)`,
        id(),
        workspaceId,
        userId,
        'task_completed:019a0000-0000-7000-8000-000000000901',
        AT,
      );
    await grant();
    await expect(grant()).rejects.toThrow(/UNIQUE/);
  });
});

// organizations.kind（'team' | 'personal'）と、自分用の組織が1アカウントに1つだけの部分 UNIQUE 索引（#733）
describe('organizations.kind', () => {
  async function account(): Promise<string> {
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    return accountId;
  }

  async function insertOrganization(options: { kind?: string; createdBy?: string | null; slug?: string }) {
    const slug = options.slug ?? `org-${id().slice(0, 8)}`;
    const columns = ['id', 'slug', 'name', 'created_by_operator', 'created_by_account_id', 'created_at', 'updated_at'];
    const values: unknown[] = [id(), slug, '組織', 'self-service', options.createdBy ?? null, AT, AT];
    if (options.kind !== undefined) {
      columns.push('kind');
      values.push(options.kind);
    }
    await run(
      `INSERT INTO organizations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...values,
    );
    return slug;
  }

  async function kindOf(slug: string): Promise<unknown> {
    const row = await env.DB.prepare(`SELECT kind FROM organizations WHERE slug = ?`)
      .bind(slug)
      .first<{ kind: string }>();
    return row?.kind;
  }

  test('kind を省くと team になる', async () => {
    expect(await kindOf(await insertOrganization({}))).toBe('team');
  });

  test.each(['team', 'personal'])('%s は通る', async (kind) => {
    expect(await kindOf(await insertOrganization({ kind }))).toBe(kind);
  });

  test.each(['', 'Team', 'PERSONAL', 'personal ', 'solo', 'enterprise'])('%j は CHECK に当たる', async (kind) => {
    await expect(insertOrganization({ kind })).rejects.toThrow(/CHECK/);
  });

  test('NULL は NOT NULL に当たる', async () => {
    await expect(
      run(
        `INSERT INTO organizations (id, slug, name, kind, created_by_operator, created_at, updated_at) VALUES (?, ?, '組織', NULL, 'self-service', ?, ?)`,
        id(),
        `org-${id().slice(0, 8)}`,
        AT,
        AT,
      ),
    ).rejects.toThrow(/NOT NULL/);
  });

  test('列の定義は TEXT NOT NULL で、既定は team', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('organizations') WHERE name = 'kind'`,
    ).all<{
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(results[0]!.dflt_value).toContain('team');
  });

  test('同じ作成者の自分用の2つ目は UNIQUE に当たる', async () => {
    const owner = await account();
    await insertOrganization({ kind: 'personal', createdBy: owner });
    await expect(insertOrganization({ kind: 'personal', createdBy: owner })).rejects.toThrow(/UNIQUE/);
  });

  test('作成者が違えば、自分用は何人分でも入る', async () => {
    await insertOrganization({ kind: 'personal', createdBy: await account() });
    await expect(insertOrganization({ kind: 'personal', createdBy: await account() })).resolves.toBeTypeOf('string');
  });

  test('同じ作成者でも、team は何件でも入る（お試しの上限は処理が守る）', async () => {
    const owner = await account();
    await insertOrganization({ kind: 'team', createdBy: owner });
    await insertOrganization({ kind: 'team', createdBy: owner });
    await expect(insertOrganization({ createdBy: owner })).resolves.toBeTypeOf('string');
  });

  test('同じ作成者が自分用と team を1つずつ持てる（順序によらない）', async () => {
    const first = await account();
    await insertOrganization({ kind: 'personal', createdBy: first });
    await expect(insertOrganization({ kind: 'team', createdBy: first })).resolves.toBeTypeOf('string');
    const second = await account();
    await insertOrganization({ kind: 'team', createdBy: second });
    await expect(insertOrganization({ kind: 'personal', createdBy: second })).resolves.toBeTypeOf('string');
  });

  test('既存の行（kind を省いた行）は team で、同じ作成者の自分用を妨げない', async () => {
    const owner = await account();
    await insertOrganization({ createdBy: owner });
    await expect(insertOrganization({ kind: 'personal', createdBy: owner })).resolves.toBeTypeOf('string');
  });

  test('自分用の行を team に直すと、同じ作成者の自分用をもう1つ作れる（索引は kind が personal の行だけ）', async () => {
    const owner = await account();
    const slug = await insertOrganization({ kind: 'personal', createdBy: owner });
    await run(`UPDATE organizations SET kind = 'team' WHERE slug = ?`, slug);
    await expect(insertOrganization({ kind: 'personal', createdBy: owner })).resolves.toBeTypeOf('string');
  });

  test('team の行を personal に直すとき、同じ作成者の自分用が既にあれば UNIQUE に当たる', async () => {
    const owner = await account();
    await insertOrganization({ kind: 'personal', createdBy: owner });
    const slug = await insertOrganization({ kind: 'team', createdBy: owner });
    await expect(run(`UPDATE organizations SET kind = 'personal' WHERE slug = ?`, slug)).rejects.toThrow(/UNIQUE/);
  });

  test('部分索引は kind が personal の行だけを対象にする', async () => {
    const { results } = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'organizations' AND sql LIKE '%created_by_account_id%' AND sql LIKE '%UNIQUE%'`,
    ).all<{ sql: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.sql).toMatch(/WHERE\s+kind\s*=\s*'personal'/i);
  });
});

// 新しい列を省く旧版の INSERT は引き続き通し、書く場合だけ日時の形を守らせる。
describe('セッションの API トークンの確認日時', () => {
  async function insertSeen(value: unknown) {
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    return run(
      `INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at, api_token_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      accountId,
      AT,
      AT,
      AT,
      value,
    );
  }

  test.each([null, AT])('NULL と UTC のミリ秒日時 %s を持てる', async (value) => {
    await expect(insertSeen(value)).resolves.toBeDefined();
  });

  test.each([
    'not-a-date',
    '2026-10-20',
    '2026-10-20T00:00:00Z',
    '2026-10-20T00:00:00.000+09:00',
    '2026-13-20T00:00:00.000Z',
  ])('正規の UTC 日時でない %s は拒む', async (value) => {
    await expect(insertSeen(value)).rejects.toThrow(/CHECK/);
  });
});

// 旧コードが列を省略しても書ける。日時の暦としての妥当性は認証時にも検査する。
describe('組織ごとの認証日時の nullable CHECK', () => {
  test('ユーザーの cutoff は NULL と UTC 日時を許し、日時でない値を拒む', async () => {
    const orgId = await organization();
    const userId = await user(orgId);
    for (const value of [AT, null]) {
      await expect(
        run('UPDATE users SET credentials_not_before = ? WHERE id = ?', value, userId),
      ).resolves.toBeDefined();
    }
    for (const value of ['', 'not-a-date', '2026-10-20T00:00:00+09:00']) {
      await expect(run('UPDATE users SET credentials_not_before = ? WHERE id = ?', value, userId)).rejects.toThrow();
    }
  });

  test('トークンの発行元日時は NULL と UTC 日時を許し、日時でない値を拒む', async () => {
    const accountId = id();
    const hash = id().replaceAll('-', '').repeat(2);
    await run('INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)', accountId, AT, AT);
    await run(
      "INSERT INTO api_tokens (token_hash, account_id, name, scope, created_at, expires_at) VALUES (?, ?, '認証', 'read', ?, ?)",
      hash,
      accountId,
      AT,
      CLAIM_EXPIRES_AT,
    );
    for (const value of [AT, null]) {
      await expect(
        run('UPDATE api_tokens SET authenticated_at = ? WHERE token_hash = ?', value, hash),
      ).resolves.toBeDefined();
    }
    for (const value of ['', 'not-a-date', '2026-10-20T00:00:00+09:00']) {
      await expect(
        run('UPDATE api_tokens SET authenticated_at = ? WHERE token_hash = ?', value, hash),
      ).rejects.toThrow();
    }
  });
});

describe('connections と task_sources', () => {
  async function setup() {
    const { userId, workspaceId } = await workspace();
    const connectionId = id();
    await insertConnection({ connectionId, workspaceId, userId });
    const taskId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 1, 'inbox', '取り込んだタスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    return { userId, workspaceId, connectionId, taskId };
  }

  function insertConnection(c: {
    connectionId: string;
    workspaceId: string;
    userId: string;
    status?: string;
    stoppedReason?: string | null;
    scopeMode?: string;
  }) {
    return run(
      `INSERT INTO connections (id, workspace_id, owner_user_id, provider, name, status, stopped_reason, scope_mode, created_at, updated_at) VALUES (?, ?, ?, 'github', '接続', ?, ?, ?, ?, ?)`,
      c.connectionId,
      c.workspaceId,
      c.userId,
      c.status ?? 'active',
      c.stoppedReason ?? null,
      c.scopeMode ?? 'include',
      AT,
      AT,
    );
  }

  function insertSource(s: {
    taskId: string;
    workspaceId: string;
    connectionId: string;
    kind?: string;
    sourceId?: string;
    reviewer?: string;
  }) {
    return run(
      `INSERT INTO task_sources (task_id, workspace_id, connection_id, provider, source_kind, source_id, reviewer_source_id, source_key, source_url, source_container_id, source_container_name, source_status, source_updated_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, 'github', ?, ?, ?, 'a/b#1', 'https://github.com/a/b/issues/1', '1', 'a/b', 'open', ?, ?, ?, ?)`,
      s.taskId,
      s.workspaceId,
      s.connectionId,
      s.kind ?? 'issue',
      s.sourceId ?? 'node-1',
      s.reviewer ?? '',
      AT,
      AT,
      AT,
      AT,
    );
  }

  test('停止の理由は、停止のときだけ入る。状態と範囲の方式は決まった値だけ', async () => {
    const { userId, workspaceId } = await setup();
    const base = { workspaceId, userId };
    await expect(
      insertConnection({ ...base, connectionId: id(), status: 'stopped', stoppedReason: 'owner' }),
    ).resolves.toBeTruthy();
    await expect(insertConnection({ ...base, connectionId: id(), status: 'stopped' })).rejects.toThrow(/CHECK/);
    await expect(insertConnection({ ...base, connectionId: id(), stoppedReason: 'owner' })).rejects.toThrow(/CHECK/);
    await expect(insertConnection({ ...base, connectionId: id(), status: 'paused' })).rejects.toThrow(/CHECK/);
    await expect(insertConnection({ ...base, connectionId: id(), scopeMode: 'all' })).rejects.toThrow(/CHECK/);
  });

  test('同じ項目は1件。レビュー依頼だけレビュアーごとに分かれる', async () => {
    const { workspaceId, connectionId, taskId, userId } = await setup();
    await expect(insertSource({ taskId, workspaceId, connectionId })).resolves.toBeTruthy();
    const other = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 1, 'inbox', '別のタスク', 'a1', ?, ?, ?)`,
      other,
      workspaceId,
      userId,
      AT,
      AT,
    );
    await expect(insertSource({ taskId: other, workspaceId, connectionId })).rejects.toThrow(/UNIQUE/);
    await expect(
      insertSource({ taskId: other, workspaceId, connectionId, kind: 'review_request', reviewer: 'u1' }),
    ).resolves.toBeTruthy();
    await expect(insertSource({ taskId: id(), workspaceId, connectionId, sourceId: 'node-2' })).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await expect(
      insertSource({ taskId: other, workspaceId, connectionId, kind: 'epic', sourceId: 'node-3' }),
    ).rejects.toThrow(/CHECK/);
  });

  test('停止の理由は6つの値だけ。範囲の方式は include と exclude', async () => {
    const { userId, workspaceId } = await setup();
    const base = { workspaceId, userId, status: 'stopped' };
    for (const reason of ['auth_failed', 'owner', 'leader', 'member_left', 'workspace_closed', 'user_disabled']) {
      await expect(insertConnection({ ...base, connectionId: id(), stoppedReason: reason })).resolves.toBeTruthy();
    }
    await expect(insertConnection({ ...base, connectionId: id(), stoppedReason: 'bogus' })).rejects.toThrow(/CHECK/);
    await expect(
      insertConnection({ workspaceId, userId, connectionId: id(), scopeMode: 'exclude' }),
    ).resolves.toBeTruthy();
  });

  test('JSON の列は JSON だけ。壊れた値は入らない', async () => {
    const { connectionId, taskId } = await setup();
    for (const column of ['settings_json', 'sync_state_json', 'reconcile_state_json']) {
      await expect(run(`UPDATE connections SET ${column} = '{not json' WHERE id = ?`, connectionId)).rejects.toThrow(
        /CHECK/,
      );
    }
    const insertPayload = (json: string) =>
      run(`INSERT INTO task_source_payloads (task_id, payload_json, updated_at) VALUES (?, ?, ?)`, taskId, json, AT);
    await expect(insertPayload('{"a":')).rejects.toThrow(/CHECK/);
    await expect(insertPayload('{"a":1}')).resolves.toBeTruthy();
  });

  test('認証情報の3列は組で入り、削除した接続には残らない', async () => {
    const { connectionId } = await setup();
    await expect(run(`UPDATE connections SET credential_ciphertext = 'x' WHERE id = ?`, connectionId)).rejects.toThrow(
      /CHECK/,
    );
    await run(
      `UPDATE connections SET credential_ciphertext = 'x', credential_key_version = 1, credential_last4 = 'abcd' WHERE id = ?`,
      connectionId,
    );
    await expect(run(`UPDATE connections SET deleted_at = ? WHERE id = ?`, AT, connectionId)).rejects.toThrow(/CHECK/);
    await expect(
      run(
        `UPDATE connections SET deleted_at = ?, credential_ciphertext = NULL, credential_key_version = NULL, credential_last4 = NULL WHERE id = ?`,
        AT,
        connectionId,
      ),
    ).resolves.toBeTruthy();
  });

  test('0/1 の列は 0 と 1 だけ。期限は日付だけ。レビュアーの ID はレビュー依頼のときだけ', async () => {
    const { workspaceId, connectionId, taskId } = await setup();
    await insertSource({ taskId, workspaceId, connectionId });
    await expect(run(`UPDATE connections SET ignore_source_due = 2 WHERE id = ?`, connectionId)).rejects.toThrow(
      /CHECK/,
    );
    await expect(run(`UPDATE task_sources SET is_source_done = 2 WHERE task_id = ?`, taskId)).rejects.toThrow(/CHECK/);
    await expect(
      run(`UPDATE task_sources SET source_due_on = '2026-11-07T15:00:00Z' WHERE task_id = ?`, taskId),
    ).rejects.toThrow(/CHECK/);
    await expect(
      run(`UPDATE task_sources SET source_due_on = '2026-11-07' WHERE task_id = ?`, taskId),
    ).resolves.toBeTruthy();
    await expect(run(`UPDATE task_sources SET reviewer_source_id = 'u9' WHERE task_id = ?`, taskId)).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      run(`UPDATE task_sources SET source_kind = 'review_request' WHERE task_id = ?`, taskId),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO task_source_payloads (task_id, payload_json, updated_at) VALUES (?, '{}', ?)`, taskId, AT);
    await expect(run(`UPDATE task_source_payloads SET is_truncated = 2 WHERE task_id = ?`, taskId)).rejects.toThrow(
      /CHECK/,
    );
  });

  test('一意のキーは、ワークスペース、種類、種別、ID、レビュアーのどれが違っても別の項目', async () => {
    const { userId, workspaceId, connectionId } = await setup();
    const task = async (ws: string) => {
      const taskId = id();
      await run(
        `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 1, 'inbox', 'タスク', 'a0', ?, ?, ?)`,
        taskId,
        ws,
        userId,
        AT,
        AT,
      );
      return taskId;
    };
    const review = { workspaceId, connectionId, kind: 'review_request', sourceId: 'pr-1' };
    await expect(insertSource({ ...review, taskId: await task(workspaceId), reviewer: 'u1' })).resolves.toBeTruthy();
    await expect(insertSource({ ...review, taskId: await task(workspaceId), reviewer: 'u2' })).resolves.toBeTruthy();
    await expect(insertSource({ ...review, taskId: await task(workspaceId), reviewer: 'u1' })).rejects.toThrow(
      /UNIQUE/,
    );
    // 別のワークスペースの同じ項目は別
    const other = await workspace();
    const otherConnection = id();
    await insertConnection({ connectionId: otherConnection, workspaceId: other.workspaceId, userId: other.userId });
    const otherTask = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 1, 'inbox', 'タスク', 'a0', ?, ?, ?)`,
      otherTask,
      other.workspaceId,
      other.userId,
      AT,
      AT,
    );
    await expect(
      insertSource({
        ...review,
        workspaceId: other.workspaceId,
        connectionId: otherConnection,
        taskId: otherTask,
        reviewer: 'u1',
      }),
    ).resolves.toBeTruthy();
    // 取り込み元の種類だけ違う同じ ID は別
    const sameId = await task(workspaceId);
    await run(
      `INSERT INTO task_sources (task_id, workspace_id, connection_id, provider, source_kind, source_id, source_key, source_url, source_container_id, source_container_name, source_status, source_updated_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, 'backlog', 'issue', 'x', 'K-1', 'https://example.test/K-1', '1', 'K', 'open', ?, ?, ?, ?)`,
      sameId,
      workspaceId,
      connectionId,
      AT,
      AT,
      AT,
      AT,
    );
    const sameId2 = await task(workspaceId);
    await expect(insertSource({ taskId: sameId2, workspaceId, connectionId, sourceId: 'x' })).resolves.toBeTruthy();
  });

  test('範囲と状態の対応は、同じ組を2件持てない。無い列と無い接続は指せない', async () => {
    const { workspaceId, connectionId } = await setup();
    const scope = (cid: string) =>
      run(
        `INSERT INTO connection_scopes (connection_id, scope_kind, source_id, source_name) VALUES (?, 'github_repo', '1', 'a/b')`,
        cid,
      );
    await expect(scope(connectionId)).resolves.toBeTruthy();
    await expect(scope(connectionId)).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(scope(id())).rejects.toThrow(/FOREIGN KEY/);
    const columnId = id();
    await run(
      `INSERT INTO board_columns (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, '進行中', 'a0', ?, ?)`,
      columnId,
      workspaceId,
      AT,
      AT,
    );
    const mapping = (cid: string, col: string) =>
      run(
        `INSERT INTO connection_status_mappings (connection_id, source_status, column_id) VALUES (?, 'open', ?)`,
        cid,
        col,
      );
    await expect(mapping(connectionId, columnId)).resolves.toBeTruthy();
    await expect(mapping(connectionId, columnId)).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      run(
        `INSERT INTO connection_status_mappings (connection_id, source_status, column_id) VALUES (?, 'closed', ?)`,
        connectionId,
        id(),
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('アカウントのプロフィール', () => {
  async function profileAccount() {
    const accountId = id();
    await run('INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)', accountId, AT, AT);
    return accountId;
  }
  const insertProfile = (accountId: string, name = 'ユイ', title = '', at = AT) =>
    run(
      'INSERT INTO account_profiles (account_id, name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      accountId,
      name,
      title,
      at,
      at,
    );

  test('1アカウントに1行で、名前と肩書きは100コードポイントまで', async () => {
    const accountId = await profileAccount();
    await insertProfile(accountId, '🌸'.repeat(100), '🌸'.repeat(100));
    await expect(insertProfile(accountId)).rejects.toThrow(/UNIQUE/);
  });
  test.each([
    ['', ''],
    ['名'.repeat(101), ''],
    ['ユイ', '名'.repeat(101)],
    ['ユ\u0000イ', ''],
    ['ユイ', '\u0000'],
  ])('名前と肩書きの長さやNULをDBでも断る（%j）', async (name, title) => {
    await expect(insertProfile(await profileAccount(), name, title)).rejects.toThrow(/CHECK/);
  });
  test('日時はUTCミリ秒形式だけを受け付ける', async () => {
    await expect(insertProfile(await profileAccount(), 'ユイ', '', '2026-11-08')).rejects.toThrow(/CHECK/);
  });
  test('存在しないアカウントには書けず、プロフィールを先に消さなければアカウントを消せない', async () => {
    await expect(insertProfile(id())).rejects.toThrow(/FOREIGN KEY/);
    const accountId = await profileAccount();
    await insertProfile(accountId);
    await expect(run('DELETE FROM accounts WHERE id = ?', accountId)).rejects.toThrow(/FOREIGN KEY/);
    await run('DELETE FROM account_profiles WHERE account_id = ?', accountId);
    await run('DELETE FROM accounts WHERE id = ?', accountId);
    const row = await env.DB.prepare('SELECT account_id FROM account_profiles WHERE account_id = ?')
      .bind(accountId)
      .first();
    expect(row).toBeNull();
  });
});

// お気に入りの対象、重複、参照と日時の制約。
async function favoriteSchemaFixture() {
  const organization = await createOrganization();
  const user = await createUser(organization);
  const workspace = await createWorkspace(organization, user.id);
  const task = await createTask(organization, workspace.id, user.id);
  const story = await createStory(organization, workspace.id, user.id);
  const epic = await createEpic(organization, workspace.id, user.id);
  return { organization, user, workspace, task, story, epic };
}

function insertFavoriteSchema(
  userId: string,
  workspaceId: string | null,
  taskId: string | null,
  storyId: string | null = null,
  epicId: string | null = null,
  wikiId: string | null = null,
  at = AT,
) {
  return env.DB.prepare(
    'INSERT INTO favorites (id,user_id,workspace_id,task_id,story_id,epic_id,wiki_page_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(uuidv7(), userId, workspaceId, taskId, storyId, epicId, wikiId, at)
    .run();
}

test('お気に入りの対象はちょうど1つで、タスク・ストーリー・エピックにはワークスペースが要る', async () => {
  const f = await favoriteSchemaFixture();
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, f.task.id)).resolves.toMatchObject({ success: true });
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, null)).rejects.toThrow(/CHECK/);
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, f.task.id, f.story.id)).rejects.toThrow(/CHECK/);
  await expect(insertFavoriteSchema(f.user.id, null, f.task.id)).rejects.toThrow(/CHECK/);
});

test('対象ごとに本人との組が一意で、別の人は同じ対象を持てる', async () => {
  const f = await favoriteSchemaFixture();
  const other = await createUser(f.organization);
  for (const [task, story, epic] of [
    [f.task.id, null, null],
    [null, f.story.id, null],
    [null, null, f.epic.id],
  ]) {
    await insertFavoriteSchema(f.user.id, f.workspace.id, task!, story!, epic!);
    await insertFavoriteSchema(other.id, f.workspace.id, task!, story!, epic!);
    await expect(insertFavoriteSchema(f.user.id, f.workspace.id, task!, story!, epic!)).rejects.toThrow(/UNIQUE/);
  }
});

test('外部キーと作成日時の形を検査する', async () => {
  const f = await favoriteSchemaFixture();
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, uuidv7())).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, null, uuidv7())).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, null, null, uuidv7())).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(f.user.id, null, null, null, null, uuidv7())).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(uuidv7(), f.workspace.id, f.task.id)).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(f.user.id, uuidv7(), f.task.id)).rejects.toThrow(/FOREIGN KEY/);
  await expect(insertFavoriteSchema(f.user.id, f.workspace.id, f.task.id, null, null, null, 'invalid')).rejects.toThrow(
    /CHECK/,
  );
});

describe('delegatees と tasks.delegatee_id', () => {
  test.each(['', 'あ'.repeat(51)])('空と50字を超える名前を断る（%j）', async (name) => {
    const org = await createOrganization();
    await expect(createDelegatee(org, { name })).rejects.toThrow(/CHECK constraint failed/);
  });

  test('名前の両端は1字と50字。同じ名前はSQLの一意では制約しない', async () => {
    const org = await createOrganization();
    await createDelegatee(org, { name: 'あ' });
    await createDelegatee(org, { name: 'あ'.repeat(50) });
    await createDelegatee(org, { name: 'あ' });
  });

  test('依頼先は存在する組織だけを指す', async () => {
    const org = await createOrganization();
    await expect(createDelegatee(org, { organization_id: id() })).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  test('タスクは依頼先なしで作れ、存在しない依頼先は指せない', async () => {
    const org = await createOrganization();
    const author = await createUser(org);
    const ws = await createWorkspace(org, author.id);
    expect((await createTask(org, ws.id, author.id)).delegatee_id).toBeNull();
    await expect(createTask(org, ws.id, author.id, { delegatee_id: id() })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test('依頼先を参照したタスクがあれば、名簿の物理削除を断る', async () => {
    const org = await createOrganization();
    const author = await createUser(org);
    const ws = await createWorkspace(org, author.id);
    const delegatee = await createDelegatee(org);
    await createTask(org, ws.id, author.id, { delegatee_id: delegatee.id });
    await expect(run('DELETE FROM delegatees WHERE id = ?', delegatee.id)).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test('未完了の依頼タスクを部分索引で引く', async () => {
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE delegatee_id = ? AND completed_at IS NULL',
    )
      .bind(id())
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('USING INDEX tasks_delegatee_completed'))).toBe(true);
  });

  test('名簿の一覧は組織と名前の部分索引で引く', async () => {
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id, name FROM delegatees WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name',
    )
      .bind(id())
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('USING INDEX delegatees_organization_name'))).toBe(true);
  });
});
