import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('wrangler 同梱の dotenv の版と LINE が、写した正規表現から変わっていない', () => {
  const review = 'wrangler 同梱の dotenv の parse と、dev-vars.ts・テスト・docs の見直しが必要';
  const bundle = readFileSync(new URL(import.meta.resolve('wrangler')), 'utf8');
  // バンドルは実行しない。同梱物の構成が変わり抽出できなくなったときも、黙って通さず見直す。
  const modules = [
    ...bundle.matchAll(/\/\/ [^\n]*dotenv@([^/]+)\/node_modules\/dotenv\/lib\/main\.js\n([\s\S]*?)(?=\n\/\/ )/g),
  ];
  assert.equal(modules.length, 1, `dotenv の同梱モジュールを一意に抽出できない: ${review}`);
  assert.equal(modules[0]![1], '16.3.1', `dotenv の版が変わった: ${review}`);
  const upstream = modules[0]![2]!.match(/var LINE = \/(.+)\/([a-z]+);/);
  const local = readFileSync(new URL('./dev-vars.ts', import.meta.url), 'utf8').match(
    /const DOTENV_LINE =\s*\/(.+)\/([a-z]+);/,
  );
  assert.ok(upstream, `同梱 dotenv の LINE を抽出できない: ${review}`);
  assert.ok(local, `dev-vars.ts の DOTENV_LINE を抽出できない: ${review}`);
  // mg と gm の並びだけの違いは無視する。
  assert.equal(
    new RegExp(local[1]!, local[2]).toString(),
    new RegExp(upstream[1]!, upstream[2]).toString(),
    `同梱 dotenv の LINE と DOTENV_LINE が違う: ${review}`,
  );
});

test('鍵は wrangler の dotenv と同じに数え、コメントの行は数えない', () => {
  const text = ['  export A=1', 'B =2', '#C=3', ' # D=4', 'E', 'F=', 'G=x=y # note', 'not a key=1'].join('\n');
  assert.deepEqual([...devVarKeys(text)], ['A', 'B', 'F', 'G']);
});

test('dotenv の書き方（コロンの区切り、複数行の値、. と - の鍵、CR の改行）を wrangler と同じに読む', () => {
  const cases: [string, string[]][] = [
    ['KEY: value\nNOSPACE:value', ['KEY']],
    ['PEM="line1\nINSIDE=1\nline3"\nAFTER=2', ['PEM', 'AFTER']],
    ["SINGLE='a\nINSIDE=1'\nAFTER=2", ['SINGLE', 'AFTER']],
    ['TICK=`a\nINSIDE=1`\nAFTER=2', ['TICK', 'AFTER']],
    ['A.B=1\nC-D=2\n1A=3', ['A.B', 'C-D', '1A']],
    ['A=1\rB=2\r\nC=3', ['A', 'B', 'C']],
  ];
  for (const [text, keys] of cases) assert.deepEqual([...devVarKeys(text)], keys, JSON.stringify(text));
});

test('LF・CR・CRLF の通常行と引用符付き複数行で、値の中の鍵らしい行を数えない', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    for (const quote of ['"', "'", '`']) {
      const text = ['A=1', `MULTI=${quote}first`, 'INSIDE=1', `last${quote}`, '# COMMENT=1', 'AFTER=2'].join(newline);
      assert.deepEqual([...devVarKeys(text)], ['A', 'MULTI', 'AFTER'], JSON.stringify(text));
    }
  }
});

test('コロン直後の CRLF を正規化し、次の行を値として読む dotenv と同じ鍵を数える', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    assert.deepEqual([...devVarKeys(`B:${newline}A=1${newline}AFTER=2`)], ['B', 'AFTER']);
  }
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

