// 自分用の組織を作るダイアログ（CreatePersonalOrganizationDialog.svelte）の、入力の確かめと失敗の振り分け。
// 入れるのは slug だけ（名前は固定の「自分用」）。規則と欄の文言は自分の組織を作るダイアログと同じ。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）
import type { ApiResult } from './api.ts';
import { createPersonalOrganizationConflictReasonOf } from '../shared/operations/organization/index.ts';
import { slugProblem } from '../shared/organization-slug.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export type CreatePersonalOrganizationField = 'slug' | 'form';
export type CreatePersonalOrganizationFailure = { field: CreatePersonalOrganizationField; key: DictionaryKey };
type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

// 送る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため）。slug は trim してから見る
export function validateCreatePersonalOrganization(input: { slug: string }): CreatePersonalOrganizationFailure | null {
  const slug = input.slug.trim();
  if (slug === '') return { field: 'slug', key: 'createMyOrganizationSlugRequired' };
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    return {
      field: 'slug',
      key: problem === 'format' ? 'createMyOrganizationSlugFormat' : 'createMyOrganizationSlugReserved',
    };
  }
  return null;
}

// 400 の details のうち、path が slug の項目の code
function slugCodeOf(result: FailedResult): string | undefined {
  const details = result.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const item of details as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    if ('path' in item && item.path === 'slug' && 'code' in item && typeof item.code === 'string') return item.code;
  }
  return undefined;
}

// 失敗を、どこにどの文言を出すかに写す。409 の slug_taken は slug の欄、personal_limit は枠（すでに自分用を持つ）。
// 400 の details の path が slug なら slug の欄に理由を出す。
// ログインが切れた（401）と、規約に同意していない（403 の terms_required）は、呼び出し側が画面ごと移すので、ここへ渡さない
export function createPersonalOrganizationFailure(result: FailedResult): CreatePersonalOrganizationFailure {
  const reason = createPersonalOrganizationConflictReasonOf(result.error?.details);
  if (reason === 'slug_taken') return { field: 'slug', key: 'createMyOrganizationSlugTaken' };
  if (reason === 'personal_limit') return { field: 'form', key: 'createPersonalOrganizationLimit' };
  if (result.status === 400) {
    const slugCode = slugCodeOf(result);
    if (slugCode !== undefined) {
      return {
        field: 'slug',
        key: slugCode === 'slug_reserved' ? 'createMyOrganizationSlugReserved' : 'createMyOrganizationSlugFormat',
      };
    }
    return { field: 'form', key: 'createMyOrganizationInvalid' };
  }
  if (result.status === 429) return { field: 'form', key: 'createMyOrganizationRateLimited' };
  return { field: 'form', key: 'createPersonalOrganizationFailed' };
}
