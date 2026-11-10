import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateKeyBetween } from 'fractional-indexing';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/lib/legal/versions.ts';
import { SEED_PASSWORD_LOGINS } from '../seed/passwords.ts';
import { SEED_OPERATOR_LOGIN_ID, SEED_SESSIONS } from '../seed/sessions.ts';
import { seedSql, seedTables, sessionInserts, tokenHash } from './seed.ts';

// 今の反復回数（src/server/auth/password-hash.ts の PASSWORD_HASH_ITERATIONS）。そのファイルは Workers の型（crypto.subtle.timingSafeEqual）
// を使い、scripts/ の型の検査に入れられないので、値を写す
const PASSWORD_HASH_ITERATIONS = 100_000;

const sessions = Object.values(SEED_SESSIONS);

describe('seed のトークン', () => {
  test('ログインが作るトークンと同じ base64url の43文字で、重ならない', () => {
    for (const s of sessions) assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new Set(sessions.map((s) => s.token)).size, sessions.length);
  });

  test('ハッシュは SHA-256 の小文字の16進', () => {
    assert.equal(tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('運用者の ID は .dev.vars.example の OPERATOR_LOGIN_IDS と同じ', () => {
    const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    assert.match(example, new RegExp(`^OPERATOR_LOGIN_IDS=${SEED_OPERATOR_LOGIN_ID}$`, 'm'));
  });
});

// data.sql の password_credentials の行（1行1人）から、ログインの ID とメールアドレスとハッシュを取る
function seedPasswordRows(): { subject: string; email: string; hash: string }[] {
  const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
  const row = /^\s*\('([^']+)', '([^']+)', '(pbkdf2-sha256\$[^']+)'/gm;
  return [...data.matchAll(row)].map(([, subject, email, hash]) => ({ subject: subject!, email: email!, hash: hash! }));
}

describe('seed のパスワード', () => {
  const logins = Object.values(SEED_PASSWORD_LOGINS);

  test('パスワードは12文字以上で、メールアドレスは架空の example.test の、そろえた形', () => {
    for (const login of logins) {
      assert.ok([...login.password].length >= 12, login.email);
      assert.match(login.email, /^[a-z0-9.-]+@example\.test$/);
    }
    assert.equal(new Set(logins.map((login) => login.email)).size, logins.length);
  });

  test('data.sql のハッシュは、今の反復回数で、seed/passwords.ts のパスワードから作った値', () => {
    const rows = seedPasswordRows();
    assert.equal(rows.length, logins.length);
    for (const login of logins) {
      const row = rows.find((candidate) => candidate.subject === login.loginSubject);
      assert.ok(row, `${login.email} の行が無い`);
      assert.equal(row.email, login.email);
      const [scheme, iterations, salt, key] = row.hash.split('$') as [string, string, string, string];
      assert.equal(scheme, 'pbkdf2-sha256');
      assert.equal(Number(iterations), PASSWORD_HASH_ITERATIONS);
      const derived = pbkdf2Sync(
        login.password.normalize('NFC'),
        Buffer.from(salt, 'base64url'),
        Number(iterations),
        32,
        'sha256',
      );
      assert.equal(derived.toString('base64url'), key, `${login.email} のハッシュがパスワードに合わない`);
    }
  });
});

// data.sql の account_consents の行（account_id、terms_version、privacy_version、consented_at の順）
function seedConsentRows(): { accountId: string; terms: string; privacy: string }[] {
  const data = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
  const statements = [...data.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+account_consents\b[^;]*;/gi)].map(
    ([statement]) => statement,
  );
  const row = /\('([^']+)', '([^']+)', '([^']+)', '[^']+'\)/g;
  return statements.flatMap((statement) =>
    [...statement.matchAll(row)].map(([, accountId, terms, privacy]) => ({
      accountId: accountId!,
      terms: terms!,
      privacy: privacy!,
    })),
  );
}

describe('seed の同意', () => {
  test('data.sql の同意の行の版は、今の規約とプライバシーポリシーの版と一致する', () => {
    const rows = seedConsentRows();
    assert.ok(rows.length > 0, 'account_consents の行が無い');
    for (const row of rows) {
      assert.equal(row.terms, TERMS_VERSION, `${row.accountId} の terms_version`);
      assert.equal(row.privacy, PRIVACY_VERSION, `${row.accountId} の privacy_version`);
    }
  });

  test('unconsented 以外のセッションのアカウントは同意済みで、unconsented は同意の行を持たない', () => {
    const consented = new Set(seedConsentRows().map((row) => row.accountId));
    for (const [name, session] of Object.entries(SEED_SESSIONS)) {
      assert.equal(consented.has(session.accountId), name !== 'unconsented', name);
    }
  });
});

