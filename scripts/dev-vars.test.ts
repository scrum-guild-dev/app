import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDevVars, devVarKeys, missingDevVarKeys } from './dev-vars.ts';

const EXAMPLE = [
  '# 開発用の値',
  'OPERATOR_LOGIN_IDS=github:9000000000000001',
  '',
  'GITHUB_CLIENT_ID=',
  '# DEV_NOW=2026-10-26T10:00:00+09:00',
  'CONNECTION_CREDENTIAL_KEYS=example-sentinel',
  '',
].join('\n');

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dev-vars-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('鍵は行頭の NAME= だけを数え、コメントの例は数えない', () => {
  const text = ['  export A=1', 'B =2', '#C=3', ' # D=4', 'E', 'F=', 'G=x=y\r', 'not a key=1'].join('\n');
  assert.deepEqual([...devVarKeys(text)], ['A', 'B', 'F', 'G']);
});

test('足りない鍵だけを、.dev.vars.example の順で返す。空の値は「ある」と数える', () => {
  assert.deepEqual(missingDevVarKeys(EXAMPLE, 'GITHUB_CLIENT_ID=\n'), [
    'OPERATOR_LOGIN_IDS',
    'CONNECTION_CREDENTIAL_KEYS',
  ]);
  assert.deepEqual(
    missingDevVarKeys(EXAMPLE, 'OPERATOR_LOGIN_IDS=a\nGITHUB_CLIENT_ID=\nCONNECTION_CREDENTIAL_KEYS=\n'),
    [],
  );
});

test('--var で渡す鍵は足りない鍵に数えない', () => {
  assert.deepEqual(
    missingDevVarKeys(EXAMPLE, 'OPERATOR_LOGIN_IDS=a\nGITHUB_CLIENT_ID=\n', ['CONNECTION_CREDENTIAL_KEYS']),
    [],
  );
});

test('.dev.vars か .dev.vars.example が無い（壊れたリンクも）ときは比べない', () => {
  withDir((dir) => {
    assert.equal(checkDevVars(dir), undefined);
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    assert.equal(checkDevVars(dir), undefined);
    symlinkSync(join(dir, 'missing'), join(dir, '.dev.vars'));
    assert.equal(checkDevVars(dir), undefined);
  });
  withDir((dir) => {
    writeFileSync(join(dir, '.dev.vars'), 'A=1\n');
    assert.equal(checkDevVars(dir), undefined);
  });
});

test('読めない .dev.vars は起動を止めず、理由のコードだけを返す', () => {
  withDir((dir) => {
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    mkdirSync(join(dir, '.dev.vars'));
    const message = checkDevVars(dir);
    assert.match(message ?? '', /確かめられませんでした（EISDIR）/);
  });
});

test('dev.ts は足りない鍵の名前と直し方を標準エラーに出し、値は出さずに起動を続ける', () => {
  withDir((dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const wrangler = join(bin, 'wrangler');
    writeFileSync(wrangler, `#!${process.execPath}\nconsole.log('WRANGLER-STARTED');\n`);
    chmodSync(wrangler, 0o755);
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    writeFileSync(join(dir, '.dev.vars'), 'OPERATOR_LOGIN_IDS=actual-sentinel\n');
    const run = (testCredentials: boolean) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./dev.ts', import.meta.url)),
          '--preview',
          ...(testCredentials ? ['--test-credentials'] : []),
        ],
        { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
      );

    const plain = run(false);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.includes('WRANGLER-STARTED'), plain.stdout);
    assert.match(plain.stderr, /鍵が足りません: GITHUB_CLIENT_ID、CONNECTION_CREDENTIAL_KEYS\n/);
    assert.match(plain.stderr, /docs\/development\.md の「ワークツリーで作業する」/);
    for (const output of [plain.stdout, plain.stderr]) {
      assert.ok(!output.includes('sentinel'), output);
    }

    // --test-credentials は CONNECTION_CREDENTIAL_KEYS を --var で渡すので、その鍵は警告しない
    const withTestKeys = run(true);
    assert.equal(withTestKeys.status, 0, withTestKeys.stderr);
    assert.match(withTestKeys.stderr, /鍵が足りません: GITHUB_CLIENT_ID\n/);

    writeFileSync(join(dir, '.dev.vars'), 'OPERATOR_LOGIN_IDS=a\nGITHUB_CLIENT_ID=\nCONNECTION_CREDENTIAL_KEYS=b\n');
    const complete = run(false);
    assert.equal(complete.status, 0, complete.stderr);
    assert.ok(!complete.stderr.includes('.dev.vars'), complete.stderr);
  });
});
