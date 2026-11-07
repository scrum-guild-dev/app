import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
import { connectionList } from '../../../../../shared/operations/connection/index.ts';
import type { PageLoad } from './$types';

// 接続の画面が使う値。読めなかったとき（通信、5xx）は connections が null で、画面は読み込みの失敗を出す。
// ワークスペースが見つからないとき（404、403）は枠が先に「見つからない」を出すので、ここでは同じ null にする。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）。
// `app:connections` は、登録と範囲の保存の後に、この画面の値だけを読み直す印（枠の load を走らせない）
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  depends('app:connections');
  const result = await callOperation(
    connectionList,
    { workspace_id: params.id },
    { slug: params.slug, fetcher: fetch },
  );
  if (isUnauthenticated(result)) redirect(307, loginUrl(url));
  return { connections: result.ok ? result.data.connections : null };
};
