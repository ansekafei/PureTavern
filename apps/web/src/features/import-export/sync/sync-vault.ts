/**
 * Glue between the archive pipeline and the encrypted vault.
 *
 * The important property: **decryption never leaves this file**. Callers hand over a plaintext Blob and
 * a label, and get back opaque bytes on the wire. When they ask for a snapshot back, they get a Blob
 * only after AES-GCM has authenticated it.
 *
 * Snapshots are whole archives, not deltas. Two devices uploading the same day produce two entries; the
 * user picks one when restoring. That is deliberate — merging two live data directories needs CRDT
 * semantics and would silently corrupt things, whereas "pick a snapshot" cannot.
 */

import {
  decryptBytes,
  deriveKeyMaterial,
  encryptBytes,
  randomObjectId,
  toBase64,
  validatePassword,
  validateUsername,
  type SyncKeyMaterial,
} from './sync-crypto';
import {
  authenticateSync,
  emptyIndex,
  SyncClient,
  SyncClientError,
  type SyncIndex,
  type SyncSnapshotEntry,
} from './sync-client';

import type { BackupDescriptor } from '@pure-tavern/contracts';

const DEVICE_ID_KEY = 'pure-tavern-sync-device';
const SNAPSHOT_LIMIT = 50;

export interface UnlockedVault {
  readonly client: SyncClient;
  readonly keys: SyncKeyMaterial;
  readonly username: string;
  /** The index as it was last read or written, decrypted. */
  readonly index: SyncIndex;
}

export interface UnlockInput {
  baseUrl: string;
  username: string;
  password: string;
  /** Creating a new account instead of unlocking an existing one. */
  register: boolean;
}

export async function unlockVault(
  input: UnlockInput,
  fetchImpl?: typeof fetch,
): Promise<UnlockedVault> {
  const username = validateUsername(input.username);
  const password = validatePassword(input.password);
  const keys = await deriveKeyMaterial(username, password);

  const credentials = await authenticateSync({
    baseUrl: input.baseUrl,
    username,
    verifier: keys.verifier,
    mode: input.register ? 'register' : 'login',
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const client = new SyncClient({
    baseUrl: input.baseUrl,
    token: credentials.token,
    username: credentials.username,
    accountId: credentials.accountId,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const index = await readIndex(client, keys.aesKey);
  return { client, keys, username, index };
}

export async function readIndex(client: SyncClient, key: CryptoKey): Promise<SyncIndex> {
  const sealed = await client.readIndex();
  if (!sealed) return emptyIndex();
  const plain = await decryptBytes(key, sealed);
  return parseIndex(plain);
}

async function writeIndex(
  client: SyncClient,
  key: CryptoKey,
  index: SyncIndex,
): Promise<SyncIndex> {
  const next: SyncIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    snapshots: index.snapshots.slice(0, SNAPSHOT_LIMIT),
  };
  const plain = new TextEncoder().encode(JSON.stringify(next));
  await client.writeIndex(await encryptBytes(key, plain));
  return next;
}

/**
 * Decrypting the index fails the same way for "wrong passphrase" and "corrupt data", so the UI gets one
 * message. A passphrase that authenticates (login succeeded) but cannot decrypt the index means the
 * vault was written by a different passphrase — which is only possible if the username was re-registered
 * with a different password after the data was written.
 */
function parseIndex(plain: Uint8Array): SyncIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    throw new SyncClientError('protocol', '云端索引无法解析，可能来自更新的版本。');
  }
  const record = asRecord(parsed);
  const snapshots = Array.isArray(record.snapshots)
    ? record.snapshots
        .map(parseSnapshot)
        .filter((entry): entry is SyncSnapshotEntry => entry !== null)
    : [];
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    snapshots,
  };
}

function parseSnapshot(value: unknown): SyncSnapshotEntry | null {
  const record = asRecord(value);
  const id = typeof record.id === 'string' ? record.id : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(id)) return null;
  const reason = record.reason;
  return {
    id,
    label: typeof record.label === 'string' ? record.label : '未命名快照',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    size: typeof record.size === 'number' ? record.size : 0,
    sealedSize: typeof record.sealedSize === 'number' ? record.sealedSize : 0,
    archiveId: typeof record.archiveId === 'string' ? record.archiveId : '',
    moduleIds: Array.isArray(record.moduleIds)
      ? record.moduleIds.filter((item): item is string => typeof item === 'string')
      : [],
    includeSecrets: record.includeSecrets === true,
    reason:
      reason === 'pre-import' || reason === 'pre-restore' || reason === 'manual'
        ? reason
        : 'manual',
    deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
  };
}

