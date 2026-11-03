import { CORE_SCHEMA, constructFromEvents, parseEvents } from 'js-yaml';

export const WIKI_BODY_MAX_LENGTH = 100_000;
export const WIKI_TITLE_MAX_LENGTH = 100;
const FRONTMATTER_MAX_LENGTH = 16_384;

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
export function parseWikiFrontmatter(source: string): { title: string | null; body: string; invalid: boolean } {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { title: null, body: source, invalid: false };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) {
    return { title: null, body: source, invalid: true };
  }
  const yaml = normalized.slice(4, end);
  if (yaml.length > FRONTMATTER_MAX_LENGTH) return { title: null, body: source, invalid: true };
  try {
    const events = parseEvents(yaml, { maxDepth: 10 });
    if (events.some((event) => 'tagStart' in event && event.tagStart >= 0)) {
      return { title: null, body: source, invalid: true };
    }
    const documents = constructFromEvents(events, { source: yaml, schema: CORE_SCHEMA, maxAliases: 0 });
    if (documents.length > 1) return { title: null, body: source, invalid: true };
    const value = documents[0] ?? null;
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      return { title: null, body: source, invalid: true };
    }
    const title =
      value !== null && typeof value === 'object' && Object.hasOwn(value, 'title')
        ? titleOf((value as Record<string, unknown>).title)
        : null;
    return { title, body: normalized.slice(end + 4).replace(/^\n/, ''), invalid: false };
  } catch {
    return { title: null, body: source, invalid: true };
  }
}

export function wikiTitle(inputTitle: string, body: string): string | null {
  return parseWikiFrontmatter(body).title ?? titleOf(inputTitle);
}
