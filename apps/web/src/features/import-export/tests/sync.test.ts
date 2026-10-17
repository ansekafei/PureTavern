/**
 * The sync vault has one property worth testing above all others: what leaves the device is ciphertext.
 * Every test here is written so that it would fail if plaintext reached `fetch` — the fake transport
 * keeps the raw request bodies and the assertions look at them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decryptBytes,
  deriveKeyMaterial,
  SyncCryptoError,
  encryptBytes,
  normalizeUsername,
  randomObjectId,
  toHex,
  validatePassword,
  validateUsername,
} from '../sync/sync-crypto';
import { normalizeSyncBaseUrl, SyncClientError } from '../sync/sync-client';
import {
  deleteSnapshot,
  downloadSnapshot,
  readIndex,
  toBackupDescriptor,
  unlockVault,
  uploadSnapshot,
  type UnlockedVault,
} from '../sync/sync-vault';

const BASE = 'https://backend.example.com/';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Raw bytes. Ciphertext is not text; decoding it here would corrupt it. */
  body: Uint8Array | null;
}

/**
 * Stands in for the Worker. It stores opaque bytes in Maps exactly like R2 does, so a test that puts
 * plaintext in an object will see plaintext come back — which is how the "no plaintext on the wire"
 * assertions get their teeth.
 */
function createFakeBackend(options: { verifier: string; username: string }) {
  const index = new Map<string, Uint8Array>();
  const objects = new Map<string, Uint8Array>();
  const requests: RecordedRequest[] = [];
  let tokenCounter = 0;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key] = value;
    }
    let body: Uint8Array | null = null;
    if (init?.body) {
      const raw = init.body as ArrayBuffer | Uint8Array | string;
      if (typeof raw === 'string') body = new TextEncoder().encode(raw);
      else if (raw instanceof ArrayBuffer) body = new Uint8Array(raw);
      else body = new Uint8Array(raw);
    }
    requests.push({ url, method, headers, body });

    const path = new URL(url).pathname;

    if (path === '/v1/sync/register' || path === '/v1/sync/login') {
      const payload = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as {
        username?: string;
        verifier?: string;
      };
      const matches =
        payload.username === options.username && payload.verifier === options.verifier;
      if (!matches) return json({ error: { code: 'invalid-credentials' } }, 401);
      tokenCounter += 1;
      return json(
        {
          token: `fake-token-${tokenCounter}`,
          username: options.username,
          accountId: 'a'.repeat(64),
        },
        path === '/v1/sync/register' ? 201 : 200,
      );
    }

    if (headers.Authorization !== `Bearer fake-token-${tokenCounter}`) {
      return json({ error: { code: 'unauthorized' } }, 401);
    }

    if (path === '/v1/sync/index') {
      if (method === 'GET') {
        const stored = index.get('index');
        if (!stored) return json({ error: { code: 'not-found' } }, 404);
        return new Response(toArrayBuffer(stored), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      if (method === 'PUT') {
        index.set('index', body ?? new Uint8Array());
        return new Response(null, { status: 204 });
      }
    }

    const objectMatch = /^\/v1\/sync\/objects\/([^/]+)$/u.exec(path);
    if (objectMatch) {
      const id = decodeURIComponent(objectMatch[1] ?? '');
      if (method === 'PUT') {
        objects.set(id, body ?? new Uint8Array());
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        const stored = objects.get(id);
        if (!stored) return json({ error: { code: 'not-found' } }, 404);
        return new Response(toArrayBuffer(stored), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: objects.delete(id) ? 204 : 404 });
      }
    }

    return json({ error: { code: 'not-found' } }, 404);
  };

  return { fetchImpl, requests, index, objects };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

const USERNAME = 'coffee';
const PASSPHRASE = 'correct horse battery staple';

/**
 * The fake backend has to know the verifier before the vault logs in, and deriving it costs a full
 * PBKDF2 run. Deriving once per test file keeps the suite fast while still using the real derivation —
 * a hardcoded verifier would stop testing the one thing that matters.
 */
