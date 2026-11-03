// Markdown の絶対 URL のうち、今の Wiki のページだけを同じタブで開く。
export function isWikiPageLink(href: string, prefix?: string): boolean {
  if (!prefix || !href.startsWith(prefix)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?#].*)?$/.test(href.slice(prefix.length));
}
