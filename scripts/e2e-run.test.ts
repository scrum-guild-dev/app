import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { e2eEnvironment, parseE2eArgs, runE2eWith, type Execute, type Invocation } from './e2e-run.ts';

function harness(count = 2) {
  const calls: Invocation[] = [];
  const execute: Execute = async (invocation) => {
    calls.push(invocation);
    return JSON.stringify({ suites: [{ specs: [{ tests: Array.from({ length: count }, () => ({})) }] }] });
  };
  return { calls, execute };
}

describe('CI とクラウドで共有する e2e の実行', () => {
  test('通常と開発モードは同じ待ち・ワーカー数を使い、サーバーの再利用を許さない', async () => {
    for (const mode of ['normal', 'dev'] as const) {
      const { calls, execute } = harness();
      const status = await runE2eWith(mode, {}, execute, {
        CI: '',
        E2E_DEV_BUILD: '1',
        E2E_REUSE_SERVER: '1',
        APP_VERSION: 'sha',
      });
      assert.equal(status, 'passed');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args, ['exec', 'playwright', 'test', '--workers=2', '--retries=0']);
      assert.equal(calls[0]!.env.CI, 'true');
      assert.equal(calls[0]!.env.E2E_REUSE_SERVER, undefined);
      assert.equal(calls[0]!.env.E2E_DEV_BUILD, mode === 'dev' ? '1' : undefined);
      assert.equal(calls[0]!.env.APP_VERSION, 'sha');
      assert.equal(calls[0]!.capture, false);
    }
  });

  test('上限ちょうどの繰り返しは全対象を数えてから、同じファイルを5回ずつ実行する', async () => {
    const { calls, execute } = harness(60);
    const files = ['e2e/members\\.test\\.ts$'];
    assert.equal(await runE2eWith('repeat', { files, shard: '2/3' }, execute, { E2E_DEV_BUILD: '1' }), 'passed');
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['exec', 'playwright', 'test', '--list', '--reporter=json', ...files],
        [
          'exec',
          'playwright',
          'test',
          '--workers=1',
          '--repeat-each=5',
          '--retries=0',
          '--pass-with-no-tests',
          '--shard=2/3',
          ...files,
        ],
      ],
    );
    assert.equal(calls[0]!.capture, true);
    assert.equal(calls[1]!.env.E2E_DEV_BUILD, undefined);
  });

  test('上限超過・空の選択ではテストを起動しない', async () => {
    const { calls, execute } = harness(61);
    assert.equal(await runE2eWith('repeat', { files: ['e2e/members.test.ts'] }, execute, {}), 'skipped');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.capture, true);
    calls.length = 0;
    for (const mode of ['normal', 'dev', 'repeat'] as const) {
      assert.equal(await runE2eWith(mode, { files: [] }, execute, {}), 'skipped');
    }
    assert.equal(calls.length, 0);
  });

  test('一覧の失敗・不正な出力・テストの失敗を成功として扱わない', async () => {
    const failure = new Error('test failed');
    const fail: Execute = async () => {
      throw failure;
    };
    await assert.rejects(runE2eWith('normal', {}, fail, {}), failure);
    await assert.rejects(runE2eWith('repeat', { files: ['e2e/a.test.ts'] }, fail, {}), failure);
    for (const report of ['invalid json', '{}', '{"errors":["syntax error"]}']) {
      const { calls } = harness();
      const execute: Execute = async (invocation) => {
        calls.push(invocation);
        return report;
      };
      await assert.rejects(runE2eWith('repeat', { files: ['e2e/a.test.ts'] }, execute, {}));
      assert.equal(calls.length, 1);
    }
    const { execute: list } = harness();
    await assert.rejects(
      runE2eWith(
        'repeat',
        { files: ['e2e/a.test.ts'] },
        async (call) => {
          if (!call.capture) throw failure;
          return list(call);
        },
        {},
      ),
      failure,
    );
  });

  test('引数の誤りやファイルを装ったオプションは起動前に断る', async () => {
    const { calls, execute } = harness();
    await assert.rejects(runE2eWith('repeat', {}, execute, {}));
    for (const shard of ['0/3', '4/3', '1/0', '1/x', '1/9007199254740992']) {
      await assert.rejects(runE2eWith('normal', { shard }, execute, {}));
    }
    for (const file of ['--config=other.ts', '']) {
      await assert.rejects(runE2eWith('normal', { files: [file] }, execute, {}));
    }
    assert.equal(calls.length, 0);
    assert.throws(() => parseE2eArgs(['normal', '--shard=1/2', '--shard=2/2']));
    assert.throws(() => parseE2eArgs(['unknown']));
  });

  test('呼び出し元の環境を書き換えず、ファイルのパターンをそのまま渡す', () => {
    const env = { E2E_REUSE_SERVER: '1', E2E_DEV_BUILD: '1' };
    e2eEnvironment('normal', env);
    assert.deepEqual(env, { E2E_REUSE_SERVER: '1', E2E_DEV_BUILD: '1' });
    assert.deepEqual(parseE2eArgs(['dev', 'e2e/a\\.test\\.ts$', '--shard=1/2']), {
      mode: 'dev',
      options: { files: ['e2e/a\\.test\\.ts$'], shard: '1/2' },
    });
  });

  test('前の実行の版と NODE_ENV を引き継がず、APP_VERSION と選んだモードで build する', () => {
    for (const mode of ['normal', 'dev', 'repeat'] as const) {
      const env = e2eEnvironment(mode, {
        APP_VERSION: 'current-run',
        E2E_SERVER_VERSION: 'previous-run',
        NODE_ENV: 'development',
      });
      assert.equal(env.E2E_SERVER_VERSION, undefined);
      assert.equal(env.NODE_ENV, undefined);
      assert.equal(env.APP_VERSION, 'current-run');
      assert.equal(env.E2E_DEV_BUILD, mode === 'dev' ? '1' : undefined);
    }
  });

  test('CI の3種類が共通ランナーを使い、repeat は導入前の上限確認も残す', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    for (const mode of ['normal', 'dev', 'repeat']) assert.ok(workflow.includes(`node scripts/e2e-run.ts ${mode}`));
    assert.ok(workflow.includes('node scripts/e2e-repeat-count.ts $REPEAT_FILES'));
    assert.ok(workflow.includes("if: steps.count.outputs.run == 'true'"));
  });

  test('CLI はテストを起動しない空の選択も skipped として最後の行に記録する', () => {
    const result = spawnSync(process.execPath, ['scripts/e2e-run.ts', 'repeat'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').at(-1), '[e2e-run:result] {"status":"skipped"}');
  });
});
