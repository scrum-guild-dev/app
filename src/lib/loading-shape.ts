// 読み込み中の骨組み（LoadingSheet と、最初の読み込みの #boot-loading）の形を、行き先の画面から決める。
// 枠の外の画面（ログイン、組織の選択、届いた招待など）は紙の形（null）。組織の枠の中は、行き先の本文の組みに近い形を選ぶ。
// 最初の読み込みの static/boot-shape.js は import できないので、同じ対応を URL から持つ（scripts/boot-shape.test.ts が突き合わせる）
export const loadingShapes = ['today', 'aside', 'tree', 'board', 'plan', 'list', 'settings', 'wiki', 'task'] as const;
export type LoadingShape = (typeof loadingShapes)[number];

// route.id ごとの形。組織の枠の中の画面はすべて載せる（scripts/boot-shape.test.ts が確かめる）。載っていないものは紙の形
const byRoute: Record<string, LoadingShape | null> = {
  // 今日やること: 本文だけの1列（右の脇は無い）
  '/[slug]': 'today',
  '/[slug]/admin': 'settings',
  // マイプロフィール: 設定の節と右の脇（レベルの欄）の2列
  '/[slug]/me': 'aside',
  // 届いた招待は、組織に入れる人にも枠を出さない紙の画面
  '/[slug]/invitations': null,
  '/[slug]/wiki': 'wiki',
  '/[slug]/wiki/[pageId]': 'wiki',
  '/[slug]/w/[id]': 'tree',
  '/[slug]/w/[id]/connections': 'list',
  '/[slug]/w/[id]/epics/[epicId]': 'aside',
  '/[slug]/w/[id]/inbox': 'list',
  '/[slug]/w/[id]/members': 'list',
  '/[slug]/w/[id]/plan': 'plan',
  '/[slug]/w/[id]/settings': 'settings',
  '/[slug]/w/[id]/sprint': 'board',
  '/[slug]/w/[id]/tasks/[taskId]': 'task',
  '/[slug]/w/[id]/wiki': 'wiki',
  '/[slug]/w/[id]/wiki/[pageId]': 'wiki',
};

export function loadingShape(routeId: string | null | undefined): LoadingShape | null {
  if (!routeId) return null;
  return byRoute[routeId] ?? null;
}

// 見出しの右に操作のボタン（ページを足す、スプリントを作る）が並ぶ形
export function loadingShapeHasActions(shape: LoadingShape): boolean {
  return shape === 'plan' || shape === 'wiki';
}

// 形ごとの帯の数。LoadingSheet がこの数で並べ、最初の読み込みの static/boot-shape.js は同じ数を写す
// （import できないので、scripts/boot-shape.test.ts がこの値と突き合わせる）
export const loadingShapeCounts = {
  treeSelects: 4,
  treeRows: 8,
  boardColumns: 4,
  planLanes: 3,
  settingSections: 3,
  taskButtons: 4,
  taskFields: 6,
  listRows: 6,
} as const;
