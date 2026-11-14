// 旧スキーマに行を入れてから実マイグレーションを適用し、列削除以外を変えないことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const migrations = new URL('../migrations/', import.meta.url);
const migrationFiles = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const targetTables = ['organizations', 'workspaces'] as const;

function oldDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles.filter((name) => name <= '0030_\uffff')) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  db.exec(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'));
  for (const table of targetTables) {
    // 廃止前の値と、書き込み停止後の既定値のどちらが残っていても移行できる。
    db.exec(`UPDATE ${table} SET vocabulary = CASE WHEN rowid % 2 = 0 THEN 'game' ELSE 'scrum' END`);
    assert.deepEqual(
      db
        .prepare(`SELECT DISTINCT vocabulary FROM ${table} ORDER BY vocabulary`)
        .all()
        .map((row) => row.vocabulary),
      ['game', 'scrum'],
    );
  }
  return db;
}

function upgrade(db: DatabaseSync) {
  // 後続のスキーマ変更を、この列削除だけの保持検査に混ぜない。
  db.exec(readFileSync(new URL('0031_drop_vocabulary.sql', migrations), 'utf8'));
}

function columns(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function rowsWithoutVocabulary(db: DatabaseSync) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => {
      assert.equal(typeof name, 'string');
      const names = columns(db, name as string)
        .map((column) => String(column.name))
        .filter((column) => column !== 'vocabulary');
      return { name, rows: db.prepare(`SELECT ${names.join(', ')} FROM ${name} ORDER BY rowid`).all() };
    });
}

test('vocabularyの削除で既存の全行・他列・外部キー・索引・トリガーを失わない', () => {
  const db = oldDatabase();
  try {
    const beforeRows = rowsWithoutVocabulary(db);
    const beforeColumns = targetTables.map((table) =>
      columns(db, table)
        .filter((column) => column.name !== 'vocabulary')
        .map((column) => Object.fromEntries(Object.entries(column).filter(([name]) => name !== 'cid'))),
    );
    const beforeForeignKeys = targetTables.map((table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all());
    const objects = () =>
      db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name")
        .all();
    const beforeObjects = objects();
    upgrade(db);
    assert.deepEqual(rowsWithoutVocabulary(db), beforeRows);
    assert.deepEqual(
      targetTables.map((table) =>
        columns(db, table)
          .filter((column) => column.name !== 'vocabulary')
          .map((column) => Object.fromEntries(Object.entries(column).filter(([name]) => name !== 'cid'))),
      ),
      beforeColumns,
    );
    assert.deepEqual(
      targetTables.map((table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()),
      beforeForeignKeys,
    );
    assert.deepEqual(objects(), beforeObjects);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const table of targetTables) {
      assert.equal(
        columns(db, table).some((column) => column.name === 'vocabulary'),
        false,
        `${table}の列を削除する`,
      );
    }
  } finally {
    db.close();
  }
});

for (const table of targetTables) {
  test(`${table}は移行後にvocabularyを指定した旧コードの書き込みを受け付けない`, () => {
    const db = oldDatabase();
    try {
      upgrade(db);
      assert.throws(() => db.exec(`UPDATE ${table} SET vocabulary = 'scrum'`), /no such column: vocabulary/);
    } finally {
      db.close();
    }
  });
}
