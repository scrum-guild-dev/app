// 提供された PNG / ICO を、単独配信する見本の原本から本番の静的資産へ同期する。
// ラスター画像が原本なので描き直さない。外部の素材ディレクトリやブラウザには依存しない。
import { cp, rm } from 'node:fs/promises';

// static/brand/ はこのスクリプトだけが書く生成物。削除・改名も反映する。
await rm(new URL('../static/brand/', import.meta.url), { recursive: true, force: true });
await cp(new URL('../design/brand/', import.meta.url), new URL('../static/brand/', import.meta.url), {
  recursive: true,
});
