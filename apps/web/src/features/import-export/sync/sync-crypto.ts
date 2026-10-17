/**
 * Passphrase → key derivation and authenticated encryption for the sync vault.
 *
 * The passphrase never leaves the device. One PBKDF2 run produces 64 bytes: the first half becomes
 * the AES-256-GCM key, the second half is hashed once more to become the `verifier` the server stores.
 * The server therefore holds something that proves "this caller knows the passphrase" without holding
 * anything that can decrypt the vault.
 *
 * Changing `PBKDF2_ITERATIONS` or `SALT_PREFIX` makes every existing vault undecryptable — they are
 * part of the on-disk format, not a tunable.
 */

export const SYNC_PBKDF2_ITERATIONS = 600_000;
export const SYNC_SALT_PREFIX = 'pure-tavern-sync-salt:v1:';
export const SYNC_INDEX_VERSION = 1;

const IV_BYTES = 12;
const KEY_BYTES = 32;
const DERIVED_BYTES = 64;

/**
 * Buffers backed by a plain ArrayBuffer. The WebCrypto overloads in TS 5.9 reject
 * `Uint8Array<ArrayBufferLike>` because a SharedArrayBuffer is not a legal `BufferSource`,
 * so every byte array we hand to `crypto.subtle` has to carry the narrower buffer type.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export class SyncCryptoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncCryptoError';
    this.code = code;
  }
}

export interface SyncKeyMaterial {
  /** AES-256-GCM key. Non-extractable; it cannot be read back out of the CryptoKey. */
  readonly aesKey: CryptoKey;
  /** 64 lowercase hex characters. Uploaded once at registration and on every login. */
  readonly verifier: string;
  /** Hex of the derived salt, exposed only so the UI can show a stable fingerprint. */
  readonly salt: string;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Usernames must match the server's `USERNAME_PATTERN`; catching it here keeps the error local. */
export function validateUsername(value: string): string {
  const normalized = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/u.test(normalized)) {
    throw new SyncCryptoError(
      'invalid-username',
      '用户名需 3–32 位，只能用小写字母、数字、点、短横线或下划线，且以字母或数字开头。',
    );
  }
  return normalized;
}

export function validatePassword(value: string): string {
  if (value.length < 8) {
    throw new SyncCryptoError(
      'weak-password',
      '同步密码至少 8 位；忘记后无法找回，建议用一句长短语。',
    );
  }
  return value;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256(bytes: BufferSource): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  return toHex(await sha256(bytes));
}

export interface DeriveOptions {
  /** Test seam only. Production callers must not pass this. */
  iterations?: number;
}

export async function deriveKeyMaterial(
  username: string,
  password: string,
  options: DeriveOptions = {},
): Promise<SyncKeyMaterial> {
  const normalized = validateUsername(username);
  const passphrase = validatePassword(password);
  const iterations = options.iterations ?? SYNC_PBKDF2_ITERATIONS;

  const encoder = new TextEncoder();
  const salt = await sha256(encoder.encode(`${SYNC_SALT_PREFIX}${normalized}`));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    DERIVED_BYTES * 8,
  );
  const derived = new Uint8Array(bits);
  if (derived.length !== DERIVED_BYTES) {
    throw new SyncCryptoError('derivation-failed', '密钥派生结果长度异常。');
  }

  const aesKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(derived.slice(0, KEY_BYTES)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  const verifier = await sha256Hex(new Uint8Array(derived.slice(KEY_BYTES)));

  return { aesKey, verifier, salt: toHex(salt) };
}

/**
 * Sealed layout is `iv (12 bytes) || ciphertext || tag`. The IV is random per call, so encrypting the
 * same archive twice produces different bytes — the server cannot tell two uploads apart by content.
 */
export async function encryptBytes(key: CryptoKey, plain: BufferSource): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const sealed = new Uint8Array(IV_BYTES + cipher.length);
  sealed.set(iv, 0);
  sealed.set(cipher, IV_BYTES);
  return sealed;
}

export async function decryptBytes(key: CryptoKey, sealed: Uint8Array): Promise<Bytes> {
  if (sealed.length <= IV_BYTES) {
    throw new SyncCryptoError('ciphertext-too-short', '云端数据不完整，无法解密。');
  }
  const iv = new Uint8Array(sealed.slice(0, IV_BYTES));
  const cipher = new Uint8Array(sealed.slice(IV_BYTES));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
  } catch {
    // AES-GCM authenticates, so either the passphrase is wrong or the bytes were tampered with.
    // Both must look the same to the user: we cannot tell them apart and neither can the server.
    throw new SyncCryptoError('decryption-failed', '解密失败：同步密码不对，或云端数据已损坏。');
  }
}

/** URL-safe random id used as the R2 object key. 16 bytes → 22 chars, inside the 8–64 rule. */
export function randomObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
