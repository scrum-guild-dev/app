// GitHub の取り込み元（fine-grained PAT）。通信先は固定の URL で、設定から読まない。
// GitHub に固有の値と処理は、このディレクトリの外に出さない
import type { ImportSource } from '../source.ts';

export const githubImportSource: ImportSource = {
  kind: 'github',
  scopeKind: 'repository',
  parseSettings: () => {
    throw new Error('未実装');
  },
  isCredentialShape: () => {
    throw new Error('未実装');
  },
  credentialLast4: () => {
    throw new Error('未実装');
  },
  verifyCredential: () => {
    throw new Error('未実装');
  },
  listScopeCandidates: () => {
    throw new Error('未実装');
  },
};
