import { WIKI_BODY_MAX_LENGTH } from '../shared/wiki.ts';
import { wikiUploadProblem, type WikiUploadFile, type WikiUploadProblem } from '../shared/wiki-transfer.ts';

export type SelectedWikiFile = WikiUploadFile & {
  key: string;
  problem: WikiUploadProblem | 'utf8' | 'read' | null;
};

export async function readWikiFile(file: File): Promise<SelectedWikiFile> {
  const result: SelectedWikiFile = {
    file_name: file.name,
    body_md: '',
    key: JSON.stringify([file.name, file.size, file.lastModified]),
    problem: null,
  };
  result.problem = wikiUploadProblem(result);
  if (result.problem === 'extension' || result.problem === 'file_name') return result;
  if (file.size > WIKI_BODY_MAX_LENGTH * 4 + 3) return { ...result, problem: 'too_long' };
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ...result, problem: 'read' };
  }
  try {
    result.body_md = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ...result, problem: 'utf8' };
  }
  result.problem = wikiUploadProblem(result);
  return result;
}