// sqlite_master の CREATE TABLE の文から、位置の列（position と *_position）の名前を拾う
function positionColumnNames(sql: string): string[] {
  return [...sql.matchAll(/(?:^|[,(])\s*"?(position|\w+_position)"?\s/gm)].map(([, column]) => column!);
}

describe('positionColumnNames', () => {
  test('CREATE TABLE の列と、ALTER TABLE で足した列（前の列と同じ行の「, 」の後に入る）を拾い、名前の一部だけ合う列は拾わない', () => {
    // SQLite は ALTER TABLE ... ADD COLUMN の列を、保存した文の閉じ括弧の前に「, <列の定義>」で差し込む
    const sql =
      'CREATE TABLE t (\n  id TEXT,\n  position TEXT NOT NULL,\n  positioned_at TEXT\n, sprint_position TEXT, "extra_position" TEXT)';
    assert.deepEqual(positionColumnNames(sql), ['position', 'sprint_position', 'extra_position']);
    // 1行に書いた文の、最初の列
    assert.deepEqual(positionColumnNames('CREATE TABLE u (position TEXT, id TEXT)'), ['position']);
  });
});

describe('seedTables', () => {
  test('マイグレーションの記録と SQLite と D1 の表は消さない', () => {
    assert.deepEqual(seedTables(['_cf_METADATA', 'accounts', 'd1_migrations', 'sqlite_sequence', 'users']), [
      'accounts',
      'users',
    ]);
  });
});

describe('sessionInserts', () => {
  test('期限は流した時刻の30日後', () => {
    const sql = sessionInserts([SEED_SESSIONS.admin], new Date('2026-10-20T00:00:00.000Z'));
    assert.ok(sql.includes(`'${tokenHash(SEED_SESSIONS.admin.token)}'`));
    assert.ok(sql.includes("'2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-11-19T00:00:00.000Z'"));
    assert.ok(!sql.includes(SEED_SESSIONS.admin.token), 'トークンそのものは DB に入れない');
  });
});

describe('seedSql', () => {
  test('外部キーの検査は消す文の間だけ先送りし、入れる文はその場で検査させる', () => {
    const sql = seedSql(['accounts', 'd1_migrations'], 'INSERT INTO accounts VALUES (1);\n', sessions, new Date());
    const lines = sql.trimEnd().split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      'PRAGMA defer_foreign_keys = true;',
      'DELETE FROM "accounts";',
      'PRAGMA defer_foreign_keys = false;',
    ]);
    assert.ok(!sql.includes('d1_migrations'));
    assert.ok(sql.indexOf('INSERT INTO accounts') < sql.indexOf('INSERT INTO sessions'));
  });
});

