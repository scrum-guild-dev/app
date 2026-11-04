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
import { inputFingerprint, parsePreflightArgs, preflightPlan, runPreflight, verifyPreflight } from './e2e-preflight.ts';

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
  mkdirSync(join(cwd, 'e2e'), { recursive: true });
  writeFileSync(join(cwd, 'e2e/new.test.ts'), 'test');
  return cwd;
}

test('対象限定は通常・開発・繰り返しを先に確認し、全件は明示した場合だけ実行する', () => {
  assert.deepEqual(preflightPlan(['docs/a.md'], []), []);
  assert.throws(() => preflightPlan(['src/server/a.ts'], []), /--files/);
  assert.deepEqual(preflightPlan(['src/server/a.ts'], [], { all: true, reason: '基盤変更' }), [
    { mode: 'normal', files: [] },
  ]);
  assert.deepEqual(preflightPlan(['e2e/a.test.ts', 'e2e/deleted.test.ts'], ['e2e/a.test.ts']), [
    { mode: 'normal', files: ['e2e/a.test.ts'] },
    { mode: 'dev', files: ['e2e/a.test.ts'] },
    { mode: 'repeat', files: ['e2e/a.test.ts'] },
  ]);
  assert.throws(() => preflightPlan(['e2e/bad name.test.ts'], ['e2e/bad name.test.ts']));
});

test('未コミットと新規テストを検査し、版・対象hash・各結果を記録する', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'app.ts'), 'changed');
  mkdirSync(join(cwd, 'e2e'), { recursive: true });
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
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.checks.slice(1).map((step: { status: string }) => step.status),
    ['not-run', 'not-run'],
  );
  assert.throws(() => verifyPreflight(join(log, '../result.json'), 'base', cwd));
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
  mkdirSync(join(cwd, 'e2e'), { recursive: true });
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
    mkdirSync(join(cwd, 'e2e'), { recursive: true });
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

