// 取り込み元の一覧（種類から実装への表）。これを知るのはこのファイルだけ。取り込み元を足すときは、型の実装と言葉の辞書のほかを変えない
import { githubImportSource } from './github/index.ts';
import type { ImportSource, ImportSourceKind } from './source.ts';

export * from './source.ts';

const sources: Record<ImportSourceKind, ImportSource> = { github: githubImportSource };

export function isImportSourceKind(value: unknown): value is ImportSourceKind {
  return typeof value === 'string' && Object.hasOwn(sources, value);
}

export function importSourceOf(kind: ImportSourceKind): ImportSource {
  return sources[kind];
}
