/**
 * Transport for the sync vault in `PureTavern-Backend`.
 *
 * This file knows nothing about encryption. It only moves opaque bytes and manages the session token,
 * which keeps the crypto honest: if a future change accidentally uploads plaintext, it will not be
 * because this layer had access to plaintext.
 */

export const SYNC_PROTOCOL_VERSION = 1;

export class SyncClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'SyncClientError';
    this.code = code;
    this.status = status;
  }
}

export interface SyncSession {
  readonly baseUrl: string;
  readonly token: string;
  readonly username: string;
  readonly accountId: string;
}

export interface SyncSnapshotEntry {
  /** R2 object id. Also the handle the UI passes back on download/delete. */
  id: string;
  label: string;
  createdAt: string;
  /** Plaintext archive size, so the list shows something meaningful. */
  size: number;
  /** Ciphertext size actually stored — differs from `size` by the GCM tag and IV. */
  sealedSize: number;
  archiveId: string;
  moduleIds: string[];
  includeSecrets: boolean;
  reason: 'manual' | 'pre-import' | 'pre-restore';
  /** Random per-browser id so the list can say "这台设备". Never identifies a person. */
  deviceId: string;
}

export interface SyncIndex {
  version: number;
  updatedAt: string;
  snapshots: SyncSnapshotEntry[];
}

export function emptyIndex(): SyncIndex {
  return { version: 1, updatedAt: new Date(0).toISOString(), snapshots: [] };
}

/**
 * Mirrors the server's rules plus the frontend's own: absolute http(s), no credentials in the URL,
 * no query, no fragment, trailing slash. Rejecting early gives a readable message instead of a
 * confusing CORS failure inside `fetch`.
 */
export function normalizeSyncBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SyncClientError(
      'invalid-url',
      '请填写后端地址，例如 https://pure-tavern-backend.<子域>.workers.dev/',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SyncClientError('invalid-url', '后端地址不是合法 URL，需要以 https:// 开头。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SyncClientError('invalid-url', '后端地址只能是 http 或 https。');
  }
  if (url.username || url.password) {
    throw new SyncClientError('invalid-url', '后端地址里不能带用户名或密码。');
  }
  if (url.search || url.hash) {
    throw new SyncClientError('invalid-url', '后端地址里不能带查询参数或锚点。');
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.toString();
}

interface SyncClientOptions {
  baseUrl: string;
  token: string;
  username: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}

export class SyncClient {
  readonly session: SyncSession;
  readonly #fetch: typeof fetch;

  constructor(options: SyncClientOptions) {
    this.session = {
      baseUrl: normalizeSyncBaseUrl(options.baseUrl),
      token: options.token,
      username: options.username,
      accountId: options.accountId,
    };
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** @internal exposed for the vault so it does not need to duplicate URL joining. */
  endpoint(path: string): string {
    return new URL(path.replace(/^\//u, ''), this.session.baseUrl).toString();
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.session.token}`, ...extra };
  }

  async readIndex(): Promise<Uint8Array | null> {
    const response = await this.#fetch(this.endpoint('v1/sync/index'), {
      method: 'GET',
      headers: this.#headers(),
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    await assertOk(response, '读取云端索引失败');
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeIndex(body: Uint8Array): Promise<void> {
    const response = await this.#fetch(this.endpoint('v1/sync/index'), {
      method: 'PUT',
      headers: this.#headers({ 'Content-Type': 'application/octet-stream' }),
      body: toBodyInit(body),
    });
    await assertOk(response, '写入云端索引失败');
  }

  async readObject(id: string): Promise<Uint8Array | null> {
    const response = await this.#fetch(this.endpoint(`v1/sync/objects/${encodeURIComponent(id)}`), {
      method: 'GET',
      headers: this.#headers(),
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    await assertOk(response, '下载云端快照失败');
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeObject(id: string, body: Uint8Array): Promise<void> {
    const response = await this.#fetch(this.endpoint(`v1/sync/objects/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: this.#headers({ 'Content-Type': 'application/octet-stream' }),
      body: toBodyInit(body),
    });
    await assertOk(response, '上传快照失败');
  }

  async deleteObject(id: string): Promise<boolean> {
    const response = await this.#fetch(this.endpoint(`v1/sync/objects/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.#headers(),
    });
    if (response.status === 404) return false;
    await assertOk(response, '删除云端快照失败');
    return true;
  }
}

export interface SyncCredentialsResult {
  token: string;
  username: string;
  accountId: string;
}

/** Register and login are the only pre-session calls, so they live outside `SyncClient`. */
export async function authenticateSync(input: {
  baseUrl: string;
  username: string;
  verifier: string;
  mode: 'login' | 'register';
  fetchImpl?: typeof fetch;
}): Promise<SyncCredentialsResult> {
  const base = normalizeSyncBaseUrl(input.baseUrl);
  const doFetch = input.fetchImpl ?? ((request, init) => fetch(request, init));
  const endpoint = new URL(`v1/sync/${input.mode}`, base).toString();

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: input.username, verifier: input.verifier }),
      cache: 'no-store',
    });
  } catch {
    // fetch only throws on network-level failure; CORS rejection lands here too, so the message has
    // to cover both without guessing which one it was.
    throw new SyncClientError(
      'unreachable',
      `连不上 ${base}。检查地址是否正确、后端是否在线，以及该域名是否在后端允许来源里。`,
    );
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw mapAuthError(response.status, payload);
  }
  const record = asRecord(payload);
  const token = typeof record.token === 'string' ? record.token : '';
  const username = typeof record.username === 'string' ? record.username : '';
  const accountId = typeof record.accountId === 'string' ? record.accountId : '';
  if (!token || !username || !accountId) {
    throw new SyncClientError('protocol', '后端返回的凭据不完整，可能是版本不匹配。');
  }
  return { token, username, accountId };
}

async function assertOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  const payload = await readJson(response);
  const error = asRecord(asRecord(payload).error);
  const code = typeof error.code === 'string' ? error.code : 'http-error';
  const message =
    typeof error.message === 'string' ? error.message : `${fallback}（HTTP ${response.status}）`;
  if (response.status === 401) {
    throw new SyncClientError('unauthorized', '会话已失效，请重新解锁。', 401);
  }
  if (response.status === 413) {
    throw new SyncClientError('payload-too-large', '单个快照超过 100 MB，后端拒绝接收。', 413);
  }
  throw new SyncClientError(code, message, response.status);
}

function mapAuthError(status: number, payload: unknown): SyncClientError {
  const error = asRecord(asRecord(payload).error);
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'account-exists') {
    return new SyncClientError(
      'account-exists',
      '这个用户名已被占用；如果是你自己之前注册的，直接解锁即可。',
      status,
    );
  }
  if (code === 'invalid-credentials' && status === 401) {
    return new SyncClientError(
      'invalid-credentials',
      '用户名或同步密码不对。注意密码不区分设备，但区分大小写。',
      status,
    );
  }
  if (status === 400) {
    return new SyncClientError(
      'invalid-request',
      '用户名或验证串格式不对，请用 3–32 位小写用户名。',
      status,
    );
  }
  const message = typeof error.message === 'string' ? error.message : `鉴权失败（HTTP ${status}）`;
  return new SyncClientError(code || 'auth-failed', message, status);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `Uint8Array` is a valid BodyInit but TS's DOM lib narrows it under some `lib` sets. */
function toBodyInit(bytes: Uint8Array): BodyInit {
  return bytes.slice().buffer as ArrayBuffer;
}