test('CLI の --verify に結果ファイルが無いときは起動前に使い方を示す', (t) => {
  const cwd = fixture(t);
  const result = spawnSync(process.execPath, [new URL('./e2e-preflight.ts', import.meta.url).pathname, '--verify'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /使い方: pnpm e2e:preflight .*--verify <result\.json>/);
  assert.equal(existsSync(join(cwd, '.e2e-preflight')), false);
});

test('明示対象は既存の関連テストも通常・開発・繰り返しへ渡し、理由と所要時間を残す', (t) => {
  const cwd = fixture(t);
  const options = { files: ['e2e/new.test.ts'], reason: 'Wiki の保存と削除を通る関連画面' };
  const calls: string[] = [];
  const result = runPreflight('base', {
    cwd,
    ...options,
    run(mode, files) {
      calls.push(mode);
      assert.deepEqual(files, options.files);
      return 'passed';
    },
  });
  const report = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(report.selection.scope, 'targeted');
  assert.equal(report.selection.source, 'explicit');
  assert.equal(report.selection.reason, options.reason);
  assert.deepEqual(calls, ['normal', 'dev', 'repeat']);
  assert.ok(report.durationMs >= 0);
  assert.ok(report.checks.every((step: { durationMs: number }) => step.durationMs >= 0));
  verifyPreflight(result, 'base', cwd, options);
  assert.throws(() => verifyPreflight(result, 'base', cwd));
  assert.throws(() => verifyPreflight(result, 'base', cwd, { ...options, reason: '別の判断' }));
  writeFileSync(join(cwd, 'e2e/other.test.ts'), 'other');
  assert.throws(() => verifyPreflight(result, 'base', cwd, { ...options, files: ['e2e/other.test.ts'] }));
});

test('文書のみは実行しない省略記録となり、対象限定や全件成功と区別する', (t) => {
  const cwd = fixture(t);
  rmSync(join(cwd, 'e2e'), { recursive: true });
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs/a.md'), 'documentation');
  const result = runPreflight('base', {
    cwd,
    run() {
      assert.fail('must not run');
    },
  });
  const report = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(report.status, 'skipped');
  assert.equal(report.selection.scope, 'docs-only');
  assert.deepEqual(report.checks, []);
  verifyPreflight(result, 'base', cwd);
});

test('全件は明示指定だけで動き、対象限定の記録を全件成功として再利用できない', (t) => {
  const cwd = fixture(t);
  const options = { all: true, reason: '共通基盤のため全画面を検査' };
  const calls: { mode: string; files: string[] }[] = [];
  const result = runPreflight('base', {
    cwd,
    ...options,
    run(mode, files) {
      calls.push({ mode, files });
      return 'passed';
    },
  });
  assert.deepEqual(calls, [
    { mode: 'normal', files: [] },
    { mode: 'dev', files: [] },
    { mode: 'repeat', files: ['e2e/new.test.ts'] },
  ]);
  verifyPreflight(result, 'base', cwd, options);
  assert.throws(() => verifyPreflight(result, 'base', cwd));
  const targeted = runPreflight('base', {
    cwd,
    run() {
      return 'passed';
    },
  });
  assert.throws(() => verifyPreflight(targeted, 'base', cwd, options));
});

test('空・不明・存在しない対象・全件との混在を実行前に拒否する', (t) => {
  const cwd = fixture(t);
  rmSync(join(cwd, 'e2e'), { recursive: true });
  for (const options of [
    {},
    { files: [], reason: 'empty' },
    { files: ['e2e/missing.test.ts'], reason: 'missing' },
    { files: ['src/file.ts'], reason: 'not test' },
    { files: ['--help'], reason: 'option' },
    { files: ['e2e/../bad.test.ts'], reason: 'traversal' },
    { all: true },
    { files: ['e2e/a.test.ts'] },
    { all: true, files: ['e2e/a.test.ts'], reason: 'conflict' },
    { reason: 'without selection' },
  ]) {
    assert.throws(() =>
      runPreflight('base', {
        cwd,
        ...options,
        run() {
          assert.fail('must not run');
        },
      }),
    );
  }
  assert.equal(existsSync(join(cwd, '.e2e-preflight')), false);
});

test('照合は旧形式・対象・モード・状態・時間・環境の改変を拒否する', (t) => {
  const cwd = fixture(t);
  const result = runPreflight('base', {
    cwd,
    run() {
      return 'passed';
    },
  });
  const original = JSON.parse(readFileSync(result, 'utf8'));
  for (const patch of [
    { formatVersion: 1 },
    { formatVersion: 2 },
    { mergeBase: 'wrong' },
    { selection: { ...original.selection, scope: 'all' } },
    { selection: { ...original.selection, files: [] } },
    { platform: 'other' },
    { arch: 'other' },
    { status: 'skipped' },
    { durationMs: -1 },
    { checks: original.checks.slice(0, 2) },
    { checks: original.checks.map((step: object) => ({ ...step, status: 'not-run' })) },
    { checks: original.checks.map((step: object) => ({ ...step, durationMs: -1 })) },
    { checks: [{ ...original.checks[0], mode: 'repeat' }, ...original.checks.slice(1)] },
  ]) {
    writeFileSync(result, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => verifyPreflight(result, 'base', cwd));
  }
});

test('CLI は同じ対象指定を実行と照合で受け付け、誤った引数を拒否する', () => {
  const options = { files: ['e2e/a.test.ts', 'e2e/b.test.ts'], reason: '関連画面' };
  assert.deepEqual(parsePreflightArgs(['origin/main', '--files', ...options.files, '--reason', options.reason]), {
    base: 'origin/main',
    result: undefined,
    options,
  });
  assert.deepEqual(parsePreflightArgs(['--verify', 'result.json', 'base', '--all', '--reason', '基盤']), {
    base: 'base',
    result: 'result.json',
    options: { all: true, reason: '基盤' },
  });
  for (const args of [
    ['--files'],
    ['--files', '--reason', 'empty'],
    ['--all'],
    ['--all', '--all'],
    ['--unknown'],
    ['a', 'b'],
    ['--reason', 'alone'],
    ['--verify'],
    ['--files', 'e2e/a.test.ts', '--all', '--reason', 'mixed'],
    ['--reason', '  ', '--all'],
    ['--reason', 'a', '--reason', 'b', '--all'],
  ])
    assert.throws(() => parsePreflightArgs(args));
});

test('既定の子プロセスへはファイルの完全一致正規表現を渡す', (t) => {
  const cwd = fixture(t);
  runnerStub(
    cwd,
    `import assert from 'node:assert/strict';
assert.equal(process.argv.at(-1), '--require-executed');
const pattern = new RegExp(process.argv[3]);
assert.equal(pattern.test(process.cwd() + '/e2e/new.test.ts'), true);
assert.equal(pattern.test(process.cwd() + '/e2e/newXtestXts'), false);
assert.equal(pattern.test(process.cwd() + '/e2e/prefix-new.test.ts'), false);
console.log('[e2e-run:result] {"status":"passed"}');`,
  );
  runPreflight('base', { cwd });
});

test('明示対象から追加・変更した e2e を外した検査と照合を拒否する', (t) => {
  const cwd = fixture(t);
  const result = runPreflight('base', { cwd, run: () => 'passed' });
  const omitted = { files: ['e2e/related.test.ts'], reason: '関連だけを誤って指定' };
  assert.throws(() => preflightPlan(['e2e/new.test.ts'], ['e2e/new.test.ts'], omitted), /追加・変更/);
  assert.throws(
    () =>
      runPreflight('base', {
        cwd,
        ...omitted,
        run() {
          assert.fail('must not run');
        },
      }),
    /追加・変更/,
  );
  assert.throws(() => verifyPreflight(result, 'base', cwd, omitted), /追加・変更/);
  assert.deepEqual(
    preflightPlan(['e2e/new.test.ts'], ['e2e/new.test.ts'], {
      files: ['e2e/related.test.ts', 'e2e/new.test.ts'],
      reason: '変更と関連を含める',
    }),
    ['normal', 'dev', 'repeat'].map((mode) => ({ mode, files: ['e2e/new.test.ts', 'e2e/related.test.ts'] })),
  );
});

function commit(cwd: string, message: string): void {
  for (const args of [
    ['add', '-A'],
    ['commit', '-qm', message],
  ]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

for (const scope of ['targeted', 'all', 'docs-only']) {
  test(`${scope}: 未コミット・新規・削除を内容を変えず複数コミットしても再実行せず照合する`, (t) => {
    const cwd = fixture(t);
    if (scope === 'docs-only') {
      rmSync(join(cwd, 'e2e'), { recursive: true });
      mkdirSync(join(cwd, 'docs'));
      writeFileSync(join(cwd, 'docs/new.md'), 'documentation');
    } else {
      writeFileSync(join(cwd, 'app.ts'), 'changed');
      writeFileSync(join(cwd, '.dev.vars.example'), 'PUBLIC=example');
      writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lock');
    }
    const options = scope === 'all' ? { all: true, reason: '基盤の確認' } : {};
    let calls = 0;
    const result = runPreflight('base', {
      cwd,
      ...options,
      run: () => {
        calls++;
        return 'passed';
      },
    });
    const original = readFileSync(result, 'utf8');
    const fingerprint = inputFingerprint(cwd);
    const before = verifyPreflight(result, 'base', cwd, options);
    commit(cwd, 'same input');
    assert.equal(inputFingerprint(cwd), fingerprint);
    const after = verifyPreflight(result, 'base', cwd, options);
    assert.equal(after.executedHead, before.executedHead);
    assert.notEqual(after.verifiedHead, after.executedHead);
    assert.equal(after.fingerprint, fingerprint);
    assert.match(after.basis, /same-input/);
    assert.match(after.resultSha256, /^[0-9a-f]{64}$/);
    const receipts = readdirSync(join(cwd, '.e2e-preflight')).filter((path) => path.startsWith('verification-'));
    assert.equal(receipts.length, 2);
    assert.ok(
      receipts.some(
        (path) =>
          JSON.parse(readFileSync(join(cwd, '.e2e-preflight', path), 'utf8')).verifiedHead === after.verifiedHead,
      ),
    );
    assert.equal(readFileSync(result, 'utf8'), original);
    const empty = spawnSync('git', ['commit', '--allow-empty', '-qm', 'empty'], { cwd });
    assert.equal(empty.status, 0);
    verifyPreflight(result, 'base', cwd, options);
    assert.equal(calls, scope === 'docs-only' ? 0 : 3);
    assert.equal(after.status, scope === 'docs-only' ? 'skipped' : 'passed');

    rmSync(join(cwd, 'app.ts'));
    if (scope === 'docs-only') return; // 文書のみからコード削除へは対象の再選定が必要。
    const deleted = runPreflight('base', { cwd, ...options, run: () => 'passed' });
    const deletedHash = inputFingerprint(cwd);
    commit(cwd, 'delete input');
    assert.equal(inputFingerprint(cwd), deletedHash);
    verifyPreflight(deleted, 'base', cwd, options);
  });
}

for (const path of ['app.ts', 'new.ts', '.dev.vars.example', 'pnpm-lock.yaml', 'wrangler.jsonc']) {
  test(`コミット後も ${path} の入力変更を拒否する`, (t) => {
    const cwd = fixture(t);
    const result = runPreflight('base', { cwd, run: () => 'passed' });
    commit(cwd, 'same input');
    writeFileSync(join(cwd, path), 'different');
    commit(cwd, 'different input');
    assert.throws(() => verifyPreflight(result, 'base', cwd));
  });
}

test('同じ内容でも実行時HEADを含まない履歴とbaseの移動を拒否する', (t) => {
  const cwd = fixture(t);
  commit(cwd, 'test input');
  const result = runPreflight('base', { cwd, files: ['e2e/new.test.ts'], reason: '履歴', run: () => 'passed' });
  const options = { files: ['e2e/new.test.ts'], reason: '履歴' };
  const originalHash = inputFingerprint(cwd);
  assert.equal(spawnSync('git', ['reset', '--soft', 'base'], { cwd }).status, 0);
  commit(cwd, 'replacement history');
  assert.equal(inputFingerprint(cwd), originalHash);
  assert.throws(() => verifyPreflight(result, 'base', cwd, options), /祖先/);
  assert.equal(spawnSync('git', ['branch', '-f', 'base', 'HEAD'], { cwd }).status, 0);
  assert.throws(() => verifyPreflight(result, 'base', cwd, options));
});
