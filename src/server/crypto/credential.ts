// 接続の認証情報（Backlog の API キー、GitHub の PAT）の暗号化。docs/requirements.md の「取り込み」
// AES-GCM（256ビット）で暗号化し、追加の認証データ（AAD）に接続の ID を入れる。別の接続の行へ暗号文を写しても復号できない
// 鍵はシークレット CONNECTION_CREDENTIAL_KEYS に、版つきの JSON（{"<版>":"<base64 の32バイト>"}）で並べる。現行は最大の版
// エラーの文は固定にする。鍵も平文も暗号文も、エラーにもログにも出さない

const KEYS_SECRET = 'CONNECTION_CREDENTIAL_KEYS';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// 版は 1 以上の整数の文字列。大きい版ほど新しい（文字列でなく数で比べる）
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const KEYS_ERROR_MESSAGE = `${KEYS_SECRET} が無いか、形が違う`;
export const DECRYPT_ERROR_MESSAGE = '認証情報を復号できない';

export class CredentialKeysError extends Error {
  constructor() {
    super(KEYS_ERROR_MESSAGE);
    this.name = 'CredentialKeysError';
  }
}

export class CredentialDecryptError extends Error {
  constructor() {
    super(DECRYPT_ERROR_MESSAGE);
    this.name = 'CredentialDecryptError';
  }
}

export type EncryptedCredential = {
  // base64（初期化ベクトル 12 バイト + 暗号文 + タグ）
  ciphertext: string;
  // 暗号化に使った鍵の版
  keyVersion: string;
};

function fromBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return undefined;
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// シークレットは wrangler types が .dev.vars のあるときだけ型に出す。型に頼らず、値の有無を見る
function parseKeys(env: object): Map<string, Uint8Array> {
  const raw = KEYS_SECRET in env ? (env as Record<string, unknown>)[KEYS_SECRET] : undefined;
  if (typeof raw !== 'string' || raw === '') throw new CredentialKeysError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialKeysError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CredentialKeysError();
  const keys = new Map<string, Uint8Array>();
  for (const [version, value] of Object.entries(parsed)) {
    if (!VERSION_PATTERN.test(version) || typeof value !== 'string') throw new CredentialKeysError();
    const bytes = fromBase64(value);
    if (bytes === undefined || bytes.length !== KEY_BYTES) throw new CredentialKeysError();
    keys.set(version, bytes);
  }
  if (keys.size === 0) throw new CredentialKeysError();
  return keys;
}

function currentVersion(keys: Map<string, Uint8Array>): string {
  let current = '';
  for (const version of keys.keys()) {
    if (current === '' || Number(version) > Number(current)) current = version;
  }
  return current;
}

function importKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const encoder = new TextEncoder();

export async function encryptCredential(
  env: object,
  plaintext: string,
  connectionId: string,
): Promise<EncryptedCredential> {
  const keys = parseKeys(env);
  const keyVersion = currentVersion(keys);
  const key = await importKey(keys.get(keyVersion)!);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(connectionId), tagLength: TAG_BYTES * 8 },
      key,
      encoder.encode(plaintext),
    ),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return { ciphertext: toBase64(out), keyVersion };
}

export async function decryptCredential(
  env: object,
  stored: EncryptedCredential,
  connectionId: string,
): Promise<string> {
  const keys = parseKeys(env);
  const keyBytes = keys.get(stored.keyVersion);
  const data = fromBase64(stored.ciphertext);
  if (keyBytes === undefined || data === undefined || data.length < IV_BYTES + TAG_BYTES)
    throw new CredentialDecryptError();
  try {
    const key = await importKey(keyBytes);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: data.slice(0, IV_BYTES),
        additionalData: encoder.encode(connectionId),
        tagLength: TAG_BYTES * 8,
      },
      key,
      data.slice(IV_BYTES),
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
  } catch {
    throw new CredentialDecryptError();
  }
}
