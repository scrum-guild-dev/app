// ストーリーの引き出し（StoryDrawer）が、画面の枠から受け取る値の組み立て。
// 引き出しはワークスペースの枠（+layout.svelte）が置くので、バックログの画面が読んだ木（page.data.tree）から、
// 開いたストーリーの完了の状態と、親に選べるエピックを取り出す。木に無い（絞り込みで外れた、別の画面で開いた）ときは null で、
// 引き出しは完了の操作と親を移すを出さない（story-get は完了の状態を返さないため）。

type TreeStoryLike = { id: string; completed_at: string | null; open_task_count: number };
type TreeEpicLike = {
  completed_at: string | null;
  canceled_at: string | null;
  stories: readonly TreeStoryLike[];
};
export type StoryTreeLike = {
  epics: readonly TreeEpicLike[];
  stories: readonly TreeStoryLike[];
  choices: { epics: readonly { id: string; title: string; finished: boolean }[] };
};

export type StoryTree = StoryTreeLike & { today: string; week_start: number };

// ページのデータ（page.data）から、バックログの木を取り出す。木の形でなければ（ほかの画面のデータ、読めなかった）null
export function storyTreeOf(data: unknown): StoryTree | null {
  if (typeof data !== 'object' || data === null) return null;
  const tree = (data as { tree?: unknown }).tree;
  if (typeof tree !== 'object' || tree === null) return null;
  const candidate = tree as Partial<Record<keyof StoryTree, unknown>> & { choices?: { epics?: unknown } };
  if (
    !Array.isArray(candidate.epics) ||
    !Array.isArray(candidate.stories) ||
    !Array.isArray(candidate.choices?.epics) ||
    typeof candidate.today !== 'string' ||
    typeof candidate.week_start !== 'number'
  ) {
    return null;
  }
  return tree as StoryTree;
}

export type StoryFacts = {
  // 完了した日時。完了していなければ null
  completedAt: string | null;
  // 配下の未完了のタスクの件数（絞っても全体の値）
  openTasks: number;
  // 親のエピックが完了か中止している（完了も取り消しも必ず断られる）
  parentFinished: boolean;
};

export function storyFactsOf(tree: StoryTreeLike | null | undefined, storyId: string): StoryFacts | null {
  if (tree === null || tree === undefined) return null;
  const alone = tree.stories.find((story) => story.id === storyId);
  if (alone !== undefined) {
    return { completedAt: alone.completed_at, openTasks: alone.open_task_count, parentFinished: false };
  }
  for (const epic of tree.epics) {
    const story = epic.stories.find((row) => row.id === storyId);
    if (story !== undefined) {
      return {
        completedAt: story.completed_at,
        openTasks: story.open_task_count,
        parentFinished: epic.completed_at !== null || epic.canceled_at !== null,
      };
    }
  }
  return null;
}

// ストーリーの親に選べるエピック（完了も中止もしていないもの）。木が無いときは null（親を移すを出さない）
export function parentChoicesOf(tree: StoryTreeLike | null | undefined): { id: string; title: string }[] | null {
  if (tree === null || tree === undefined) return null;
  return tree.choices.epics.filter((epic) => !epic.finished).map((epic) => ({ id: epic.id, title: epic.title }));
}

// 409 の stale の details から、今の値の組を取り出す。stale でなければ null
export function staleCurrentOf(details: unknown): Record<string, unknown> | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as { reason?: unknown; current?: unknown };
  if (record.reason !== 'stale' || typeof record.current !== 'object' || record.current === null) return null;
  return record.current as Record<string, unknown>;
}
