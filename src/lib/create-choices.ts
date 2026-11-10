// 起票で選べる親と担当。完了・中止した親と、今所属していない担当は外す。
type Story = { id: string; title: string; completed_at: string | null };
type Epic = { completed_at: string | null; canceled_at: string | null; stories: readonly Story[] };
type Person = { id: string; name: string; current: boolean };
type EpicChoice = { id: string; title: string; finished: boolean };
type Tree = {
  epics: readonly Epic[];
  stories: readonly Story[];
  choices: { epics: readonly EpicChoice[]; assignees: readonly Person[] };
};

export function creationChoices(tree: Tree | null) {
  return {
    stories: tree
      ? [
          ...tree.epics.filter((epic) => !epic.completed_at && !epic.canceled_at).flatMap((epic) => epic.stories),
          ...tree.stories,
        ].filter((story) => !story.completed_at)
      : [],
    epics: tree?.choices.epics.filter((epic) => !epic.finished) ?? [],
    people: tree?.choices.assignees.filter((person) => person.current) ?? [],
  };
}

// 404/409 の後で候補が消えたら、「なし」という表示と送る ID を一致させる。
export function reconcileCreationRefs(
  choices: ReturnType<typeof creationChoices>,
  refs: { storyId: string; epicId: string; assignee: string },
) {
  return {
    storyId: choices.stories.some((story) => story.id === refs.storyId) ? refs.storyId : '',
    epicId: choices.epics.some((epic) => epic.id === refs.epicId) ? refs.epicId : '',
    assignee: choices.people.some((person) => person.id === refs.assignee) ? refs.assignee : '',
  };
}
