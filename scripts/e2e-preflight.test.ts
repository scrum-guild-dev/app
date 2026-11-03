import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inputFingerprint, preflightPlan, runPreflight } from './e2e-preflight.ts';

function fixture(t: { after(fn: () => void): void }): string {
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-preflight-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(res.status, 0, res.stderr);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(cwd, '.gitignore'), '.e2e-preflight/\ntest-results/\nplaywright-report/\n.env\n');
  writeFileSync(join(cwd, 'app.ts'), 'initial');
  git('add', '.');
  git('commit', '-qm', 'initial');
  git('branch', 'base');
  return cwd;
}

test('CI の文書判定・dev判定と、追加/変更テストだけの繰り返しを使う', () => {
  assert.deepEqual(preflightPlan(['docs/a.md'], []), []);
  assert.deepEqual(preflightPlan(['src/server/a.ts'], []), [{ mode: 'normal', files: [] }]);
  assert.deepEqual(preflightPlan(['e2e/a.test.ts', 'e2e/deleted.test.ts'], ['e2e/a.test.ts']), [
    { mode: 'normal', files: [] },
    { mode: 'dev', files: [] },
    { mode: 'repeat', files: ['e2e/a.test.ts'] },
  ]);
  assert.throws(() => preflightPlan(['e2e/bad name.test.ts'], ['e2e/bad name.test.ts']));
});

test('未コミットと新規テストを検査し、版・対象hash・各結果を記録する', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  mkdirSync(join(cwd, 'e2e'));
  writeFileSync(join(cwd, 'e2e/new.test.ts'), 'test');
  const calls: string[] = [];
  const versions = new Set<string>();
  const result = runPreflight('base', {
    cwd,
    run(mode, files, version, log) {
      calls.push(mode);
      versions.add(version);
      writeFileSync(log, 'ok');
      if (mode === 'repeat') assert.deepEqual(files, ['e2e/new.test.ts']);
      mkdirSync(join(cwd, 'test-results'), { recursive: true });
      writeFileSync(join(cwd, 'test-results/result.txt'), mode);
      return 'passed';
    },
  });
  assert.deepEqual(calls, ['normal', 'dev', 'repeat']);
  assert.equal(versions.size, 3);
  const report = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(report.success, true);
  assert.equal(report.fingerprint, inputFingerprint(cwd));
  assert.ok(report.head);
  assert.ok(report.base);
  assert.ok(report.finished);
  assert.deepEqual(
    report.checks.map((x: { status: string }) => x.status),
    ['passed', 'passed', 'passed'],
  );
  assert.equal(readFileSync(join(result, '../normal/test-results/result.txt'), 'utf8'), 'normal');
});

test('失敗を成功にせず記録し、後続検査を起動しない', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  let log = '';
  assert.throws(
    () =>
      runPreflight('base', {
        cwd,
        run(_mode, _files, _version, path) {
          log = path;
          throw new Error('failure');
        },
      }),
    /failure/,
  );
  const report = JSON.parse(readFileSync(join(log, '../result.json'), 'utf8'));
  assert.equal(report.success, false);
  assert.equal(report.checks[0].status, 'failed');
  assert.ok(report.finished);
});

test('検査中に入力が変わったら全検査が通っても成功としない', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  assert.throws(
    () =>
      runPreflight('base', {
        cwd,
        run() {
          writeFileSync(join(cwd, 'app.ts'), 'changed again');
          return 'passed';
        },
      }),
    /コードが変わった/,
  );
});

test('存在しないbaseでは検査を実行しない', (t) => {
  const cwd = fixture(t);
  assert.throws(
    () =>
      runPreflight('missing', {
        cwd,
        run() {
          assert.fail('must not run');
        },
      }),
    /git rev-parse/,
  );
});

test('hash は新規ファイルと削除を検出し、秘密ファイルには依存しない', (t) => {
  const cwd = fixture(t);
  const before = inputFingerprint(cwd);
  writeFileSync(join(cwd, '.env'), 'secret');
  assert.equal(inputFingerprint(cwd), before);
  writeFileSync(join(cwd, 'new.ts'), 'new');
  assert.notEqual(inputFingerprint(cwd), before);
  rmSync(join(cwd, 'new.ts'));
  rmSync(join(cwd, 'app.ts'));
  assert.notEqual(inputFingerprint(cwd), before);
});

test('上限で省略した繰り返しを skipped と記録し、前の成果物をコピーしない', (t) => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, 'e2e'));
  writeFileSync(join(cwd, 'e2e/new.test.ts'), 'test');
  const result = runPreflight('base', {
    cwd,
    run(mode) {
      mkdirSync(join(cwd, 'test-results'), { recursive: true });
      writeFileSync(join(cwd, 'test-results/result.txt'), mode);
      return mode === 'repeat' ? 'skipped' : 'passed';
    },
  });
  const report = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(report.success, true);
  assert.equal(report.checks[2].status, 'skipped');
  assert.equal(existsSync(join(result, '../repeat/test-results')), false);
});
