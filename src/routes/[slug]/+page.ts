import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
import { firstSteps, today } from '../../shared/operations/organization/index.ts';
import type { PageLoad } from './$types';

// today が null のときは読めなかったこと（空の一覧とは別）で、画面は読み込みの失敗を出す。
// firstSteps は today とは別の操作で、画面が2回呼ぶ。null（読めなかった）のときと、手順が空のときは、最初にやることの面を置かない
export const load: PageLoad = async ({ params, fetch, url, depends }) => {
  // 印の付け外し、完了、戻すの後に、今日の読み取りと最初にやることを読み直す
  depends('app:today');
  const [todayResult, firstStepsResult] = await Promise.all([
    callOperation(today, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(firstSteps, {}, { slug: params.slug, fetcher: fetch }),
  ]);
  if (isUnauthenticated(todayResult) || isUnauthenticated(firstStepsResult)) redirect(307, loginUrl(url));
  return {
    today: todayResult.ok ? todayResult.data : null,
    firstSteps: firstStepsResult.ok ? firstStepsResult.data : null,
  };
};
