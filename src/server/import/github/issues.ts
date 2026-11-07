// 担当の Issue を1頁取り、取り込み元を問わない形（ImportItem）に変える。DB には書かない（書くのは同期の仕組み）。
// リポジトリごとの Issue の一覧（GET /repositories/{id}/issues）を、更新日時の古い順に取る。
// リポジトリの ID で呼ぶので、リポジトリの改名や移動に影響されない。一覧の API には検索 API の「1,000件まで」の上限が無い
// （検索 API を選ばなかった理由は docs/development.md の「取り込み元の型と GitHub の PAT」）。
// 通信の作法と失敗の区別は client.ts（401、403、それ以外）。
//
// 続きの位置（不透明な文字列）は「自分のログイン名:頁:更新日時の起点」。満杯の頁の後は、頁番号を進めず、
// 最後に読んだ項目の更新日時を新しい起点（since）にして頁を1に戻す。昇順の頁番号のまま進めると、
// 取得の間に読み終えた側の項目が更新されて末尾へ動いたとき、後ろの項目が詰まって取りこぼすため。
// GitHub の since が境界を含むかは文書で確かめられないので、起点は1秒戻して送る（更新日時は秒の精度）。
// 境目の項目は重なる（同期の仕組みが sourceId で二重の取り込みを防ぐ）。
// 同じ更新日時が1頁を超えて続くときだけ、起点を変えずに頁番号を進める。
//
// 「自分」は、接続の設定に `login` があればそれを使い、無ければ最初の頁で GET /user から読んで続きの位置に入れる
// （続きの頁では問い合わせ直さない）。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import type { FetchPageInput, FetchPageResult, ImportItem, ScopeCandidate } from '../source.ts';
import { FULL_NAME_PATTERN, LOGIN_PATTERN, PAGE_SIZE, fail, getJson, idOf, isRecord } from './client.ts';

const USER_URL = 'https://api.github.com/user';
const SCOPE_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const CURSOR_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]{0,79}):([1-9][0-9]{0,5}):(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)?$/;
const ISSUE_URL_PATH = /^\/[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}\/issues\/[1-9][0-9]{0,15}$/;
// 頁の番号の上限。超えるまで同じ更新日時の満杯が続くときは断る（回り続けないため）
const MAX_PAGE = 1000;
// GitHub の Issue の題の上限は256文字。超える応答は想定外として断る
const MAX_TITLE_LENGTH = 256;
const MAX_URL_LENGTH = 300;

function invalidArgument(): never {
  // 呼び出す側の誤り。認証情報の失敗とは区別する
  throw new TypeError('担当の Issue の取得の入力が不正');
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string') throw fail('unavailable');
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw fail('unavailable');
  return new Date(time).toISOString();
}

