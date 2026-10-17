/**
 * The legacy data-management panel is a plain script in `runtime/index.js`; it cannot import TypeScript.
 * This bridge follows the same pattern the import pipeline already uses
 * (`__PURE_TAVERN_DATA_STREAMING__`): keep the crypto and the archive objects in the bundled realm,
 * expose a small method surface on `globalThis`, and let the panel stay a dumb view.
 *
 * The unlocked vault lives in a closure variable. Closing the tab, reloading, or pressing 锁定 drops the
 * derived key — that is the intended lifetime, and it is why the key is never written to storage.
 */

import type { BackupDescriptor } from '@pure-tavern/contracts';

import type { ArchiveService } from '../application/archive-service';
import type { ArchiveExportOptions } from '../domain/archive';

import { SyncClientError } from './sync-client';
import {
  deleteSnapshot,
  downloadSnapshot,
  toBackupDescriptor,
  unlockVault,
  uploadSnapshot,
  type UnlockedVault,
} from './sync-vault';

const REMEMBERED_ENDPOINT_KEY = 'pure-tavern-sync-endpoint';
const REMEMBERED_USERNAME_KEY = 'pure-tavern-sync-username';

export interface SyncUnlockedState {
  baseUrl: string;
  username: string;
  accountId: string;
}

export interface SyncUploadInput {
  label?: string;
  moduleIds?: readonly string[];
  includeSecrets?: boolean;
  reason?: 'manual' | 'pre-import' | 'pre-restore';
}

export interface SyncVaultBridge {
  /** Empty string when this browser has never saved an endpoint. */
  remembered(): { baseUrl: string; username: string };
  state(): SyncUnlockedState | null;
  unlock(input: {
    baseUrl: string;
    username: string;
    password: string;
    register: boolean;
    remember: boolean;
  }): Promise<{ state: SyncUnlockedState; snapshots: BackupDescriptor[] }>;
  lock(): void;
  list(): BackupDescriptor[];
  upload(input: SyncUploadInput): Promise<BackupDescriptor[]>;
  download(id: string): Promise<{ fileName: string; blob: Blob }>;
  remove(id: string): Promise<BackupDescriptor[]>;
}

declare global {
  var __PURE_TAVERN_SYNC_VAULT__: SyncVaultBridge | undefined;
}

export function installSyncVaultBridge(archive: ArchiveService): SyncVaultBridge {
  let vault: UnlockedVault | null = null;

  const requireVault = (): UnlockedVault => {
    if (!vault) throw new SyncClientError('locked', '云端保险库还没解锁。');
    return vault;
  };

  const bridge: SyncVaultBridge = {
    remembered() {
      try {
        return {
          baseUrl: globalThis.localStorage?.getItem(REMEMBERED_ENDPOINT_KEY) ?? '',
          username: globalThis.localStorage?.getItem(REMEMBERED_USERNAME_KEY) ?? '',
        };
      } catch {
        return { baseUrl: '', username: '' };
      }
    },

    state() {
      if (!vault) return null;
      return {
        baseUrl: vault.client.session.baseUrl,
        username: vault.username,
        accountId: vault.client.session.accountId,
      };
    },

    async unlock(input) {
      // A failed unlock must not leave the previous vault open under a different passphrase.
      vault = null;
      const unlocked = await unlockVault({
        baseUrl: input.baseUrl,
        username: input.username,
        password: input.password,
        register: input.register,
      });
      vault = unlocked;
      if (input.remember) {
        try {
          globalThis.localStorage?.setItem(
            REMEMBERED_ENDPOINT_KEY,
            unlocked.client.session.baseUrl,
          );
          globalThis.localStorage?.setItem(REMEMBERED_USERNAME_KEY, unlocked.username);
        } catch {
          // Private mode: remembering the endpoint is a convenience, not a requirement.
        }
      }
      return {
        state: {
          baseUrl: unlocked.client.session.baseUrl,
          username: unlocked.username,
          accountId: unlocked.client.session.accountId,
        },
        snapshots: unlocked.index.snapshots.map(toBackupDescriptor),
      };
    },

    lock() {
      vault = null;
    },

    list() {
      return vault ? vault.index.snapshots.map(toBackupDescriptor) : [];
    },

    async upload(input) {
      const current = requireVault();
      const options: ArchiveExportOptions = {};
      if (input.moduleIds && input.moduleIds.length > 0) options.moduleIds = [...input.moduleIds];
      if (input.includeSecrets !== undefined) options.includeSecrets = input.includeSecrets;

      const exported = await archive.exportArchive(options);
      const result = await uploadSnapshot({
        vault: current,
        archive: exported.blob,
        manifest: exported.manifest,
        label: input.label?.trim() || exported.fileName,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      current.index.snapshots = result.index.snapshots;
      return result.index.snapshots.map(toBackupDescriptor);
    },

    async download(id) {
      const current = requireVault();
      const entry = current.index.snapshots.find((snapshot) => snapshot.id === id);
      const file = await downloadSnapshot(current, id, `pure-tavern-${entry?.archiveId || id}.zip`);
      return { fileName: file.name, blob: file };
    },

    async remove(id) {
      const current = requireVault();
      const result = await deleteSnapshot(current, id);
      current.index.snapshots = result.index.snapshots;
      return result.index.snapshots.map(toBackupDescriptor);
    },
  };

  globalThis.__PURE_TAVERN_SYNC_VAULT__ = bridge;
  return bridge;
}
