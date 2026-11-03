import { cleanupDeletedWiki } from '../db/index.ts';

export async function cleanupWiki(env: Env, at: Date): Promise<void> {
  try {
    const deleted = await cleanupDeletedWiki(env, at);
    if (deleted.revisions > 0 || deleted.pages > 0) {
      console.info(JSON.stringify({ level: 'info', job: 'cleanup-wiki', ...deleted }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        job: 'cleanup-wiki',
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    throw new Error('Wiki の保持期限を過ぎた本文の掃除に失敗した', { cause: error });
  }
}
