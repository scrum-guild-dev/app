// 接続（取り込み元の登録）の共通の値。登録の操作と、一覧・範囲の操作が同じ値を使う（docs/requirements.md の「取り込み」）。
// 画面の束にも入るので、Worker のコードを引かない。取り込み元に固有の値（PAT の形など）は持たない
import { z } from 'zod';
import '../../zod-config.ts';
import { idSchema } from '../../id.ts';
import { shortTextProblem, type ShortTextProblem } from '../../text-rules.ts';

// 表示名は前後の空白を除いて 1〜50 字（コードポイントで数える）
export const CONNECTION_NAME_MAX_LENGTH = 50;
export type ConnectionNameProblem = ShortTextProblem;

export function connectionNameProblem(name: string): ConnectionNameProblem | null {
  return shortTextProblem(name, CONNECTION_NAME_MAX_LENGTH);
}

export const connectionNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = connectionNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `接続の表示名が使えない（${problem}）` });
  });

// 取り込み元の種類を指す文字列。値の一覧は取り込み元の型の表（サーバー）が持ち、ここでは形だけを見る
export const connectionProviderSchema = z.string().min(1).max(40);

// 認証情報の入力の上限。形の検査は取り込み元の型が行う（この上限は、桁違いに長い値を型に渡す前に止めるだけ）
export const CONNECTION_CREDENTIAL_MAX_LENGTH = 512;
export const connectionCredentialSchema = z.string().max(CONNECTION_CREDENTIAL_MAX_LENGTH);

// 1人が1つのワークスペースに登録できる接続の数の上限。超える登録は 409（conflict、details.reason は connection_limit）
export const CONNECTIONS_PER_MEMBER_MAX = 20;

// 1接続に選べる範囲の数の上限。保存は D1 の束縛の上限に収まる数の文に分ける
export const CONNECTION_SCOPES_MAX = 200;

// 接続の一覧と登録・範囲の保存が返す形。暗号文・鍵の版・同期の状態は含めない。認証情報は末尾4文字（credential_last4）だけ
export const connectionSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  provider: z.string(),
  name: z.string(),
  status: z.enum(['active', 'error', 'stopped']),
  stopped_reason: z.string().nullable(),
  scope_mode: z.enum(['include', 'exclude']),
  scopes: z.array(z.object({ id: z.string(), name: z.string() })),
  credential_last4: z.string().nullable(),
  owner_user_id: z.string(),
  owner_name: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_error_message: z.string().nullable(),
  last_error_at: z.string().nullable(),
  consecutive_failures: z.number().int(),
  created_at: z.string(),
});
export type Connection = z.output<typeof connectionSchema>;

// 取り込み元が認証情報を受け付けなかったときの理由（400 の details の code）。画面は文言を辞書から出す
export type ConnectionCreateProblem = 'credential_shape' | 'credential_rejected' | 'provider_unknown';

export const connectionIdInput = z.object({ workspace_id: idSchema, connection_id: idSchema });