export interface UploadSnapshotInput {
  vault: UnlockedVault;
  archive: Blob;
  manifest: {
    archiveId: string;
    modules: readonly { moduleId: string }[];
    includeSecrets: boolean;
  };
  label: string;
  reason?: SyncSnapshotEntry['reason'];
}

export interface UploadSnapshotResult {
  entry: SyncSnapshotEntry;
  index: SyncIndex;
}

/**
 * Uploads the ciphertext *first*, then rewrites the index. If the index write fails the object is
 * orphaned rather than lost, and the next upload cleans nothing up — an orphan costs a few hundred KB
 * of R2 and cannot corrupt a restore, so it is the safe side of the trade.
 */
export async function uploadSnapshot(input: UploadSnapshotInput): Promise<UploadSnapshotResult> {
  const { vault, archive, manifest } = input;
  const plain = new Uint8Array(await archive.arrayBuffer());
  const sealed = await encryptBytes(vault.keys.aesKey, plain);
  const id = randomObjectId();

  await vault.client.writeObject(id, sealed);

  const entry: SyncSnapshotEntry = {
    id,
    label: input.label.trim() || defaultLabel(),
    createdAt: new Date().toISOString(),
    size: plain.byteLength,
    sealedSize: sealed.byteLength,
    archiveId: manifest.archiveId,
    moduleIds: manifest.modules.map((module) => module.moduleId),
    includeSecrets: manifest.includeSecrets,
    reason: input.reason ?? 'manual',
    deviceId: deviceId(),
  };

  const index = await writeIndex(vault.client, vault.keys.aesKey, {
    ...vault.index,
    snapshots: [entry, ...vault.index.snapshots],
  });
  // The vault owns its index: leaving the caller to copy the result back is how two uploads in a row
  // end up both writing "one snapshot". `index` stays mutable for exactly this reason.
  vault.index.snapshots = index.snapshots;
  vault.index.updatedAt = index.updatedAt;
  return { entry, index };
}

export async function downloadSnapshot(
  vault: UnlockedVault,
  id: string,
  fileName = 'pure-tavern-sync.zip',
): Promise<File> {
  const sealed = await vault.client.readObject(id);
  if (!sealed) {
    throw new SyncClientError('not-found', '这条快照在云端已经不存在了，可能在别的设备上删掉了。');
  }
  const plain = await decryptBytes(vault.keys.aesKey, sealed);
  return new File([toArrayBuffer(plain)], fileName, { type: 'application/zip' });
}

export interface DeleteSnapshotResult {
  deleted: boolean;
  index: SyncIndex;
}

export async function deleteSnapshot(
  vault: UnlockedVault,
  id: string,
): Promise<DeleteSnapshotResult> {
  const deleted = await vault.client.deleteObject(id);
  const index = await writeIndex(vault.client, vault.keys.aesKey, {
    ...vault.index,
    snapshots: vault.index.snapshots.filter((entry) => entry.id !== id),
  });
  vault.index.snapshots = index.snapshots;
  vault.index.updatedAt = index.updatedAt;
  return { deleted, index };
}

/**
 * The archive service speaks `BackupDescriptor`; the vault speaks `SyncSnapshotEntry`. They describe the
 * same thing, so this is a rename, not a translation — kept explicit so the two stay in sync visually.
 */
export function toBackupDescriptor(entry: SyncSnapshotEntry): BackupDescriptor {
  return {
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    size: entry.sealedSize,
    archiveId: entry.archiveId,
    moduleIds: entry.moduleIds,
    includeSecrets: entry.includeSecrets,
    reason: entry.reason,
  };
}

function defaultLabel(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `云端快照 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Stable per-browser random id. Not a fingerprint: it is generated locally, never sent anywhere except
 * inside the encrypted index, and only exists so the list can say "which machine uploaded this".
 */
export function deviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_ID_KEY);
    if (existing && /^[a-z0-9]{8}$/u.test(existing)) return existing;
    const generated = toBase64(crypto.getRandomValues(new Uint8Array(6)))
      .replace(/[^A-Za-z0-9]/gu, '')
      .slice(0, 8)
      .toLowerCase()
      .padEnd(8, '0');
    globalThis.localStorage?.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    // Private mode or a locked-down WebView: a missing label is not worth failing an upload over.
    return 'unknown0';
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
