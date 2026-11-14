// vocabulary 列を落としても、残す列の制約と省略時の既定値が働くことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

function migratedDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  db.exec(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'));
  return db;
}

const organizationId = '019a0000-0000-7000-8000-000000000201';
const workspaceId = '019a0000-0000-7000-8000-000000000401';

test('列削除後も組織のslugの形式・長さ・一意とワークスペースの外部キーを強制する', () => {
  const db = migratedDatabase();
  try {
    for (const slug of ['a', 'Aoba', 'has space', 'x'.repeat(41)]) {
      assert.throws(
        () => db.prepare('UPDATE organizations SET slug = ? WHERE id = ?').run(slug, organizationId),
        /CHECK/,
      );
    }
    assert.throws(
      () => db.prepare('UPDATE organizations SET slug = ? WHERE id = ?').run('hibari', organizationId),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db.prepare('UPDATE workspaces SET organization_id = ? WHERE id = ?').run('missing-organization', workspaceId),
      /FOREIGN KEY/,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT slug FROM organizations WHERE id = ?').get(organizationId)?.slug, 'aoba');
  } finally {
    db.close();
  }
});

test('列削除後も週の始まりと本文長の境界を守り、vocabularyなしで新しいワークスペースを作れる', () => {
  const db = migratedDatabase();
  try {
    for (const day of [-1, 7]) {
      assert.throws(
        () => db.prepare('UPDATE workspaces SET week_start = ? WHERE id = ?').run(day, workspaceId),
        /CHECK/,
      );
    }
    for (const day of [0, 6]) {
      db.prepare('UPDATE workspaces SET week_start = ? WHERE id = ?').run(day, workspaceId);
      assert.equal(db.prepare('SELECT week_start FROM workspaces WHERE id = ?').get(workspaceId)?.week_start, day);
    }
    const body = '界'.repeat(100000);
    db.prepare('UPDATE workspaces SET definition_of_done_md = ? WHERE id = ?').run(body, workspaceId);
    assert.throws(
      () => db.prepare('UPDATE workspaces SET definition_of_done_md = ? WHERE id = ?').run(`${body}界`, workspaceId),
      /CHECK/,
    );
    db.prepare(
      'INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) SELECT ?, organization_id, ?, timezone, created_by, created_at, updated_at FROM workspaces WHERE id = ?',
    ).run('019a0000-0000-7000-8000-000000009999', '境界確認', workspaceId);
    assert.deepEqual(
      db
        .prepare('SELECT name, week_start, definition_of_done_md FROM workspaces WHERE id = ?')
        .get('019a0000-0000-7000-8000-000000009999'),
      Object.assign(Object.create(null), { name: '境界確認', week_start: 1, definition_of_done_md: null }),
    );
  } finally {
    db.close();
  }
});
