import { restoreWikiPageSql } from './restore-wiki-page-sql.ts';

const args = process.argv.slice(2);
try {
  if (args.length !== 2) throw new Error('組織とページの ID が必要です');
  process.stdout.write(restoreWikiPageSql(args[0]!, args[1]!));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('使い方: node scripts/restore-wiki-page.ts <組織の ID> <ページの ID>');
  process.exitCode = 1;
}
