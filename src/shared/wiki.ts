import { CORE_SCHEMA, constructFromEvents, parseEvents } from 'js-yaml';

export const WIKI_BODY_MAX_LENGTH = 100_000;
export const WIKI_TITLE_MAX_LENGTH = 100;
export const WIKI_SEARCH_MAX_PAGES = 5000;
export const WIKI_SEARCH_MAX_BYTES = 32 * 1024 * 1024;
const FRONTMATTER_MAX_LENGTH = 16_384;

export type WikiFrontmatter = {
  title: string | null;
  body: string;
  invalid: boolean;
  properties: { key: string; value: string }[];
};

function validText(value: string): boolean {
  return !value.includes('\0') && value.isWellFormed();
}

export function wikiBodyProblem(body: string): 'too_long' | 'invalid_character' | null {
  if (!validText(body)) return 'invalid_character';
  return [...body].length > WIKI_BODY_MAX_LENGTH ? 'too_long' : null;
}

function titleOf(value: unknown): string | null {
  if (typeof value !== 'string' || !validText(value)) return null;
  const title = value.trim();
  return title.length > 0 && [...title].length <= WIKI_TITLE_MAX_LENGTH ? title : null;
}

// Worker と画面で同じ、安全な YAML の読み方を使う。展開の上限を超えた入力も本文として保持する。
export function parseWikiFrontmatter(source: string): WikiFrontmatter {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { title: null, body: source, invalid: false, properties: [] };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) {
    return { title: null, body: source, invalid: true, properties: [] };
  }
  const yaml = normalized.slice(4, end);
  if (yaml.length > FRONTMATTER_MAX_LENGTH) return { title: null, body: source, invalid: true, properties: [] };
  try {
    const events = parseEvents(yaml, { maxDepth: 10 });
    if (events.some((event) => 'tagStart' in event && event.tagStart >= 0)) {
      return { title: null, body: source, invalid: true, properties: [] };
    }
    const documents = constructFromEvents(events, { source: yaml, schema: CORE_SCHEMA, maxAliases: 0 });
    if (documents.length > 1) return { title: null, body: source, invalid: true, properties: [] };
    const value = documents[0] ?? null;
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      return { title: null, body: source, invalid: true, properties: [] };
    }
    const title =
      value !== null && typeof value === 'object' && Object.hasOwn(value, 'title')
        ? titleOf((value as Record<string, unknown>).title)
        : null;
    const properties = Object.entries(value ?? {})
      .filter(([key]) => key !== 'title' || title === null)
      .map(([key, value]) => ({
        key,
        value:
          typeof value === 'object'
            ? JSON.stringify(
                value,
                (_key, item) => (typeof item === 'number' && !Number.isFinite(item) ? String(item) : item),
                2,
              )
            : String(value),
      }));
    return { title, body: normalized.slice(end + 4).replace(/^\n/, ''), invalid: false, properties };
  } catch {
    return { title: null, body: source, invalid: true, properties: [] };
  }
}

export function wikiTitle(inputTitle: string, body: string): string | null {
  return parseWikiFrontmatter(body).title ?? titleOf(inputTitle);
}
