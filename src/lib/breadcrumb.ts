// 上の帯のパンくずの材料。ワークスペースの画面の経路（/<slug>/w/<ID>/...）から ID を取り出す。
// 組織の画面（/<slug>/...）では null で、パンくずにワークスペースを出さない。見本は design/kit.js の breadcrumbHtml
export function workspaceIdOf(path: string): string | null {
  const match = /^\/[^/]+\/w\/([^/]+)/.exec(path);
  return match ? match[1] : null;
}

// メニューに無い組織の画面（アカウントのメニューから開く画面）の名前。画面の名前は辞書の語で返すため、キーで返す
export function accountScreenKey(path: string, slug: string): 'pageMe' | 'pageOrgAdmin' | null {
  if (path === `/${slug}/me`) return 'pageMe';
  if (path === `/${slug}/admin` || path.startsWith(`/${slug}/admin/`)) return 'pageOrgAdmin';
  return null;
}