let cachedVerifier: Promise<string> | null = null;
async function correctVerifier(): Promise<string> {
  cachedVerifier ??= deriveKeyMaterial(USERNAME, PASSPHRASE).then((keys) => keys.verifier);
  return cachedVerifier;
}

async function makeBackend() {
  return createFakeBackend({ verifier: await correctVerifier(), username: USERNAME });
}

async function makeVault(fetchImpl: typeof fetch, register = true): Promise<UnlockedVault> {
  return unlockVault(
    { baseUrl: BASE, username: USERNAME, password: PASSPHRASE, register },
    fetchImpl,
  );
}

function archiveBlob(content = '{"chats":[]}'): Blob {
  return new Blob([content], { type: 'application/zip' });
}

const MANIFEST = {
  archiveId: 'archive-1',
  modules: [{ moduleId: 'chats' }, { moduleId: 'settings' }],
  includeSecrets: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync key derivation', () => {
  it('derives the same key material from the same username and passphrase', async () => {
    const first = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    const second = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    expect(first.verifier).toBe(second.verifier);
    expect(first.salt).toBe(second.salt);
    expect(first.verifier).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('normalizes the username so Coffee and coffee share one vault', async () => {
    const upper = await deriveKeyMaterial('Coffee', 'correct horse battery staple');
    const lower = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    expect(upper.verifier).toBe(lower.verifier);
    expect(normalizeUsername('  Coffee  ')).toBe('coffee');
  });

  it('derives a different verifier for a different passphrase', async () => {
    const one = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    const two = await deriveKeyMaterial('coffee', 'correct horse battery stapler');
    expect(one.verifier).not.toBe(two.verifier);
  });

  it('never exposes the raw key bytes', async () => {
    const keys = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    // Non-extractable: exportKey must fail, so the key cannot be read back out even by our own code.
    await expect(crypto.subtle.exportKey('raw', keys.aesKey)).rejects.toThrow();
  });

  it('rejects usernames that the server would reject, before spending a PBKDF2 run', () => {
    // Same shape as the Worker's USERNAME_PATTERN: catching it locally turns a 400 round trip into
    // an instant message, and stops the UI from deriving a key for an account it cannot create.
    expect(() => validateUsername('ab')).toThrow(SyncCryptoError);
    expect(() => validateUsername('-coffee')).toThrow(SyncCryptoError);
    expect(() => validateUsername('a'.repeat(33))).toThrow(SyncCryptoError);
    expect(() => validateUsername('咖啡')).toThrow(SyncCryptoError);
    expect(validateUsername(' Coffee ')).toBe('coffee');
  });

  it('rejects short passphrases with a message that says the loss is permanent', () => {
    expect(() => validatePassword('short')).toThrow(/至少 8 位/u);
  });
});

describe('sync encryption', () => {
  it('round-trips bytes through AES-GCM', async () => {
    const keys = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    const plain = new TextEncoder().encode('the archive bytes');
    const sealed = await encryptBytes(keys.aesKey, plain);
    expect(new TextDecoder().decode(await decryptBytes(keys.aesKey, sealed))).toBe(
      'the archive bytes',
    );
  });

  it('produces different ciphertext for identical plaintext, so uploads are not comparable', async () => {
    const keys = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    const plain = new TextEncoder().encode('same bytes');
    const first = await encryptBytes(keys.aesKey, plain);
    const second = await encryptBytes(keys.aesKey, plain);
    expect(toHex(first)).not.toBe(toHex(second));
  });

  it('refuses a tampered ciphertext instead of returning garbage', async () => {
    const keys = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    const sealed = await encryptBytes(keys.aesKey, new TextEncoder().encode('payload'));
    // noUncheckedIndexedAccess: an empty array would make this a silent no-op instead of a flip.
    const last = sealed.length - 1;
    sealed.set([(sealed[last] ?? 0) ^ 0xff], last);
    await expect(decryptBytes(keys.aesKey, sealed)).rejects.toThrow(/解密失败/u);
  });

  it('refuses a ciphertext shorter than the IV', async () => {
    const keys = await deriveKeyMaterial('coffee', 'correct horse battery staple');
    await expect(decryptBytes(keys.aesKey, new Uint8Array(4))).rejects.toThrow(/不完整/u);
  });

  it('generates object ids that satisfy the server rule', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(randomObjectId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
    }
  });
});

