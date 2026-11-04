// CI とクラウドの事前検査で Playwright の条件を揃える。対象の選定は呼び出し元が受け持つ。
import { spawn } from 'node:child_process';
import { repeatVerdict, REPEAT_TEST_LIMIT, type ListReport } from './ci.ts';

export type E2eMode = 'normal' | 'dev' | 'repeat';
export type E2eStatus = 'passed' | 'skipped';
export const E2E_RESULT_PREFIX = '[e2e-run:result] ';
export type E2eOptions = { files?: string[]; shard?: string; requireExecuted?: boolean };
export type Invocation = { args: string[]; env: NodeJS.ProcessEnv; capture: boolean };
export type Execute = (invocation: Invocation) => Promise<string>;

export function e2eEnvironment(mode: E2eMode, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, CI: 'true' };
  delete env.E2E_REUSE_SERVER;
  delete env.E2E_DEV_BUILD;
  // Playwright の設定が APP_VERSION からこの実行の版を決め直す。
  delete env.E2E_SERVER_VERSION;
  // build のモードは E2E_DEV_BUILD だけで決め、親の開発用設定を混ぜない。
  delete env.NODE_ENV;
  if (mode === 'dev') env.E2E_DEV_BUILD = '1';
  return env;
}

function validateOptions(mode: E2eMode, { files, shard }: E2eOptions): void {
  if (!['normal', 'dev', 'repeat'].includes(mode)) throw new Error(`不明な e2e のモード: ${mode}`);
  if (mode === 'repeat' && files === undefined) throw new Error('repeat は対象ファイルを指定する');
  // ファイルのつもりの値が Playwright のオプションになることを防ぐ。
  if (files?.some((file) => file.startsWith('-') || file.length === 0)) {
    throw new Error('e2e のファイルに空文字やオプションを指定できない');
  }
  if (shard !== undefined) {
    const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shard);
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) > Number(match[2])) {
      throw new Error(`シャードは 1 以上 n 以下の i/n で指定する: ${shard}`);
    }
  }
}

// 実ブラウザを起動せず、引数、上限、失敗時の振る舞いを検査するための呼び口。
export async function runE2eWith(
  mode: E2eMode,
  options: E2eOptions,
  execute: Execute,
  inherited: NodeJS.ProcessEnv,
): Promise<E2eStatus> {
  validateOptions(mode, options);
  const { files, shard } = options;
  // 空の選択を全件実行に変えない。通常/dev の全件は files を省略したときだけ。
  if (files?.length === 0) return 'skipped';
  const env = e2eEnvironment(mode, inherited);
  const prefix = ['exec', 'playwright', 'test'];
  if (mode === 'repeat') {
    const listed = await execute({
      args: [...prefix, '--list', '--reporter=json', '--global-timeout=1800000', ...files!],
      env,
      capture: true,
    });
    const { run, count } = repeatVerdict(JSON.parse(listed) as ListReport, files!.length);
    if (!run) {
      console.error(`e2e-repeat: ${count} 件が上限 ${REPEAT_TEST_LIMIT} 件を超えたので繰り返さない`);
      return 'skipped';
    }
  }
  const flags =
    mode === 'repeat'
      ? ['--workers=1', '--repeat-each=5', '--retries=0', '--pass-with-no-tests']
      : ['--workers=2', '--retries=0'];
  // Playwright 自身に終了処理を任せ、webServer を止めてから非0で返す。
  flags.push('--global-timeout=1800000');
  if (shard !== undefined) flags.push(`--shard=${shard}`);
  if (options.requireExecuted) {
    flags.push('--reporter=list,html,./scripts/e2e-executed-reporter.ts');
    // CLI の reporter 指定でも既存の HTML 成果物の場所と非表示を維持する。
    env.PLAYWRIGHT_HTML_OPEN = 'never';
    env.PLAYWRIGHT_HTML_OUTPUT_DIR = 'playwright-report';
  }
  await execute({ args: [...prefix, ...flags, ...(files ?? [])], env, capture: false });
  return 'passed';
}

const execute: Execute = ({ args, env, capture }) =>
  new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      env,
      shell: false,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (part: string) => {
      output += part;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`pnpm ${args.join(' ')} が失敗した（${signal ?? code}）`));
    });
  });

export async function runE2e(mode: E2eMode, options: E2eOptions = {}): Promise<E2eStatus> {
  return runE2eWith(mode, options, execute, process.env);
}

export function parseE2eArgs(argv: string[]): { mode: E2eMode; options: E2eOptions } {
  const [mode, ...rest] = argv;
  if (mode !== 'normal' && mode !== 'dev' && mode !== 'repeat') {
    throw new Error(
      '使い方: node scripts/e2e-run.ts <normal|dev|repeat> [--shard=i/n] [--require-executed] [ファイル…]',
    );
  }
  const shards = rest.filter((arg) => arg.startsWith('--shard='));
  if (shards.length > 1) throw new Error('--shard は1つだけ指定する');
  const requireExecuted = rest.filter((arg) => arg === '--require-executed');
  if (requireExecuted.length > 1) throw new Error('--require-executed は1つだけ指定する');
  const files = rest.filter((arg) => !arg.startsWith('--shard=') && arg !== '--require-executed');
  const options: E2eOptions = {
    ...(requireExecuted.length > 0 ? { requireExecuted: true } : {}),
    ...(files.length > 0 || mode === 'repeat' ? { files } : {}),
    ...(shards.length > 0 ? { shard: shards[0]!.slice('--shard='.length) } : {}),
  };
  validateOptions(mode, options);
  return { mode, options };
}

if (import.meta.main) {
  try {
    const { mode, options } = parseE2eArgs(process.argv.slice(2));
    const status = await runE2e(mode, options);
    console.log(`${E2E_RESULT_PREFIX}${JSON.stringify({ status })}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
