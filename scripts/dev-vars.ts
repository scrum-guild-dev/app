// pnpm dev と pnpm preview の起動時に、.dev.vars に .dev.vars.example の鍵が足りないかを見る（scripts/dev.ts が呼ぶ）。
// .dev.vars は git の外にあるので、.dev.vars.example に後から足した鍵が手元に届かず、
// /api/health の 503 などで初めて気づくことがある。比べるのは鍵の名前だけで、値は返さず、文にも入れない。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 行頭（空白と export は許す）の NAME= だけを鍵に数える。# で始まる行（任意の鍵の例）は数えない
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function devVarKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const key = KEY_LINE.exec(line)?.[1];
    if (key) keys.add(key);
  }
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

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // 無いファイル（壊れたリンクも ENOENT）は比べない。CI の e2e は .dev.vars なしで立てる
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// dir は wrangler を起動するディレクトリ。wrangler はそこの .dev.vars を読む。
// 警告の文を返す（足りなければ）。.dev.vars か .dev.vars.example が無いときと、読めないときは比べない
export function checkDevVars(dir: string, provided: Iterable<string> = []): string | undefined {
  let example: string | undefined;
  let actual: string | undefined;
  try {
    example = readIfExists(join(dir, '.dev.vars.example'));
    actual = readIfExists(join(dir, '.dev.vars'));
  } catch (error) {
    // 起動を止めない。理由（権限など）のコードだけを出し、中身は出さない
    return `.dev.vars を読めず、鍵がそろっているかを確かめられませんでした（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）`;
  }
  if (example === undefined || actual === undefined) return undefined;
  const missing = missingDevVarKeys(example, actual, provided);
  return missing.length > 0 ? missingDevVarsMessage(missing) : undefined;
}
