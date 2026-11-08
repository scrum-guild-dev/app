export type Health = {
  status: 'ok';
  // D1 に届いた。届かないときは 200 ではなく 503 の unavailable を返す
  database: 'ok';
  // 鍵の設定を暗号化と同じ規則で読める。安全性や既存の暗号文の復号までは検査しない
  credentialKeys: 'ok';
  // ビルドで埋めたコミットの SHA。埋めていなければ dev
  version: string;
};

export function isHealth(value: unknown): value is Health {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'database' in value &&
    value.database === 'ok' &&
    'credentialKeys' in value &&
    value.credentialKeys === 'ok' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}
