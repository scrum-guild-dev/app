import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadingFixtureSql, loadingWorkspace } from './loading-fixture.ts';

test('読み取り計測fixtureは実スキーマで最近の完了・経験値・終了スプリントを集計できる', () => {
  // UTCの日付境界直前でも、全ステートメントは同じ基準日を使う。
  const now = new Date('2026-11-08T23:59:59.999Z');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    db.exec(readFileSync(new URL('../seed/data.sql', import.meta.url), 'utf8'));
    const fixture = loadingFixtureSql(now);
    assert.equal(fixture.includes("'now'"), false);
    db.exec(fixture);
    const count = (table: string, condition = '1') =>
      Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM ${table} WHERE workspace_id=? AND (${condition.replaceAll("'now'", `'${now.toISOString()}'`)})`,
          )
          .get(loadingWorkspace)?.n,
      );
    assert.equal(count('tasks'), 5000);
    assert.equal(count('epics'), 10);
    assert.equal(count('stories'), 100);
    assert.equal(count('wiki_pages'), 100);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM wiki_pages WHERE organization_id=?')
        .get('019a0000-0000-7000-8000-000000000201')?.n,
      100,
    );
    const completed = count('tasks', 'completed_at IS NOT NULL');
    assert.ok(completed >= 3900 && completed <= 4100);
    assert.equal(count('completions'), completed);
    assert.ok(count('xp_grants') >= 3000);
    assert.equal(count('comments'), 5000);
    assert.equal(count('sprints', "status='closed'"), 3);
    assert.equal(count('tasks', "sprint_id IN (SELECT id FROM sprints WHERE status='active')"), 30);
    assert.equal(
      db
        .prepare('SELECT count(DISTINCT date(completed_at)) AS n FROM completions WHERE workspace_id=?')
        .get(loadingWorkspace)?.n,
      7,
    );
    assert.ok(
      count('tasks', "completed_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now') AND completed_by IS NOT NULL") > 0,
    );
    assert.equal(count('tasks', "completed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"), 0);
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS n FROM completions c JOIN tasks t ON t.id=c.task_id
      WHERE c.workspace_id=? AND (c.workspace_id<>t.workspace_id OR c.completed_at<>t.completed_at
      OR c.completed_by<>t.completed_by OR c.assignee_user_id IS NOT t.assignee_user_id OR c.sprint_id IS NOT t.sprint_id)`,
        )
        .get(loadingWorkspace)?.n,
      0,
    );
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS n FROM xp_grants x JOIN completions c ON c.id=x.completion_id
      WHERE x.workspace_id=? AND (x.workspace_id<>c.workspace_id OR x.task_id<>c.task_id
      OR x.user_id<>coalesce(c.assignee_user_id,c.completed_by) OR x.amount<>30)`,
        )
        .get(loadingWorkspace)?.n,
      0,
    );
    const velocities = db
      .prepare(
        `SELECT s.id, sum(c.points) AS points FROM sprints s
      JOIN completions c ON c.sprint_id=s.id AND c.workspace_id=s.workspace_id
      WHERE s.workspace_id=? AND s.status='closed' GROUP BY s.id`,
      )
      .all(loadingWorkspace);
    assert.equal(velocities.length, 3);
    assert.ok(velocities.every((row) => Number(row.points) > 0));
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS n FROM completions c JOIN sprints s ON s.id=c.sprint_id
      WHERE c.workspace_id=? AND c.completed_at>s.closed_at`,
        )
        .get(loadingWorkspace)?.n,
      0,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
