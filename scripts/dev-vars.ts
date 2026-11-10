// pnpm dev と pnpm preview の起動時に、.dev.vars に .dev.vars.example の鍵が足りないかを見る（scripts/dev.ts が呼ぶ）。
// .dev.vars は git の外にあるので、.dev.vars.example に後から足した鍵が手元に届かず、
// /api/health の 503 などで初めて気づくことがある。比べるのは鍵の名前だけで、値は返さず、文にも入れない。
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// wrangler 同梱の dotenv 16.3.1（lib/main.js）の LINE を写す。
// dev-vars.test.ts で同梱の版と正規表現を照合する。更新で落ちたら同梱の parse を読み直し、
// 鍵の数え方とテスト、ここの版、docs/development.md の「ワークツリーで作業する」を見直す。
// （`KEY: value` の区切り、引用符で囲んだ複数行の値、`.` と `-` を含む鍵、行末の # のコメント）。# で始まる行は鍵にならない
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function devVarKeys(text: string): Set<string> {
  const keys = new Set<string>();
  // dotenv と同じく CRLF と CR を LF にそろえる。コロン直後の CRLF では、
  // 正規化しないと :\s+? が CR だけを消費し、次の行の値を別の鍵として数えてしまう。
  for (const match of text.replace(/\r\n?/g, '\n').matchAll(DOTENV_LINE)) keys.add(match[1]!);
  return keys;
}

// provided は .dev.vars を通さずに wrangler へ渡す鍵（scripts/dev.ts の --var）。足りない鍵に数えない
export function missingDevVarKeys(example: string, actual: string, provided: Iterable<string> = []): string[] {
  const have = devVarKeys(actual);
  for (const key of provided) have.add(key);
  return [...devVarKeys(example)].filter((key) => !have.has(key));
}

export function missingDevVarsMessage(missing: readonly string[]): string {
  return [
    `.dev.vars に、.dev.vars.example にある鍵が足りません: ${missing.join('、')}`,
    '本体の作業コピーで .dev.vars.example のその行を .dev.vars に足し、サーバーを立て直してください（docs/development.md の「ワークツリーで作業する」）',
  ].join('\n');
}

// node の型の除去（strip-only）は parameter property を受け付けないので、文だけを持つ
class UnreadableDevVarsError extends Error {
  constructor(file: string, code: string) {
    super(`${file} を読めませんでした（${code}）`);
  }
}

// 無いもの（壊れたリンクも ENOENT）と、通常のファイルでないもの（パイプやデバイスで起動が止まらないように）は読まない。
// CI の e2e は .dev.vars なしで立てる
function readIfFile(dir: string, file: string): string | undefined {
  const path = join(dir, file);
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (code === 'ENOENT') return undefined;
    // 理由のコードとファイルの名前だけを持ち、パスと中身は出さない
    throw new UnreadableDevVarsError(file, code);
  }
}

// dir は wrangler を起動するディレクトリ。wrangler はそこの .dev.vars を読む。
// 足りない鍵があれば警告の文を返す。どちらかが無いときは比べず、読めないときは起動を止めずにその旨を返す
export function checkDevVars(dir: string, provided: Iterable<string> = []): string | undefined {
  try {
    const example = readIfFile(dir, '.dev.vars.example');
    if (example === undefined) return undefined;
    const actual = readIfFile(dir, '.dev.vars');
    if (actual === undefined) return undefined;
    const missing = missingDevVarKeys(example, actual, provided);
    return missing.length > 0 ? missingDevVarsMessage(missing) : undefined;
  } catch (error) {
    if (!(error instanceof UnreadableDevVarsError)) throw error;
    return `${error.message}。鍵がそろっているかを確かめられません（ファイルの権限と、リンクの先を確かめてください）`;
  }
}
