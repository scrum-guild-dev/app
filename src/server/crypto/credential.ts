// 接続の認証情報（Backlog の API キー、GitHub の PAT）の暗号化。docs/requirements.md の「取り込み」
// AES-GCM（256ビット）で暗号化し、追加の認証データ（AAD）に接続の ID を入れる。別の接続の行へ暗号文を写しても復号できない
// 鍵はシークレット CONNECTION_CREDENTIAL_KEYS に、版つきの JSON（{"<版>":"<base64 の32バイト>"}）で並べる。現行は最大の版
// エラーの文は固定にする。鍵も平文も暗号文も、エラーにもログにも出さない

const KEYS_SECRET = 'CONNECTION_CREDENTIAL_KEYS';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// 版は 1 以上の整数（シークレットの JSON のキーは文字列で書く）。大きい版ほど新しい
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const KEYS_ERROR_MESSAGE = `${KEYS_SECRET} が無いか、形が違う`;
export const INPUT_ERROR_MESSAGE = '認証情報か接続の ID の形が違う';
export const DECRYPT_ERROR_MESSAGE = '認証情報を復号できない';

export class CredentialKeysError extends Error {
  constructor() {
    super(KEYS_ERROR_MESSAGE);
    this.name = 'CredentialKeysError';
  }
}

export class CredentialInputError extends Error {
  constructor() {
    super(INPUT_ERROR_MESSAGE);
    this.name = 'CredentialInputError';
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
  // 暗号化に使った鍵の版（connections.credential_key_version の INTEGER）
  keyVersion: number;
};

// 正規の base64 だけを受ける（末尾の未使用ビットだけが違う別の表記は、同じ暗号文として通さない）
function fromBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return toBase64(bytes) === value ? bytes : undefined;
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
function parseKeys(env: object): Map<number, Uint8Array> {
  const raw = KEYS_SECRET in env ? (env as Record<string, unknown>)[KEYS_SECRET] : undefined;
  if (typeof raw !== 'string' || raw === '') throw new CredentialKeysError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialKeysError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CredentialKeysError();
  const keys = new Map<number, Uint8Array>();
  for (const [version, value] of Object.entries(parsed)) {
    if (!VERSION_PATTERN.test(version) || typeof value !== 'string') throw new CredentialKeysError();
    const bytes = fromBase64(value);
    if (bytes === undefined || bytes.length !== KEY_BYTES) throw new CredentialKeysError();
    keys.set(Number(version), bytes);
  }
  if (keys.size === 0) throw new CredentialKeysError();
  return keys;
}

// health には読めるかだけを返す。鍵の数、版、値は公開しない。
export function hasCredentialKeys(env: object): boolean {
  try {
    parseKeys(env);
    return true;
  } catch (error) {
    if (!(error instanceof CredentialKeysError)) throw error;
    return false;
  }
}

function currentVersion(keys: Map<number, Uint8Array>): number {
  return Math.max(...keys.keys());
}

function importKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const encoder = new TextEncoder();
// 用途を分ける接頭辞。同じ鍵で別の秘密を暗号化しても、暗号文を入れ替えて通せないようにする
const aad = (connectionId: string) => encoder.encode(`connection-credential:${connectionId}`);

export async function encryptCredential(
  env: object,
  plaintext: string,
  connectionId: string,
): Promise<EncryptedCredential> {
  // 接続の ID が空だと、暗号文が接続に結び付かない。孤立サロゲートは TextEncoder が置き換えて、復号しても元に戻らない
  if (
    typeof connectionId !== 'string' ||
    connectionId === '' ||
    typeof plaintext !== 'string' ||
    !plaintext.isWellFormed()
  ) {
    throw new CredentialInputError();
  }
  const keys = parseKeys(env);
  const keyVersion = currentVersion(keys);
  const key = await importKey(keys.get(keyVersion)!);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(connectionId), tagLength: TAG_BYTES * 8 },
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
  const keyBytes = typeof stored.keyVersion === 'number' ? keys.get(stored.keyVersion) : undefined;
  const data = fromBase64(stored.ciphertext);
  if (
    typeof connectionId !== 'string' ||
    connectionId === '' ||
    keyBytes === undefined ||
    data === undefined ||
    data.length < IV_BYTES + TAG_BYTES
  )
    throw new CredentialDecryptError();
  try {
    const key = await importKey(keyBytes);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: data.slice(0, IV_BYTES),
        additionalData: aad(connectionId),
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
