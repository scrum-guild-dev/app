// クラウドは対象を絞って早く確かめ、全件の回帰検査は CI が受け持つ。
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_RESULT_PREFIX } from './e2e-run.ts';
import { isDocsOnly, needsDevBuild, parseNulSeparated, repeatFiles } from './ci.ts';

type Mode = 'normal' | 'dev' | 'repeat';
type Run = (mode: Mode, files: string[], version: string, log: string) => 'passed' | 'skipped';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

export function inputFingerprint(cwd: string): string {
  const paths = [
    ...new Set(parseNulSeparated(git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'))),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    // 秘密の値を検査記録のために読むことも避ける。
    if (/(^|\/)(\.env|\.dev\.vars)(\.|$)/.test(path) && !/(^|\/)(\.env|\.dev\.vars)\.example$/.test(path)) continue;
    hash.update(`${path}\0`);
    const file = join(cwd, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      hash.update('deleted\0');
      continue;
    }
    hash.update(`${stat.mode}\0`);
    hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export type SelectionOptions = { files?: string[]; all?: boolean; reason?: string };
type Selection = {
  scope: 'targeted' | 'all' | 'docs-only';
  source: 'explicit' | 'changed' | 'docs-only';
  files: string[];
  reason: string;
};

function selectTests(changed: string[], addedOrModified: string[], options: SelectionOptions): Selection {
  const { files, all = false, reason } = options;
  if (all && files !== undefined) throw new Error('--all と --files は同時に指定できない');
  if ((all || files !== undefined) && !reason?.trim()) throw new Error('明示対象には --reason が必要');
  if (!all && files === undefined && reason !== undefined) throw new Error('--reason は --files / --all と指定する');
  if (all) return { scope: 'all', source: 'explicit', files: [], reason: reason!.trim() };
  if (files !== undefined) {
    const selected = repeatFiles(files);
    if (!files.length || selected.length !== new Set(files).size)
      throw new Error('--files は e2e のテストを1つ以上指定する');
    const missing = repeatFiles(addedOrModified).filter((file) => !selected.includes(file));
    if (missing.length) throw new Error(`--files に追加・変更した e2e をすべて含める: ${JSON.stringify(missing)}`);
    return { scope: 'targeted', source: 'explicit', files: selected, reason: reason!.trim() };
  }
  if (isDocsOnly(changed))
    return { scope: 'docs-only', source: 'docs-only', files: [], reason: 'CI と同じ文書のみの判定により省略' };
  const selected = repeatFiles(addedOrModified);
  if (!selected.length)
    throw new Error(
      '変更 e2e が無い。関連テストを --files と --reason で指定する。対象を絞れない場合だけ --all --reason を選ぶ',
    );
  return {
    scope: 'targeted',
    source: 'changed',
    files: selected,
    reason:
      '追加・変更した e2e テストを選定。--files は自動選定を置き換えるため、変更テストと関連する既存テストをすべて列挙する',
  };
}

export function preflightPlan(
  changed: string[],
  addedOrModified: string[],
  options: SelectionOptions = {},
): { mode: Mode; files: string[] }[] {
  const selection = selectTests(changed, addedOrModified, options);
  if (selection.scope === 'docs-only') return [];
  // 対象を絞った検査では、CI の全件 dev 判定に関係なく選んだ画面の開発時の警告も確かめる。
  if (selection.scope === 'targeted')
    return ['normal', 'dev', 'repeat'].map((mode) => ({ mode: mode as Mode, files: selection.files }));
  const plan: { mode: Mode; files: string[] }[] = [{ mode: 'normal', files: [] }];
  if (needsDevBuild(changed)) plan.push({ mode: 'dev', files: [] });
  const files = repeatFiles(addedOrModified);
  if (files.length) plan.push({ mode: 'repeat', files });
  return plan;
}

function resolveBase(cwd: string, base: string): string {
  if (!base || base.startsWith('-')) throw new Error('base に空文字やオプションを指定できない');
  return git(cwd, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim();
}

function pnpmVersion(cwd: string): string {
  const result = spawnSync('pnpm', ['--version'], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('pnpm の版を取得できない');
  return result.stdout.trim();
}

function currentPlan(cwd: string, baseSha: string, head: string, options: SelectionOptions) {
  const mergeBase = git(cwd, 'merge-base', baseSha, head).trim();
  // 作業中の修正と新規テストも対象に含める。リネームは削除と追加として扱う。
  const untracked = parseNulSeparated(git(cwd, 'ls-files', '-z', '--others', '--exclude-standard'));
  const changed = [
    ...parseNulSeparated(git(cwd, 'diff', '--name-only', '--no-renames', '-z', mergeBase)),
    ...untracked,
  ];
  const added = [
    ...parseNulSeparated(git(cwd, 'diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', mergeBase)),
    ...untracked,
  ];
  const selection = selectTests(changed, added, options);
  for (const file of selection.files) {
    const stat = lstatSync(join(cwd, file), { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`対象テストが通常ファイルとして存在しない: ${file}`);
  }
  return { mergeBase, selection, plan: preflightPlan(changed, added, options) };
}

export function verifyPreflight(
  result: string,
  base = 'origin/main',
  cwd = process.cwd(),
  options: SelectionOptions = {},
): void {
  const report = JSON.parse(readFileSync(resolve(cwd, result), 'utf8'));
  const baseSha = resolveBase(cwd, base);
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  const { mergeBase, selection, plan } = currentPlan(cwd, baseSha, head, options);
  if (
    report.formatVersion !== 2 ||
    JSON.stringify(report.selection) !== JSON.stringify(selection) ||
    report.status !== (selection.scope === 'docs-only' ? 'skipped' : 'passed') ||
    report.platform !== process.platform ||
    report.arch !== process.arch ||
    !Number.isFinite(report.durationMs) ||
    report.durationMs < 0 ||
    report.cwd !== realpathSync(cwd) ||
    report.success !== true ||
    !report.finished ||
    report.base !== baseSha ||
    report.head !== head ||
    report.mergeBase !== mergeBase ||
    report.fingerprint !== inputFingerprint(cwd) ||
    report.node !== process.version ||
    report.pnpm !== pnpmVersion(cwd) ||
    !Array.isArray(report.checks) ||
    !report.checks.every(
      (step: { mode: string; status: string; durationMs: number }) =>
        Number.isFinite(step.durationMs) &&
        step.durationMs >= 0 &&
        (step.status === 'passed' || (step.mode === 'repeat' && step.status === 'skipped')),
    ) ||
    JSON.stringify(
      report.checks.map((step: { mode: string; files: string[] }) => ({ mode: step.mode, files: step.files })),
    ) !== JSON.stringify(plan)
  ) {
    throw new Error('成功記録と現在のコード・base・HEAD・実行環境が一致しない。e2e:preflight をやり直す');
  }
}

export function runPreflight(
  base = 'origin/main',
  options: SelectionOptions & { cwd?: string; run?: Run } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const baseSha = resolveBase(cwd, base);
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  const { mergeBase, selection, plan } = currentPlan(cwd, baseSha, head, options);
  const fingerprint = inputFingerprint(cwd);
  const dir = join(cwd, '.e2e-preflight', `${Date.now()}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const report = {
    formatVersion: 2,
    selection,
    platform: process.platform,
    arch: process.arch,
    status: 'not-run',
    durationMs: 0,
    cwd: realpathSync(cwd),
    head,
    base: baseSha,
    mergeBase,
    fingerprint,
    node: process.version,
    pnpm: pnpmVersion(cwd),
    started: new Date().toISOString(),
    finished: '',
    success: false,
    checks: plan.map((step) => ({ ...step, status: 'not-run', durationMs: 0, log: join(dir, `${step.mode}.log`) })),
  };
  const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  const run: Run =
    options.run ??
    ((mode, files, version, log) => {
      const fd = openSync(log, 'w');
      try {
        const result = spawnSync(
          process.execPath,
          [
            'scripts/e2e-run.ts',
            mode,
            ...files.map((file) => `^${RegExp.escape(resolve(cwd, file))}$`),
            '--require-executed',
          ],
          {
            cwd,
            env: { ...process.env, APP_VERSION: version, E2E_SERVER_VERSION: version },
            stdio: ['ignore', fd, fd],
          },
        );
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`${mode} が失敗 (${result.status ?? result.signal})。${log} を確認する`);
        const lines = readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(E2E_RESULT_PREFIX));
        if (lines.length !== 1) throw new Error(`検査の結果行は1つ必要: ${log}`);
        const line = lines[0]!;
        const { status } = JSON.parse(line.slice(E2E_RESULT_PREFIX.length)) as { status: string };
        if (status !== 'passed' && !(mode === 'repeat' && status === 'skipped'))
          throw new Error(`不明な検査結果: ${log}`);
        return status;
      } finally {
        closeSync(fd);
      }
    });
  console.log(`[e2e:preflight] ${selection.scope}: ${JSON.stringify(selection.files)} — ${selection.reason}`);
  console.log(`[e2e:preflight] 計画: ${JSON.stringify(plan)}（files: [] は明示した全件実行のみ）`);
  save();
  try {
    for (const step of report.checks) {
      console.log(`[e2e:preflight] ${step.mode}: ${step.log}`);
      const stepStarted = Date.now();
      step.status = 'running';
      save();
      try {
        for (const artifact of ['test-results', 'playwright-report']) {
          rmSync(join(cwd, artifact), { recursive: true, force: true });
        }
        step.status = run(step.mode, step.files, `preflight-${randomUUID()}`, step.log);
      } catch (error) {
        step.status = 'failed';
        throw error;
      } finally {
        step.durationMs = Date.now() - stepStarted;
        for (const artifact of ['test-results', 'playwright-report']) {
          const source = join(cwd, artifact);
          if (step.status !== 'skipped' && existsSync(source))
            cpSync(source, join(dir, step.mode, artifact), { recursive: true });
        }
        save();
      }
    }
    if (inputFingerprint(cwd) !== fingerprint || git(cwd, 'rev-parse', 'HEAD').trim() !== head) {
      throw new Error('検査中にコードが変わったため結果を再利用できない。e2e:preflight をやり直す');
    }
    report.status = selection.scope === 'docs-only' ? 'skipped' : 'passed';
    report.success = true;
    return join(dir, 'result.json');
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    report.durationMs = Date.now() - startedAt;
    report.finished = new Date().toISOString();
    save();
    console.log(`[e2e:preflight] 結果: ${join(dir, 'result.json')}`);
  }
}

const USAGE =
  '使い方: pnpm e2e:preflight [base-ref] [--files <e2e/*.test.ts…> --reason <理由> | --all --reason <理由>] | --verify <result.json> [base-ref] [同じ対象指定]';

export function parsePreflightArgs(args: string[]): { base: string; result?: string; options: SelectionOptions } {
  let base: string | undefined;
  let result: string | undefined;
  const options: SelectionOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--verify') {
      if (result !== undefined || !args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error(USAGE);
      result = args[++i];
    } else if (arg === '--all') {
      if (options.all) throw new Error(USAGE);
      options.all = true;
    } else if (arg === '--reason') {
      if (options.reason !== undefined || !args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error(USAGE);
      options.reason = args[++i];
    } else if (arg === '--files') {
      if (options.files !== undefined) throw new Error(USAGE);
      options.files = [];
      while (args[i + 1] && !args[i + 1]!.startsWith('-')) options.files.push(args[++i]!);
      if (!options.files.length) throw new Error(USAGE);
    } else {
      if (arg.startsWith('-') || base !== undefined || !arg) throw new Error(USAGE);
      base = arg;
    }
  }
  // 引数の誤りは git や検査を起動する前に拒む。自動対象の有無だけはここで判断しない。
  if (options.all || options.files !== undefined || options.reason !== undefined) selectTests([], [], options);
  return { base: base ?? 'origin/main', result, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { base, result, options } = parsePreflightArgs(process.argv.slice(2));
  if (result !== undefined) {
    verifyPreflight(result, base, process.cwd(), options);
    console.log('[e2e:preflight] 記録と現在のコード・対象が一致する（全件成功は scope: all のみ）');
  } else {
    runPreflight(base, options);
  }
}
