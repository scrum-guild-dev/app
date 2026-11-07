import { describe, expect, it } from 'vitest';
import {
  CredentialDecryptError,
  CredentialInputError,
  CredentialKeysError,
  DECRYPT_ERROR_MESSAGE,
  KEYS_ERROR_MESSAGE,
  decryptCredential,
  encryptCredential,
} from '../src/server/crypto/credential.ts';

function key(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}
const env1 = { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(1) }) };
const env12 = { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(1), '2': key(2) }) };
const PLAIN = 'github_pat_架空のトークン';

describe('接続の認証情報の暗号', () => {
  it('暗号化して復号すると元に戻り、暗号文に現行の鍵の版が付く', async () => {
    const sealed = await encryptCredential(env12, PLAIN, 'conn-1');
    expect(sealed.keyVersion).toBe(2);
    expect(sealed.ciphertext).not.toContain('github_pat');
    expect(await decryptCredential(env12, sealed, 'conn-1')).toBe(PLAIN);
  });

  it('版は数で比べ、10 が 9 より新しい', async () => {
    const env = { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '9': key(9), '10': key(10) }) };
    expect((await encryptCredential(env, PLAIN, 'c')).keyVersion).toBe(10);
  });

  it('初期化ベクトルは毎回変わる', async () => {
    const a = await encryptCredential(env1, PLAIN, 'conn-1');
    const b = await encryptCredential(env1, PLAIN, 'conn-1');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('古い版で書いた暗号文は、新旧を並べたシークレットで復号できる', async () => {
    const old = await encryptCredential(env1, PLAIN, 'conn-1');
    expect(old.keyVersion).toBe(1);
    expect(await decryptCredential(env12, old, 'conn-1')).toBe(PLAIN);
  });

  it('別の鍵では復号に失敗する', async () => {
    const sealed = await encryptCredential(env1, PLAIN, 'conn-1');
    const other = { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(7) }) };
    await expect(decryptCredential(other, sealed, 'conn-1')).rejects.toThrow(DECRYPT_ERROR_MESSAGE);
  });

  it('シークレットに無い版では復号に失敗する', async () => {
    const sealed = await encryptCredential(env12, PLAIN, 'conn-1');
    await expect(decryptCredential(env1, sealed, 'conn-1')).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('別の接続の ID では復号に失敗する', async () => {
    const sealed = await encryptCredential(env1, PLAIN, 'conn-1');
    await expect(decryptCredential(env1, sealed, 'conn-2')).rejects.toThrow(DECRYPT_ERROR_MESSAGE);
  });

  it('書き換えた暗号文、短すぎる暗号文、base64 でない暗号文では復号に失敗する', async () => {
    const sealed = await encryptCredential(env1, PLAIN, 'conn-1');
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    for (const ciphertext of [tampered, btoa('short'), '', '!!!!']) {
      await expect(decryptCredential(env1, { ...sealed, ciphertext }, 'conn-1')).rejects.toBeInstanceOf(
        CredentialDecryptError,
      );
    }
  });

  it('鍵が無いとき、空のとき、形が違うときは、固定の文で止まる', async () => {
    const bad: object[] = [
      {},
      { CONNECTION_CREDENTIAL_KEYS: '' },
      { CONNECTION_CREDENTIAL_KEYS: 'not json' },
      { CONNECTION_CREDENTIAL_KEYS: '[]' },
      { CONNECTION_CREDENTIAL_KEYS: '{}' },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': 'AAAA' }) },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(1).slice(0, -4) }) },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': 42 }) },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ v1: key(1) }) },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '0': key(1) }) },
      { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(1), '2': 'bad' }) },
    ];
    for (const env of bad) {
      await expect(encryptCredential(env, PLAIN, 'c')).rejects.toThrow(KEYS_ERROR_MESSAGE);
      await expect(decryptCredential(env, { ciphertext: 'AAAA', keyVersion: 1 }, 'c')).rejects.toBeInstanceOf(
        CredentialKeysError,
      );
    }
  });

  it('エラーの文に鍵も平文も入らない', async () => {
    const env = { CONNECTION_CREDENTIAL_KEYS: JSON.stringify({ '1': key(1).slice(0, -4) }) };
    const error = await encryptCredential(env, PLAIN, 'c').catch((e: Error) => e);
    expect(String(error)).not.toContain(PLAIN);
    expect(String(error)).not.toContain(key(1).slice(0, 8));
  });

  it('BOM で始まる平文と空の平文が往復する', async () => {
    for (const plain of ['\uFEFFabc', '']) {
      const sealed = await encryptCredential(env1, plain, 'conn-1');
      expect(await decryptCredential(env1, sealed, 'conn-1')).toBe(plain);
    }
  });

  it('暗号文が文字列でないときは復号に失敗する', async () => {
    for (const ciphertext of [null, undefined, 1]) {
      await expect(
        decryptCredential(env1, { ciphertext: ciphertext as never, keyVersion: 1 }, 'conn-1'),
      ).rejects.toBeInstanceOf(CredentialDecryptError);
    }
  });

  it('接続の ID が空なら暗号化も復号も拒む', async () => {
    await expect(encryptCredential(env1, PLAIN, '')).rejects.toBeInstanceOf(CredentialInputError);
    await expect(encryptCredential(env1, PLAIN, undefined as never)).rejects.toBeInstanceOf(CredentialInputError);
    const sealed = await encryptCredential(env1, PLAIN, 'conn-1');
    await expect(decryptCredential(env1, sealed, '')).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('孤立サロゲートを含む平文は暗号化を拒む', async () => {
    await expect(encryptCredential(env1, 'a\uD800', 'conn-1')).rejects.toBeInstanceOf(CredentialInputError);
  });

  it('末尾の未使用ビットだけを変えた別の表記の暗号文は復号に失敗する', async () => {
    const sealed = await encryptCredential(env1, 'abcd', 'c');
    // 長さが 3 の倍数でない暗号文の末尾の文字を、同じバイト列に戻る別の文字にする
    const last = sealed.ciphertext.replace(/=+$/, '');
    expect(last.length % 4).not.toBe(0);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = alphabet.indexOf(last.at(-1)!);
    const alias = alphabet[index ^ 1]!;
    const aliased = last.slice(0, -1) + alias + sealed.ciphertext.slice(last.length);
    await expect(decryptCredential(env1, { ...sealed, ciphertext: aliased }, 'c')).rejects.toBeInstanceOf(
      CredentialDecryptError,
    );
  });

  it('形の合わない版は鍵の形の誤りにする', async () => {
    for (const version of ['01', '1000000000', '-1', '1.5', '__proto__']) {
      const env = { CONNECTION_CREDENTIAL_KEYS: `{${JSON.stringify(version)}:${JSON.stringify(key(1))}}` };
      await expect(encryptCredential(env, PLAIN, 'c')).rejects.toBeInstanceOf(CredentialKeysError);
    }
  });
});
