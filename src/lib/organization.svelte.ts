import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationInfo } from '../shared/operations/organization/index.ts';
import { setTheme } from './theme.svelte.ts';

export type OrganizationView = OutputOf<typeof organizationInfo>;

// 組織の操作の結果を画面に当てる。テーマは自分で選んだ値（選んでいなければ simple）。
// localStorage に書き直すので、次の描画の前に同じ値が当たる。
// 承諾待ちの招待だけの人の招待の画面は、この組織の自分のテーマが無いので、テーマを替えない（今当たっているまま）
export function applyOrganization(view: OrganizationView): void {
  setTheme(view.me.theme);
}

// 組織の外の画面（組織の選択、見つからない、読み込みの失敗、運用）の既定。どの組織の値も持ち越さない。
// テーマは属性なし（シンプル（自動））にして、覚えたテーマも消す
export function resetToDefaults(): void {
  setTheme(null);
}
