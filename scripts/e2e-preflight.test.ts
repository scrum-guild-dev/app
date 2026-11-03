import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inputFingerprint, preflightPlan, runPreflight, verifyPreflight } from './e2e-preflight.ts';

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

// 実ブラウザを呼ばず、既定 run の spawnSync・ログの読み取り・終了状態を通す。
function runnerStub(cwd: string, body: string): void {
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts/e2e-run.ts'), body);
}

for (const status of ['passed', 'skipped']) {
  test(`既定 run が子の ${status} を読み、結果行の後の警告を許容する`, (t) => {
    const cwd = fixture(t);
    runnerStub(
      cwd,
      `console.log('[e2e-run:result] ' + JSON.stringify({status: process.argv[2] === 'repeat' ? '${status}' : 'passed'})); console.error('late warning');`,
    );
    mkdirSync(join(cwd, 'e2e'));
    writeFileSync(join(cwd, 'e2e/new.test.ts'), 'test');
    const result = runPreflight('base', { cwd });
    const report = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(report.success, true);
    assert.deepEqual(
      report.checks.map((x: { status: string }) => x.status),
      ['passed', 'passed', status],
    );
    assert.match(readFileSync(report.checks[0].log, 'utf8'), /late warning/);
  });
}

for (const [name, body] of [
  ['非0終了', `console.log('[e2e-run:result] {"status":"passed"}'); process.exitCode = 2;`],
  ['結果行欠落', `console.log('no result');`],
  ['不明な結果', `console.log('[e2e-run:result] {"status":"unknown"}');`],
  ['結果行重複', `console.log('[e2e-run:result] {"status":"passed"}\\n[e2e-run:result] {"status":"passed"}');`],
  ['通常全件の省略', `console.log('[e2e-run:result] {"status":"skipped"}');`],
]) {
  test(`既定 run は ${name} を成功とせず、後続を起動しない`, (t) => {
    const cwd = fixture(t);
    runnerStub(cwd, body);
    assert.throws(() => runPreflight('base', { cwd }));
    const dirs = readdirSync(join(cwd, '.e2e-preflight'));
    const report = JSON.parse(readFileSync(join(cwd, '.e2e-preflight', dirs[0]!, 'result.json'), 'utf8'));
    assert.equal(report.success, false);
    assert.equal(report.checks[0].status, 'failed');
    assert.ok(report.finished);
  });
}

test('verify は成功記録だけを受け付け、コード・base・HEAD・実行環境の変化を断る', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  const result = runPreflight('base', {
    cwd,
    run() {
      return 'passed';
    },
  });
  verifyPreflight(result, 'base', cwd);
  writeFileSync(join(cwd, 'app.ts'), 'after');
  assert.throws(() => verifyPreflight(result, 'base', cwd));
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  writeFileSync(join(cwd, 'new.ts'), 'new');
  assert.throws(() => verifyPreflight(result, 'base', cwd));
  rmSync(join(cwd, 'new.ts'));
  const original = JSON.parse(readFileSync(result, 'utf8'));
  for (const patch of [
    { success: false },
    { finished: '' },
    { base: 'wrong' },
    { head: 'wrong' },
    { node: 'wrong' },
    { pnpm: 'wrong' },
    { cwd: 'other-worktree' },
    { checks: [] },
    { checks: [{ ...original.checks[0], status: 'running' }] },
  ]) {
    writeFileSync(result, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => verifyPreflight(result, 'base', cwd));
  }
  writeFileSync(result, JSON.stringify(original));
  verifyPreflight(result, 'base', cwd);
  const cli = spawnSync(
    process.execPath,
    [new URL('./e2e-preflight.ts', import.meta.url).pathname, '--verify', result, 'base'],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
});

test('base のオプションを検査前に断る', (t) => {
  const cwd = fixture(t);
  assert.throws(() => runPreflight('--help', { cwd }), /base/);
});

test('hash は公開の設定例と壊れたシンボリックリンクの行き先を検出する', (t) => {
  const cwd = fixture(t);
  const before = inputFingerprint(cwd);
  writeFileSync(join(cwd, '.dev.vars.example'), 'PUBLIC=value');
  assert.notEqual(inputFingerprint(cwd), before);
  const example = inputFingerprint(cwd);
  symlinkSync('missing-a', join(cwd, 'link'));
  const linked = inputFingerprint(cwd);
  assert.notEqual(linked, example);
  rmSync(join(cwd, 'link'));
  symlinkSync('missing-b', join(cwd, 'link'));
  assert.notEqual(inputFingerprint(cwd), linked);
});