function sameLogin(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isAssignedTo(item: Record<string, unknown>, login: string): boolean {
  if (isRecord(item.assignee) && sameLogin(item.assignee.login, login)) return true;
  return Array.isArray(item.assignees) && item.assignees.some((a) => isRecord(a) && sameLogin(a.login, login));
}

// Issue の URL（https://github.com/owner/repo/issues/番号）から `owner/repo#番号` を作る。形が違えば null。
// 改名や移動の後も、応答の URL が今の名前を指すので、キーは範囲の名前ではなく URL から作る。
// 保存する URL も、検証した部品から組み立て直す（userinfo や空白の混入を通さない）
function partsOfIssueUrl(url: string): { key: string; url: string; number: string } | null {
  if (url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  if (!ISSUE_URL_PATH.test(parsed.pathname)) return null;
  const [, owner, repo, , number] = parsed.pathname.split('/');
  return {
    key: `${owner}/${repo}#${number}`,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    number: number!,
  };
}

// null は、返さない項目（PR、閉じた Issue、担当が他人）
function convert(raw: unknown, scope: ScopeCandidate, login: string): ImportItem | null {
  if (!isRecord(raw)) throw fail('unavailable');
  // 一覧は PR も返す。PR は次のストーリーで扱う
  if (raw.pull_request !== undefined) return null;
  if (raw.state !== 'open' && raw.state !== 'closed') throw fail('unavailable');
  if (raw.state !== 'open') return null;
  if (!isAssignedTo(raw, login)) return null;

  const id = idOf(raw.id);
  const number = idOf(raw.number);
  const { title, html_url: rawUrl } = raw;
  // 文字数はコードポイントで数える（絵文字など BMP 外の文字は String.length で2と数えられるため）
  if (typeof title !== 'string' || title.length === 0 || [...title].length > MAX_TITLE_LENGTH) {
    throw fail('unavailable');
  }
  const parts = typeof rawUrl === 'string' ? partsOfIssueUrl(rawUrl) : null;
  // URL の番号と応答の番号が食い違う応答は断る
  if (parts === null || parts.number !== number) throw fail('unavailable');

  let dueOn: string | null = null;
  if (isRecord(raw.milestone) && raw.milestone.due_on !== null && raw.milestone.due_on !== undefined) {
    dueOn = isoOf(raw.milestone.due_on).slice(0, 10);
  }
  return {
    kind: 'issue',
    // 不変の ID は GitHub の ID。番号は移動で変わるので使わない
    sourceId: id,
    reviewerSourceId: '',
    key: parts.key,
    url: parts.url,
    title,
    containerId: scope.id,
    containerName: scope.name,
    status: 'open',
    dueOn,
    updatedAt: isoOf(raw.updated_at),
    isDone: false,
  };
}

type Position = { login: string | null; page: number; anchor: string | null };

function parseCursor(cursor: string | null): Position {
  if (cursor === null) return { login: null, page: 1, anchor: null };
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) invalidArgument();
  const page = Number(match[2]);
  if (page > MAX_PAGE) invalidArgument();
  return { login: match[1]!, page, anchor: match[3] ?? null };
}

async function loginOf(input: FetchPageInput): Promise<string> {
  const fromSettings = input.settings['login'];
  if (typeof fromSettings === 'string' && LOGIN_PATTERN.test(fromSettings)) return fromSettings;
  const body = await getJson(USER_URL, input.credential, input.fetcher);
  if (!isRecord(body) || typeof body.login !== 'string' || !LOGIN_PATTERN.test(body.login)) throw fail('unavailable');
  return body.login;
}

function urlOf(scope: ScopeCandidate, assignee: string, since: string | null, page: number): string {
  const query = new URLSearchParams({
    state: 'open',
    assignee,
    sort: 'updated',
    direction: 'asc',
    per_page: String(PAGE_SIZE),
    page: String(page),
  });
  if (since !== null) query.set('since', since);
  return `https://api.github.com/repositories/${scope.id}/issues?${query.toString()}`;
}

export async function fetchAssignedIssuesPage(input: FetchPageInput): Promise<FetchPageResult> {
  const { scope } = input;
  if (!SCOPE_ID_PATTERN.test(scope.id) || !FULL_NAME_PATTERN.test(scope.name)) invalidArgument();
  const position = parseCursor(input.cursor);
  const login = position.login ?? (await loginOf(input));
  const { page, anchor } = position;

  // 読んだ項目から決めた起点は、1秒戻して送る（境界を含まない動きでも、起点ちょうどの項目を取りこぼさない）
  const since = anchor === null ? null : new Date(Date.parse(anchor) - 1000).toISOString();
  const body = await getJson(urlOf(scope, login, since, page), input.credential, input.fetcher);
  if (!Array.isArray(body)) throw fail('unavailable');

  // 境目の項目が重なるので、1頁の中では sourceId で除く（後に読んだ方を残す）
  const found = new Map<string, ImportItem>();
  for (const raw of body as unknown[]) {
    const item = convert(raw, scope, login);
    if (item !== null) found.set(item.sourceId, item);
  }
  const items = [...found.values()];
  if (body.length < PAGE_SIZE) return { items, next: null };

  const last: unknown = body[body.length - 1];
  if (!isRecord(last)) throw fail('unavailable');
  const lastUpdated = isoOf(last.updated_at);
  if (lastUpdated === anchor) {
    // 同じ更新日時が1頁を超えて続いている
    if (page + 1 > MAX_PAGE) throw fail('unavailable');
    return { items, next: `${login}:${page + 1}:${anchor}` };
  }
  return { items, next: `${login}:1:${lastUpdated}` };
}