test('.dev.vars か .dev.vars.example が無い（壊れたリンクも）か、通常のファイルでないときは比べない', () => {
  withDir((dir) => {
    assert.equal(checkDevVars(dir), undefined);
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    assert.equal(checkDevVars(dir), undefined);
    symlinkSync(join(dir, 'missing'), join(dir, '.dev.vars'));
    assert.equal(checkDevVars(dir), undefined);
  });
  withDir((dir) => {
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    mkdirSync(join(dir, '.dev.vars'));
    assert.equal(checkDevVars(dir), undefined);
  });
  withDir((dir) => {
    // example が無ければ、読めない .dev.vars にも触れない
    writeFileSync(join(dir, '.dev.vars'), 'A=1\n');
    assert.equal(checkDevVars(dir), undefined);
    rmSync(join(dir, '.dev.vars'));
    symlinkSync('.dev.vars', join(dir, '.dev.vars'));
    assert.equal(checkDevVars(dir), undefined);
  });
});

test('読めないときは起動を止めず、読めなかったファイルの名前と理由のコードだけを返す', () => {
  withDir((dir) => {
    writeFileSync(join(dir, '.dev.vars.example'), EXAMPLE);
    // 自分を指すリンクは ELOOP になる（root でも読めない状態を作れる）
    symlinkSync('.dev.vars', join(dir, '.dev.vars'));
    const message = checkDevVars(dir) ?? '';
    assert.match(message, /^\.dev\.vars を読めませんでした（ELOOP）/);
    assert.ok(!message.includes(dir), message);
  });
  withDir((dir) => {
    writeFileSync(join(dir, '.dev.vars'), 'A=1\n');
    symlinkSync('.dev.vars.example', join(dir, '.dev.vars.example'));
    assert.match(checkDevVars(dir) ?? '', /^\.dev\.vars\.example を読めませんでした（ELOOP）/);
  });
});

test('dev.ts は足りない鍵の名前と直し方を標準エラーに出し、値は出さずに起動を続ける', () => {
  withDir((dir) => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const wrangler = join(bin, 'wrangler');
    writeFileSync(wrangler, `#!${process.execPath}\nconsole.log('WRANGLER-STARTED');\n`);
    chmodSync(wrangler, 0o755);
    // dev.ts が --var で渡す3つの鍵も example に置き、渡したときだけ数えないことを確かめる
    writeFileSync(join(dir, '.dev.vars.example'), `${EXAMPLE}APP_VERSION=\nPUBLIC_ORIGIN=\n`);
    writeFileSync(join(dir, '.dev.vars'), 'OPERATOR_LOGIN_IDS=actual-sentinel\n');
    const run = (options: { testCredentials?: boolean; version?: string } = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      delete env.APP_VERSION;
      if (options.version) env.APP_VERSION = options.version;
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./dev.ts', import.meta.url)),
          '--preview',
          ...(options.testCredentials ? ['--test-credentials'] : []),
        ],
        { cwd: dir, encoding: 'utf8', timeout: 10_000, env },
      );
    };

    const plain = run({ version: 'v-test' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.includes('WRANGLER-STARTED'), plain.stdout);
    assert.match(plain.stderr, /鍵が足りません: GITHUB_CLIENT_ID、CONNECTION_CREDENTIAL_KEYS\n/);
    assert.match(plain.stderr, /docs\/development\.md の「ワークツリーで作業する」/);
    for (const output of [plain.stdout, plain.stderr]) {
      assert.ok(!output.includes('sentinel'), output);
    }

    // APP_VERSION を渡さないときは --var に無いので、足りない鍵に数える
    const noVersion = run();
    assert.match(noVersion.stderr, /鍵が足りません: GITHUB_CLIENT_ID、CONNECTION_CREDENTIAL_KEYS、APP_VERSION\n/);

    // --test-credentials は CONNECTION_CREDENTIAL_KEYS を --var で渡すので、その鍵は警告しない
    const withTestKeys = run({ testCredentials: true, version: 'v-test' });
    assert.equal(withTestKeys.status, 0, withTestKeys.stderr);
    assert.match(withTestKeys.stderr, /鍵が足りません: GITHUB_CLIENT_ID\n/);

    writeFileSync(join(dir, '.dev.vars'), 'OPERATOR_LOGIN_IDS=a\nGITHUB_CLIENT_ID=\nCONNECTION_CREDENTIAL_KEYS=b\n');
    const complete = run({ version: 'v-test' });
    assert.equal(complete.status, 0, complete.stderr);
    assert.ok(!complete.stderr.includes('.dev.vars'), complete.stderr);
  });
});
