import { CORE_SCHEMA, constructFromEvents, dump, parseEvents } from 'js-yaml';
import { parseWikiFrontmatter, wikiBodyProblem, wikiTitle } from './wiki.ts';

export const WIKI_UPLOAD_MAX_FILES = 20;
// 20件×10万字。JSONで制御文字が6バイトへ展開される場合も収める。
export const WIKI_UPLOAD_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export type WikiUploadFile = { file_name: string; body_md: string };
export type WikiUploadProblem = 'extension' | 'file_name' | 'too_long' | 'invalid_character' | 'title';

export function wikiUploadTitle(file: WikiUploadFile): string | null {
  return wikiTitle(file.file_name.replace(/\.md$/i, ''), file.body_md);
}

export function wikiUploadProblem(file: WikiUploadFile): WikiUploadProblem | null {
  if (file.file_name.length > 510) return 'file_name';
  if (!/\.md$/i.test(file.file_name)) return 'extension';
  if (
    !file.file_name.isWellFormed() ||
    [...file.file_name].some((char) => char.charCodeAt(0) < 32) ||
    [...file.file_name].length > 255
  )
    return 'file_name';
  const body = wikiBodyProblem(file.body_md);
  if (body) return body;
  return wikiUploadTitle(file) === null ? 'title' : null;
}

// 使えるtitleを持つ文書と読めないYAMLは元の文字列をそのまま落とす。
// 題の補完が要る場合だけYAMLを組み直し、題以外のキーと本文を保つ。
export function wikiDownloadSource(title: string, source: string): string {
  const parsed = parseWikiFrontmatter(source);
  if (parsed.invalid || parsed.title !== null) return source;
  const match = /^\uFEFF?---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(source);
  const header = match?.index === 0 ? match : null;
  let properties: Record<string, unknown> = {};
  if (header) {
    properties = (constructFromEvents(parseEvents(header[1]!, { maxDepth: 10 }), {
      source: header[1]!,
      schema: CORE_SCHEMA,
      maxAliases: 0,
    })[0] ?? {}) as Record<string, unknown>;
  }
  const rest = Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'title'));
  const yaml = Object.keys(rest).length
    ? dump(rest, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1, flowLevel: 1, flowSkipCommaSpace: true })
    : '';
  return `---\ntitle: ${JSON.stringify(title)}\n${yaml}---\n${header ? source.slice(header[0].length) : source}`;
}

export function wikiDownloadName(title: string): string {
  const clean =
    [...title]
      .filter((char) => char.charCodeAt(0) >= 32)
      .join('')
      .replace(/[<>:"/\\|?*]/g, '')
      .trim()
      .replace(/[. ]+$/, '') || 'page';
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
  return [...safe].slice(0, 97).join('') + '.md';
}