// 空の D1 に流して中身を数える。wrangler の手元の D1 を使うので数秒かかる
describe('pnpm db:seed', () => {
  test('2回流しても通り、自分用を含む組織7つと依頼先つきのタスク、全セッション、組織の無い運用者が入る', () => {
    const persistTo = mkdtempSync(path.join(tmpdir(), 'scrum-guild-seed-test-'));
    const root = fileURLToPath(new URL('..', import.meta.url));
    const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
    const env = { ...process.env, PATH: `${path.dirname(wrangler)}${path.delimiter}${process.env.PATH}` };
    try {
      for (const round of [1, 2]) {
        const result = spawnSync(process.execPath, ['scripts/db-seed.ts', '--persist-to', persistTo], {
          cwd: root,
          env,
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `${round}回目: ${result.stderr}`);
      }
      const query = `SELECT
        (SELECT count(*) FROM organizations) AS organizations,
        (SELECT count(*) FROM sessions) AS sessions,
        (SELECT count(*) FROM organizations WHERE kind = 'personal') AS personal_organizations,
        (SELECT count(*) FROM delegatees WHERE organization_id = '019a0000-0000-7000-8000-000000000207' AND deleted_at IS NULL) AS personal_delegatees,
        (SELECT count(*) FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
          JOIN delegatees d ON d.id = t.delegatee_id
          WHERE w.organization_id = '019a0000-0000-7000-8000-000000000207' AND d.organization_id = w.organization_id
          AND t.assignee_user_id = '019a0000-0000-7000-8000-000000000316') AS delegated_tasks,
        (SELECT count(*) FROM users u JOIN account_logins l ON l.account_id = u.account_id
          WHERE l.login_provider || ':' || l.login_subject = '${SEED_OPERATOR_LOGIN_ID}') AS operator_users,
        (SELECT count(*) FROM account_logins
          WHERE login_provider || ':' || login_subject = '${SEED_OPERATOR_LOGIN_ID}') AS operator_logins,
        (SELECT count(*) FROM sessions
          WHERE julianday(expires_at) - julianday(last_used_at) = 30) AS sessions_30_days`;
      const result = spawnSync(
        wrangler,
        ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', query],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const [row] = (JSON.parse(result.stdout) as { results: Record<string, number>[] }[])[0].results;
      assert.deepEqual(row, {
        organizations: 7,
        personal_organizations: 1,
        personal_delegatees: 2,
        delegated_tasks: 1,
        sessions: sessions.length,
        operator_users: 0,
        operator_logins: 1,
        sessions_30_days: sessions.length,
      });

      const check = spawnSync(
        wrangler,
        [
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          persistTo,
          '--json',
          '--command',
          'PRAGMA foreign_key_check',
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(check.status, 0, check.stderr);
      assert.deepEqual((JSON.parse(check.stdout) as { results: unknown[] }[])[0].results, [], '親の無い行が無い');

      // 位置の値は、アプリが末尾に足すときに generateKeyBetween へそのまま渡す。受け付けない値が1つでもあると、
      // その並びに足す操作が 500 になる（#881）。
      // 位置の列（position と *_position）はスキーマから拾い、マイグレーションで足した列も検査に入れる。D1 は pragma_table_info を
      // SQLITE_AUTH で断るので、sqlite_master の CREATE TABLE の文（ALTER TABLE で足した列も入る）から列名を読む
      const schema = spawnSync(
        wrangler,
        [
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          persistTo,
          '--json',
          '--command',
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%position%'",
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(schema.status, 0, schema.stderr || schema.stdout);
      const positionColumns = (
        JSON.parse(schema.stdout) as { results: { name: string; sql: string }[] }[]
      )[0].results.flatMap(({ name, sql }) => positionColumnNames(sql).map((column) => [name, column] as const));
      // 拾い方が壊れて列が減ったら気づけるよう、今ある列は必ず入っていることを確かめる
      for (const known of [
        'tasks.position',
        'tasks.column_position',
        'board_columns.position',
        'wiki_pages.position',
      ]) {
        assert.ok(
          positionColumns.some(([table, column]) => `${table}.${column}` === known),
          `${known} を位置の列として拾えていない`,
        );
      }
      // D1 は UNION を数本までしか受け付けないので、列ごとの JSON を1行に並べる
      const positionQuery = `SELECT ${positionColumns
        .map(
          ([table, column]) =>
            `(SELECT json_group_array(json_object('id', id, 'value', ${column})) FROM ${table} WHERE ${column} IS NOT NULL) AS "${table}.${column}"`,
        )
        .join(', ')}`;
      const positions = spawnSync(
        wrangler,
        ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', positionQuery],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(positions.status, 0, positions.stderr || positions.stdout);
      const [positionRow] = (JSON.parse(positions.stdout) as { results: Record<string, string>[] }[])[0].results;
      const positionRows = Object.entries(positionRow!).flatMap(([col, json]) =>
        (JSON.parse(json) as { id: string; value: string }[]).map((row) => ({ col, ...row })),
      );
      assert.ok(positionRows.length > 0, '位置の値を引けている');
      const invalid = positionRows.filter(({ value }) => {
        try {
          generateKeyBetween(value, null);
          return false;
        } catch {
          return true;
        }
      });
      assert.deepEqual(invalid, [], 'fractional-indexing が受け付けない位置の値が無い');

      // 受託開発チームのバックログの親なしのタスク（受信箱のタスクは数えない）は、未完了の4件の後に完了の6件が、作った順に並ぶ（#881 で位置を直す前と同じ順）
      const rootTasks = spawnSync(
        wrangler,
        [
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          persistTo,
          '--json',
          '--command',
          "SELECT substr(id, -3) AS id, position FROM tasks WHERE workspace_id = '019a0000-0000-7000-8000-000000000401' " +
            "AND tray = 'backlog' AND story_id IS NULL AND deleted_at IS NULL ORDER BY position, id",
        ],
        { cwd: root, env, encoding: 'utf8' },
      );
      assert.equal(rootTasks.status, 0, rootTasks.stderr || rootTasks.stdout);
      const rootRows = (JSON.parse(rootTasks.stdout) as { results: { id: string; position: string }[] }[])[0].results;
      assert.deepEqual(
        rootRows.map((row) => row.id),
        ['801', '802', '803', '804', '851', '852', '853', '854', '855', '856'],
      );
      assert.equal(new Set(rootRows.map((row) => row.position)).size, rootRows.length, '位置が重ならない');
    } finally {
      rmSync(persistTo, { recursive: true, force: true });
    }
  });
});
