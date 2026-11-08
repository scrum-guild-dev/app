import { sameFilter, type BacklogFilter } from './backlog-filter.ts';

// 画面で足したタスクの行を、読み直しのあとも残すか。木の画面（`src/routes/[slug]/w/[id]/+page.svelte`）が使う。
// at は足した時刻、loadedAt は読み直しを始めた時刻（どちらも performance.now()）。
// - 完了にした行と、読み直した木に入った行は捨てる（木が持つので、足した行は要らない）
// - 木に無い行は、足した後に始まった読み直しの木なら捨てる（別の人の削除か、親ごとの消失。サーバーの今を返している）
// - 足す前に始まった読み直しが遅れて届いた木なら残す（作った行が木に無いのは当たり前）。同じ時刻も残す側に倒す（時刻の粒度が粗い環境の対策）
// - 木を読めていない（treeLoaded が偽）ときは、木に無いと言えないので残す
export function keepAddedRow(
  row: { at: number },
  state: { inLoadedTree: boolean; completed: boolean; treeLoaded: boolean; loadedAt: number },
): boolean {
  if (state.completed || state.inLoadedTree) return false;
  return !state.treeLoaded || row.at >= state.loadedAt;
}

// 完了にした行の印（と、画面で足した完了の行）を、読み直しのあとも残すか。at は完了の応答が返った時刻、loadedAt は読み直しを始めた時刻。
// - 完了の応答が返った後に始まった読み直しの木は、完了を含む。印は捨てる（木が持つ）
// - 応答より前に始まった読み直しが遅れて届いた木は、完了を含むとは限らない（含んでいれば行が外れ、含まなければ未完了で戻る）。印も行も残す
// - 同じ時刻も残す側に倒す（時刻の粒度が粗い環境の対策）
export function completionSettled(at: number, loadedAt: number): boolean {
  return loadedAt > at;
}

// 読み直した木へ、足した行と完了の印を持ち越してよいか。同じワークスペースで、前の木と同じ絞り込みの木だけ持ち越す。
// - 絞り込みの条件が替わった読み直しの木は別の条件の木なので、木に入らない行が残り続けないよう、印も行も捨てる
// - 同じ絞り込みのまま遅れて届いた木は、絞っていても絞っていなくても同じ競合（completionSettled）なので、持ち越しの判定に進める
// - 条件が替わる読み直しの最中に完了にした印は、遅れて届いた木に対して捨てる（窓は狭く、次の読み直しで直る。許容するトレードオフ）
// previous は前に読んだ木の絞り込み（まだ読んでいなければ undefined）
export function carriesOver(previous: BacklogFilter | undefined, next: BacklogFilter, sameWorkspace: boolean): boolean {
  return sameWorkspace && previous !== undefined && sameFilter(previous, next);
}

// 読み直した木にあるストーリー（エピックの下と、エピックの無いもの）。「木にあるストーリー」の定義はここだけに置く
export function treeStories<S>(loaded: { epics: readonly { stories: readonly S[] }[]; stories: readonly S[] }): S[] {
  return [...loaded.epics.flatMap((epic) => epic.stories), ...loaded.stories];
}

// 孤立の判定の親になるストーリーの ID。読み直した木のストーリーと、この回で残す画面で足したストーリー（読み直した木に入るまで描かれる親）
export function parentStoryIds(loaded: readonly string[], keptAdded: readonly string[]): Set<string> {
  return new Set([...loaded, ...keptAdded]);
}

// 完了にして写した行（fromTree）の親が、読み直した木に無いか。絞り込み中は、当たるタスクが唯一だった親がその完了で木から外れる。
// 遅れて届いた木でそうなると、行はどの親の下にも描かれないのに件数には数えられるので、行と印を捨てる（親ごと外れる競合の無い読み直しと同じ結果）
// storyId が null（親なし）の行、木を読めていない（treeLoaded が偽）とき、行そのものが木に有る（taskInTree。別の人が親を移したなど）ときは、孤立と言えない
export function orphanedFromTree(
  row: { storyId: string | null; fromTree?: true },
  loaded: { treeLoaded: boolean; storyIds: ReadonlySet<string>; taskInTree: boolean },
): boolean {
  return (
    loaded.treeLoaded &&
    !loaded.taskInTree &&
    row.fromTree === true &&
    row.storyId !== null &&
    !loaded.storyIds.has(row.storyId)
  );
}