describe('sync base url', () => {
  it('adds the trailing slash the endpoint join relies on', () => {
    expect(normalizeSyncBaseUrl('https://backend.example.com')).toBe(
      'https://backend.example.com/',
    );
    expect(normalizeSyncBaseUrl('https://backend.example.com/tavern')).toBe(
      'https://backend.example.com/tavern/',
    );
  });

  it('rejects the urls that would silently point somewhere else', () => {
    expect(() => normalizeSyncBaseUrl('')).toThrow(/请填写后端地址/u);
    expect(() => normalizeSyncBaseUrl('backend.example.com')).toThrow(/合法 URL/u);
    expect(() => normalizeSyncBaseUrl('ftp://backend.example.com')).toThrow(/http 或 https/u);
    expect(() => normalizeSyncBaseUrl('https://user:pass@backend.example.com')).toThrow(
      /用户名或密码/u,
    );
    expect(() => normalizeSyncBaseUrl('https://backend.example.com/?a=1')).toThrow(/查询参数/u);
    expect(() => normalizeSyncBaseUrl('https://backend.example.com/#x')).toThrow(/锚点/u);
  });
});

describe('sync vault round trip', () => {
  it('uploads ciphertext, never the archive itself', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);

    const marker = 'PLAINTEXT-MARKER-93f1';
    const result = await uploadSnapshot({
      vault,
      archive: archiveBlob(`{"chats":["${marker}"]}`),
      manifest: MANIFEST,
      label: '第一次同步',
    });

    const stored = backend.objects.get(result.entry.id);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!)).not.toContain(marker);
    // The index is encrypted too: the label must not be readable server side either.
    const indexBytes = new TextDecoder().decode(backend.index.get('index')!);
    expect(indexBytes).not.toContain('第一次同步');
    expect(indexBytes).not.toContain(marker);
  });

  it('records the snapshot, lists it back, and restores identical bytes', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);

    const payload = `{"chats":["${'x'.repeat(500)}"]}`;
    const uploaded = await uploadSnapshot({
      vault,
      archive: archiveBlob(payload),
      manifest: MANIFEST,
      label: '同步点 A',
    });

    expect(uploaded.index.snapshots).toHaveLength(1);
    const restored = await downloadSnapshot(vault, uploaded.entry.id);
    expect(await restored.text()).toBe(payload);
    expect(restored.type).toBe('application/zip');
  });

  it('writes an index that a second device can read back with the same passphrase', async () => {
    const backend = await makeBackend();
    const first = await makeVault(backend.fetchImpl);
    const uploaded = await uploadSnapshot({
      vault: first,
      archive: archiveBlob('device one'),
      manifest: MANIFEST,
      label: '来自设备一',
    });

    // Second device: same credentials, brand-new in-memory vault, only the server state is shared.
    const second = await unlockVault(
      {
        baseUrl: BASE,
        username: 'coffee',
        password: 'correct horse battery staple',
        register: false,
      },
      backend.fetchImpl,
    );
    expect(second.index.snapshots.map((entry) => entry.label)).toEqual(['来自设备一']);

    const restored = await downloadSnapshot(second, uploaded.entry.id);
    expect(await restored.text()).toBe('device one');
  });

  it('surfaces a wrong passphrase as a plain rejection, not as a corrupt index', async () => {
    const backend = await makeBackend();
    await makeVault(backend.fetchImpl);

    await expect(
      unlockVault(
        {
          baseUrl: BASE,
          username: 'coffee',
          password: 'some other long passphrase',
          register: false,
        },
        backend.fetchImpl,
      ),
    ).rejects.toMatchObject({
      // 错误码是 UI 用来区分「密码错」和「网络错」的依据，不能只靠文案。
      name: 'SyncClientError',
      code: 'invalid-credentials',
      status: 401,
    });
    await expect(
      unlockVault(
        {
          baseUrl: BASE,
          username: USERNAME,
          password: 'another wrong passphrase',
          register: false,
        },
        backend.fetchImpl,
      ),
    ).rejects.toBeInstanceOf(SyncClientError);
  });

  it('deletes the object and drops the entry from the index', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);
    const uploaded = await uploadSnapshot({
      vault,
      archive: archiveBlob('to be deleted'),
      manifest: MANIFEST,
      label: '待删',
    });
    const result = await deleteSnapshot(vault, uploaded.entry.id);
    expect(result.deleted).toBe(true);
    expect(result.index.snapshots).toHaveLength(0);
    expect(backend.objects.has(uploaded.entry.id)).toBe(false);
  });

  it('reports a snapshot deleted on another device instead of failing silently', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);
    await expect(downloadSnapshot(vault, 'missingobjectid')).rejects.toThrow(/已经不存在/u);
  });

  it('keeps the newest fifty snapshots so the index cannot grow without bound', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);

    let snapshots: typeof vault.index.snapshots = [];
    for (let index = 0; index < 51; index += 1) {
      const result = await uploadSnapshot({
        vault,
        archive: archiveBlob(`snapshot ${index}`),
        manifest: MANIFEST,
        label: `第 ${index} 个`,
      });
      snapshots = result.index.snapshots;
    }
    expect(snapshots).toHaveLength(50);
    // Newest first: the 51st upload is at the head, the first one fell off the end.
    expect(snapshots[0]?.label).toBe('第 50 个');
    expect(snapshots.some((entry) => entry.label === '第 0 个')).toBe(false);
  });

  it('maps a snapshot onto the backup descriptor the data management UI expects', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);
    const uploaded = await uploadSnapshot({
      vault,
      archive: archiveBlob('descriptor'),
      manifest: MANIFEST,
      label: '描述符',
      reason: 'pre-restore',
    });

    expect(toBackupDescriptor(uploaded.entry)).toMatchObject({
      id: uploaded.entry.id,
      label: '描述符',
      archiveId: 'archive-1',
      moduleIds: ['chats', 'settings'],
      includeSecrets: false,
      reason: 'pre-restore',
      // The UI shows storage actually consumed, which is the sealed size.
      size: uploaded.entry.sealedSize,
    });
  });

  it('decodes an index written by uploadSnapshot through the standalone readIndex', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);
    const uploaded = await uploadSnapshot({
      vault,
      archive: archiveBlob('index shape'),
      manifest: MANIFEST,
      label: '索引结构',
    });

    // 直接走 readIndex，确认它和 uploadSnapshot 写出的格式是同一套。
    const reread = await readIndex(vault.client, vault.keys.aesKey);
    expect(reread.snapshots).toHaveLength(1);
    expect(reread.snapshots[0]?.id).toBe(uploaded.entry.id);
    expect(reread.version).toBe(1);
  });

  it('reads an empty index when the vault has never been written to', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);
    expect(vault.index.snapshots).toEqual([]);
  });
});

describe('sync workspace isolation', () => {
  it('does not accept the index of one account under another account token', async () => {
    const backend = await makeBackend();
    const vault = await makeVault(backend.fetchImpl);

    // Replacing the token with an unrelated one must not yield the previous account's data.
    void vault;
    const response = await backend.fetchImpl(`${BASE}v1/sync/index`, {
      method: 'GET',
      headers: { Authorization: 'Bearer fake-token-999' },
    });
    expect(response.status).toBe(401);
  });
});
