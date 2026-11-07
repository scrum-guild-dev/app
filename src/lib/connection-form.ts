// 接続の画面（connections/+page.svelte）の、登録・範囲の候補・範囲の保存の失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）。文言は言葉の辞書から出す
import type { ApiResult } from './api.ts';
import { CONNECTION_NAME_MAX_LENGTH, connectionNameProblem } from '../shared/operations/connection/index.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

export type ConnectionField = 'name' | 'credential' | 'form';
export type ConnectionFailure = { field: ConnectionField; key: DictionaryKey };

// 送る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため）。形の検査は取り込み元の型が行うので、
// ここでは認証情報が空かどうかだけを見る
export function validateConnectionCreate(input: { name: string; credential: string }): ConnectionFailure | null {
  const name = input.name.trim();
  if (name === '') return { field: 'name', key: 'connectionNameRequired' };
  if (connectionNameProblem(name) !== null) return { field: 'name', key: 'connectionNameTooLong' };
  if (input.credential.trim() === '') return { field: 'credential', key: 'connectionCredentialRequired' };
  return null;
}

export const CONNECTION_NAME_LIMIT = CONNECTION_NAME_MAX_LENGTH;

// 400 の details のうち、path が引数の項目の code
function codeOf(result: FailedResult, path: string): string | undefined {
  const details = result.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const item of details as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    if ('path' in item && item.path === path && 'code' in item && typeof item.code === 'string') return item.code;
  }
  return undefined;
}

// 登録（connection-create）の失敗。400 は認証情報の形（credential_shape）と取り込み元が受け付けなかった（credential_rejected）で、
// どちらも登録されず、認証情報の欄に理由を出す。届かない（503、通信できない）は何も登録されていないので、もう一度試せる。
// 409 の workspace_closed と connection_limit は枠に出す。ログインが切れた（401）は呼び出し側が画面ごと移すので、ここへ渡さない
export function connectionCreateFailure(result: FailedResult): ConnectionFailure {
  if (result.status === 400) {
    const code = codeOf(result, 'credential');
    if (code === 'credential_shape') return { field: 'credential', key: 'connectionCredentialShape' };
    if (code === 'credential_rejected') return { field: 'credential', key: 'connectionCredentialRejected' };
    if (codeOf(result, 'name') !== undefined) return { field: 'name', key: 'connectionNameTooLong' };
    return { field: 'form', key: 'connectionCreateInvalid' };
  }
  if (result.error?.code === 'workspace_closed') return { field: 'form', key: 'connectionWorkspaceClosed' };
  if (result.status === 409) return { field: 'form', key: 'connectionLimit' };
  if (result.status === 429) return { field: 'form', key: 'connectionRateLimited' };
  if (result.status === 0 || result.status === 503) return { field: 'form', key: 'connectionUnreachable' };
  return { field: 'form', key: 'connectionCreateFailed' };
}

// 範囲の候補（connection-scope-candidates）と保存（connection-scopes-save）の失敗。
// 候補の 409（credential_rejected）は、保存した認証情報を取り込み元が受け付けなくなったこと
export function connectionScopeFailure(result: FailedResult): DictionaryKey {
  if (result.error?.code === 'workspace_closed') return 'connectionWorkspaceClosed';
  if (result.status === 409) return 'connectionScopeRejected';
  if (result.status === 403 || result.status === 404) return 'connectionScopeGone';
  if (result.status === 400) return 'connectionScopeInvalid';
  if (result.status === 429) return 'connectionRateLimited';
  if (result.status === 0 || result.status === 503) return 'connectionUnreachable';
  return 'connectionScopeFailed';
}
