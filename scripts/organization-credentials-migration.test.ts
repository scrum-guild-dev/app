// 実マイグレーションを旧スキーマの最小fixtureで検査する。これは本番のDB入口や組織/共通のJOINではない。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const migration = readFileSync(new URL('../migrations/0021_add_organization_credentials.sql', import.meta.url), 'utf8');
const UTC = '2026-10-31T10:00:00.000Z';

function oldDatabase() {
  const db = new DatabaseSync(':memory:');
  // 新しく追加する列と、それを埋める旧列の互換性のみを確かめる最小の旧テーブル。
  db.exec(
    'CREATE TABLE users (id TEXT PRIMARY KEY, disabled_at TEXT); CREATE TABLE api_tokens (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL)',
  );
  return db;
}

test('既に無効の人は移行時刻で止め、無効化後に旧Cookieで作った既存トークンも拒む。有効な人はNULL', () => {
  const db = oldDatabase();
  try {
    db.prepare('INSERT INTO users (id, disabled_at) VALUES (?, ?)').run('disabled', UTC);
    db.prepare('INSERT INTO users (id, disabled_at) VALUES (?, ?)').run('active', null);
    const issuedAfterDisable = '2026-10-31T10:01:00.000Z';
    db.prepare('INSERT INTO api_tokens VALUES (?, ?)').run('stolen-cookie-token', issuedAfterDisable);
    const before = new Date().toISOString();
    db.exec(migration);
    const after = new Date().toISOString();
    const cutoff = db
      .prepare('SELECT credentials_not_before FROM users WHERE id = ?')
      .get('disabled')?.credentials_not_before;
    assert.ok(typeof cutoff === 'string');
    assert.ok(cutoff >= before && cutoff <= after, '線はmigration実行前後の範囲内');
    assert.ok(cutoff > issuedAfterDisable, '無効化後に旧Cookieから発行した既存トークンも線より前になる');
    assert.equal(
      db.prepare('SELECT credentials_not_before FROM users WHERE id = ?').get('active')?.credentials_not_before,
      null,
    );
  } finally {
    db.close();
  }
});

test('既存トークンのUTC created_atをauthenticated_atに補完する', () => {
  const db = oldDatabase();
  try {
    db.prepare('INSERT INTO api_tokens VALUES (?, ?)').run('utc', UTC);
    db.exec(migration);
    assert.equal(
      db.prepare('SELECT authenticated_at FROM api_tokens WHERE token_hash = ?').get('utc')?.authenticated_at,
      UTC,
    );
  } finally {
    db.close();
  }
});

for (const createdAt of ['2026-10-31T19:00:00+09:00', 'Sat, 31 Oct 2026 10:00:00 GMT']) {
  test(`旧コードが保存した${createdAt}があっても失敗せずNULL fallbackを残す`, () => {
    const db = oldDatabase();
    try {
      db.prepare('INSERT INTO api_tokens VALUES (?, ?)').run('legacy', createdAt);
      assert.doesNotThrow(() => db.exec(migration));
      const row = db.prepare('SELECT created_at, authenticated_at FROM api_tokens WHERE token_hash = ?').get('legacy');
      assert.equal(row?.created_at, createdAt);
      assert.equal(row?.authenticated_at, null);
    } finally {
      db.close();
    }
  });
}

test('追加列を知らない旧コードが移行後もNULLのままINSERTできる', () => {
  const db = oldDatabase();
  try {
    db.exec(migration);
    db.prepare('INSERT INTO users (id, disabled_at) VALUES (?, ?)').run('old-user', null);
    db.prepare('INSERT INTO api_tokens (token_hash, created_at) VALUES (?, ?)').run('old-token', UTC);
    assert.equal(db.prepare('SELECT credentials_not_before FROM users').get()?.credentials_not_before, null);
    assert.equal(db.prepare('SELECT authenticated_at FROM api_tokens').get()?.authenticated_at, null);
  } finally {
    db.close();
  }
});

test('認証の線は文字列で比較できる固定3桁ミリ秒UTCだけを保存する', () => {
  const db = oldDatabase();
  try {
    db.prepare('INSERT INTO users (id, disabled_at) VALUES (?, ?)').run('active', null);
    db.prepare('INSERT INTO api_tokens VALUES (?, ?)').run('utc', UTC);
    db.exec(migration);
    // ISOとして読めても桁数が違うと、同じ秒の .100Z より .1Z が文字列で後に並ぶ。
    assert.throws(
      () =>
        db.prepare('UPDATE users SET credentials_not_before = ? WHERE id = ?').run('2026-11-04T10:55:00.1Z', 'active'),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

for (const disabledAt of [
  '2026-10-31T19:00:00+09:00',
  '2026-10-31T10:00:00Z',
  '2026-10-31T10:00:00.1Z',
  '2026-99-99T10:00:00.000Z',
]) {
  test(`旧disabled_atが${disabledAt}でも、無効な人の線は有効なUTCの移行時刻になる`, () => {
    const db = oldDatabase();
    try {
      db.prepare('INSERT INTO users (id, disabled_at) VALUES (?, ?)').run('disabled', disabledAt);
      const before = new Date().toISOString();
      assert.doesNotThrow(() => db.exec(migration));
      const after = new Date().toISOString();
      const cutoff = db.prepare('SELECT credentials_not_before FROM users').get()?.credentials_not_before;
      assert.ok(typeof cutoff === 'string');
      assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(new Date(cutoff).toISOString(), cutoff);
      assert.ok(cutoff >= before && cutoff <= after, '古いdisabled_atではなくmigration時刻を保存');
    } finally {
      db.close();
    }
  });
}
