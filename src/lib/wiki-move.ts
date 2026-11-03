import type { WikiNode } from '../shared/operations/wiki/index.ts';

export function wikiAncestorIds(pages: readonly WikiNode[], parentId: string | null): string[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const found: string[] = [];
  let id = parentId;
  while (id !== null && !found.includes(id) && found.length < 10) {
    const page = byId.get(id);
    if (!page) break;
    found.push(id);
    id = page.parent_id;
  }
  return found;
}

// 木の表示順を保ち、移す部分木の高さも含めた候補を作る。APIも書込み時に検査する。
export function wikiMoveOptions(pages: readonly WikiNode[], movingId: string) {
  const children = new Map<string | null, WikiNode[]>();
  for (const page of pages) {
    const siblings = children.get(page.parent_id) ?? [];
    siblings.push(page);
    children.set(page.parent_id, siblings);
  }
  const excluded = new Set<string>();
  let height = 1;
  const subtree = [{ id: movingId, depth: 1 }];
  while (subtree.length) {
    const item = subtree.pop()!;
    if (excluded.has(item.id)) continue;
    excluded.add(item.id);
    height = Math.max(height, item.depth);
    if (item.depth < 10)
      for (const child of children.get(item.id) ?? []) subtree.push({ id: child.id, depth: item.depth + 1 });
  }
  const result: { id: string; title: string; depth: number; disabled: boolean }[] = [];
  const stack = (children.get(null) ?? []).toReversed().map((page) => ({ page, depth: 1 }));
  const seen = new Set<string>();
  while (stack.length) {
    const { page, depth } = stack.pop()!;
    if (seen.has(page.id) || excluded.has(page.id)) continue;
    seen.add(page.id);
    result.push({ id: page.id, title: page.title, depth, disabled: depth + height > 10 });
    if (depth < 10)
      for (const child of (children.get(page.id) ?? []).toReversed()) stack.push({ page: child, depth: depth + 1 });
  }
  return result;
}
