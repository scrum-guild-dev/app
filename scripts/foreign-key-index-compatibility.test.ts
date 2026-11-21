import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fillSeedDates } from './seed-dates.ts';

const migrations = new URL('../migrations/', import.meta.url);
const migration = '0040_add_foreign_key_indexes.sql';
const hotRepository = 'review-fixture-repository';

// 移行前に seed 済みの行から既定の列を受け継ぎ、検査用の行をまとめて作る。
function insertFixtureRows(
  db: DatabaseSync,
  table: 'stories' | 'tasks',
  template: Record<string, SQLOutputValue>,
  replacements: Record<string, string>,
  numbers: string,
) {
  const columns = Object.keys(template);
  db.prepare(
    `WITH RECURSIVE
      story_no(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM story_no WHERE n < 2999),
      task_no(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM task_no WHERE n < 19)
    INSERT INTO ${table} (${columns.join(', ')})
    SELECT ${columns.map((column) => replacements[column] ?? `seed.${column}`).join(', ')}
    FROM ${table} AS seed CROSS JOIN ${numbers} WHERE seed.id = ?`,
  ).run(template.id!);
}

function beforeMigration() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql') && name < migration)
    .sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const seed = readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8');
  db.exec(fillSeedDates(seed, new Date('2026-11-21T12:00:00Z')));
  const workspace = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get()?.id;
  assert.ok(typeof workspace === 'string');
  const story = db.prepare('SELECT * FROM stories WHERE workspace_id = ? LIMIT 1').get(workspace);
  const task = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? LIMIT 1').get(workspace);
  assert.ok(story && task && typeof task.created_by === 'string');
  db.prepare(
    "INSERT INTO repositories (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Fixture', 'a0', ?, ?)",
  ).run(hotRepository, workspace, task.created_at!, task.updated_at!);

  insertFixtureRows(
    db,
    'stories',
    story,
    {
      id: "'review-story-' || story_no.n",
      epic_id: 'NULL',
      deleted_at: 'NULL',
      completed_at: 'NULL',
      completed_by: 'NULL',
    },
    'story_no',
  );
  insertFixtureRows(
    db,
    'tasks',
    task,
    {
      id: "'review-task-' || story_no.n || '-' || task_no.n",
      story_id: "'review-story-' || story_no.n",
      assignee_user_id: 'CASE WHEN task_no.n < 16 THEN seed.created_by END',
      repository_id: "CASE WHEN task_no.n < 15 THEN 'review-fixture-repository' END",
      tray: "'backlog'",
      deleted_at: 'NULL',
      sprint_id: 'NULL',
      column_id: 'NULL',
      column_position: 'NULL',
      completed_at: 'NULL',
      completed_by: 'NULL',
    },
    'story_no CROSS JOIN task_no',
  );
  return { db, workspace, owner: task.created_by };
}

// 0040 の前のバックログから、タスクとリポジトリを読む条件を抜き出した文で、旧版の索引選択を確かめる。
const taskConditions = `tasks.story_id = stories.id AND tasks.workspace_id = stories.workspace_id
  AND stories.workspace_id = ? AND stories.deleted_at IS NULL AND tasks.tray = 'backlog' AND tasks.deleted_at IS NULL`;
const oldList = `SELECT tasks.id, repositories.name FROM stories CROSS JOIN tasks
  LEFT JOIN repositories ON repositories.id = tasks.repository_id
    AND repositories.workspace_id = stories.workspace_id AND repositories.deleted_at IS NULL
  WHERE ${taskConditions} AND tasks.completed_at IS NULL`;
const oldCounts = `SELECT stories.id, count(tasks.completed_at), sum(tasks.points) FROM stories CROSS JOIN tasks
  WHERE ${taskConditions} GROUP BY stories.id`;

function taskLookup(db: DatabaseSync, sql: string, ...args: string[]): string {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => row.detail)
    .join('\n');
  const lookup = plan.split('\n').find((detail) => /^SEARCH tasks /.test(detail));
  assert.ok(lookup, plan);
  return lookup;
}

function equalityColumns(lookup: string): string[] {
  return Array.from(lookup.matchAll(/(\w+)=\?/g), ([, column]) => column!).sort();
}

function assertRepositoryLookup(db: DatabaseSync, workspace: string) {
  const lookup = taskLookup(db, `${oldList} AND repositories.id = ?`, workspace, hotRepository);
  assert.match(lookup, /USING (?:COVERING )?INDEX tasks_repository_fk \(/);
  assert.deepEqual(equalityColumns(lookup), ['completed_at', 'deleted_at', 'repository_id', 'story_id']);
}

function backlogLookupsWithoutRepository(db: DatabaseSync, workspace: string, owner: string) {
  return [
    taskLookup(db, oldList, workspace),
    taskLookup(db, `${oldList} AND +tasks.assignee_user_id = ?`, workspace, owner),
    taskLookup(db, oldCounts, workspace),
  ];
}

test('0040 を統計のない旧版の DB に当てても、リポジトリ指定ではストーリーごとに絞る', () => {
  const { db, workspace } = beforeMigration();
  try {
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_stat1'").get(), undefined);
    db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
    assertRepositoryLookup(db, workspace);
    const stats = db.prepare('SELECT idx FROM sqlite_stat1 ORDER BY idx').all();
    assert.deepEqual(
      stats.map((row) => row.idx),
      ['stories_workspace_fk', 'tasks_workspace_fk'],
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('競合索引以外の統計だけを採った旧版で、読み取りが増える3経路を再現する', () => {
  const { db, workspace, owner } = beforeMigration();
  try {
    db.exec('ANALYZE tasks_story_open');
    const existingStats = db.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'tasks' ORDER BY idx").all();
    assert.deepEqual(
      existingStats.map((row) => row.idx),
      ['tasks_story_open'],
    );
    db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
    // SQLite の計画が改善して再現しなくなったら、運用文書も見直す。
    const lookups = backlogLookupsWithoutRepository(db, workspace, owner);
    assert.equal(
      lookups.filter(
        (lookup) => lookup.includes('tasks_workspace_tray') && !equalityColumns(lookup).includes('story_id'),
      ).length,
      3,
      lookups.join('\n'),
    );
  } finally {
    db.close();
  }
});

test('競合索引の統計がある旧版では、0040 の適用後もバックログをストーリーごとに絞る', () => {
  for (const analyze of ['ANALYZE tasks_workspace_tray', 'ANALYZE']) {
    const { db, workspace, owner } = beforeMigration();
    try {
      db.exec(analyze);
      db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
      assertRepositoryLookup(db, workspace);
      for (const lookup of backlogLookupsWithoutRepository(db, workspace, owner)) {
        assert.ok(equalityColumns(lookup).includes('story_id'), `${analyze}: ${lookup}`);
      }
    } finally {
      db.close();
    }
  }
});
