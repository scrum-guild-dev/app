import { redirectOrganizationReauth } from './login-redirect.ts';
import { isErrorBody, type ErrorBody } from '../shared/errors.ts';
import { isHealth, type Health } from '../shared/health.ts';
import {
  operationPath,
  type AnyOperationDefinition,
  type InputOf,
  type OutputOf,
  type OutsideOperationDefinition,
} from '../shared/operations/define.ts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ErrorBody['error'] | null };

type CallOptions = { fetcher?: typeof fetch };

// 組織の中の操作は slug を要る。組織の外の操作は要らない
type CallArguments<D extends AnyOperationDefinition> = D extends OutsideOperationDefinition
  ? [options?: CallOptions]
  : [options: CallOptions & { slug: string }];

const NOT_JSON = Symbol('not-json');

const UNREACHABLE = { ok: false, status: 0, error: null } as const;

// 読み取りの応答を待つ既定の上限。超えたら通信の失敗（status 0）にし、画面は読み込み中のまま止まらず失敗の表示を出す
export const READ_TIMEOUT_MS = 10_000;

// 書き込みは打ち切らない（null）。サーバーで済んだ書き込みを画面が失敗と出すと、利用者が同じ操作を重ねてしまう
function timeoutFor(definition: AnyOperationDefinition): number | null {
  if (definition.mode !== 'read') return null;
  return definition.clientTimeoutMs ?? READ_TIMEOUT_MS;
}

// 操作を呼ぶ。入力の型は定義の入力のスキーマの入力側、出力の型は出力のスキーマの出力側（変換を通した後）から決まる。
// 応答が JSON でなければ失敗として扱う（転送が効かず index.html が返ったときなど）。
// 読み取りは本文を読み終えるまでを上限で打ち切る（頭だけ返って本文が詰まった応答も終わらせるため）
export async function callOperation<D extends AnyOperationDefinition>(
  definition: D,
  input: InputOf<D>,
  ...[options]: CallArguments<D>
): Promise<ApiResult<OutputOf<D>>> {
  const fetcher = options?.fetcher ?? fetch;
  const slug = options !== undefined && 'slug' in options ? options.slug : undefined;
  const limit = timeoutFor(definition);
  const controller = limit === null ? null : new AbortController();
  const timer = limit === null ? undefined : setTimeout(() => controller?.abort(), limit);
  let res: Response;
  let body: unknown;
  try {
    res = await fetcher(operationPath(definition, slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
    body = await res.json().catch(() => NOT_JSON);
  } catch {
    return UNREACHABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // 本文を読む途中で打ち切ると、json() の失敗として NOT_JSON に落ちる。応答の status ではなく通信の失敗にする
  if (body === NOT_JSON && controller?.signal.aborted === true) return UNREACHABLE;
  // サーバーが出力のスキーマで検証し、変換まで済ませた値を返す。ここで同じスキーマに通し直すと、変換が二重に掛かる
  if (res.ok && body !== NOT_JSON) return { ok: true, data: body as OutputOf<D> };
  const error = isErrorBody(body) ? body.error : null;
  redirectOrganizationReauth(slug, res.status, error?.code);
  return { ok: false, status: res.status, error };
}

export async function getHealth(fetcher: typeof fetch = fetch): Promise<ApiResult<Health>> {
  const res = await fetcher('/api/health');
  const body: unknown = await res.json().catch(() => null);
  // 200 でも形が違えば失敗として扱う（転送が効かず index.html が返ったときなど）
  if (res.ok && isHealth(body)) return { ok: true, data: body };
  return { ok: false, status: res.status, error: isErrorBody(body) ? body.error : null };
}
