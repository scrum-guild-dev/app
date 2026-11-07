// 担当の Issue を取り、取り込み元を問わない形（ImportedItem）に変える。DB には書かない。
// リポジトリごとの Issue の一覧（GET /repositories/{id}/issues）を、更新日時の古い順に頁送りで取る。
// リポジトリの ID で呼ぶので、リポジトリの改名や移動に影響されない。一覧の API には検索 API の「1,000件まで」の上限が無い
// （検索 API を選ばなかった理由は docs/development.md の「取り込み元の型と GitHub の PAT」）。
// 通信の作法と失敗の区別は client.ts（401、403、それ以外）。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import type { FetchAssignedParams, FetchAssignedResult, ImportedItem, ScopeCandidate } from '../source.ts';
import { fail, getJson, idOf, isRecord } from './client.ts';

const PAGE_SIZE = 100;
const SCOPE_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CURSOR_PATTERN = /^([0-9]{1,6}):([1-9][0-9]{0,5})$/;
const HTML_URL_PREFIX = 'https://github.com/';
// 頁の番号の上限。超えるまで満杯が続くときは断る（回り続けないため）
const MAX_PAGE = 100_000;

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

// null は、返さない項目（PR、閉じた Issue、担当が他人）
function convert(raw: unknown, scope: ScopeCandidate, login: string): ImportedItem | null {
  if (!isRecord(raw)) throw fail('unavailable');
  // 一覧は PR も返す。PR は次のストーリーで扱う
  if (raw.pull_request !== undefined) return null;
  if (raw.state !== 'open' && raw.state !== 'closed') throw fail('unavailable');
  if (raw.state !== 'open') return null;
  if (!isAssignedTo(raw, login)) return null;

  const id = idOf(raw.id);
  const number = idOf(raw.number);
  const { title, html_url: url } = raw;
  if (typeof title !== 'string' || title.length === 0) throw fail('unavailable');
  if (typeof url !== 'string' || !url.startsWith(HTML_URL_PREFIX)) throw fail('unavailable');

  let dueAt: string | null = null;
  if (isRecord(raw.milestone) && raw.milestone.due_on !== null && raw.milestone.due_on !== undefined) {
    dueAt = isoOf(raw.milestone.due_on);
  }
  return {
    kind: 'issue',
    // 不変の ID は GitHub の ID。番号は移動で変わるので使わない
    externalId: id,
    key: `${scope.name}#${number}`,
    url,
    scopeId: scope.id,
    scopeName: scope.name,
    state: 'open',
    dueAt,
    updatedAt: isoOf(raw.updated_at),
    title,
    completed: false,
  };
}

function validate(params: FetchAssignedParams): { repo: number; page: number } {
  if (!LOGIN_PATTERN.test(params.assignee)) invalidArgument();
  if (!Number.isSafeInteger(params.maxRequests) || params.maxRequests < 1) invalidArgument();
  if (params.since !== null && Number.isNaN(Date.parse(params.since))) invalidArgument();
  for (const scope of params.scopes) {
    if (!SCOPE_ID_PATTERN.test(scope.id) || !FULL_NAME_PATTERN.test(scope.name)) invalidArgument();
  }
  if (params.cursor === null) return { repo: 0, page: 1 };
  const match = CURSOR_PATTERN.exec(params.cursor);
  if (match === null) invalidArgument();
  const repo = Number(match[1]);
  const page = Number(match[2]);
  if (repo >= params.scopes.length || page > MAX_PAGE) invalidArgument();
  return { repo, page };
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
  if (since !== null) query.set('since', new Date(since).toISOString());
  return `https://api.github.com/repositories/${scope.id}/issues?${query.toString()}`;
}

export async function fetchAssignedIssues(
  credential: string,
  params: FetchAssignedParams,
  fetcher: typeof fetch,
): Promise<FetchAssignedResult> {
  let { repo, page } = validate(params);
  const items: ImportedItem[] = [];
  let requests = 0;
  while (repo < params.scopes.length) {
    // 上限に達したら、次の要求の位置を返す
    if (requests >= params.maxRequests) return { items, nextCursor: `${repo}:${page}` };
    const scope = params.scopes[repo]!;
    const body = await getJson(urlOf(scope, params.assignee, params.since, page), credential, fetcher);
    requests++;
    if (!Array.isArray(body)) throw fail('unavailable');
    for (const raw of body as unknown[]) {
      const item = convert(raw, scope, params.assignee);
      if (item !== null) items.push(item);
    }
    if (body.length < PAGE_SIZE) {
      repo++;
      page = 1;
    } else {
      page++;
      if (page > MAX_PAGE) throw fail('unavailable');
    }
  }
  return { items, nextCursor: null };
}
