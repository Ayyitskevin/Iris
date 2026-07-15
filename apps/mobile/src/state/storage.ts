/**
 * A tiny key/value persistence adapter — the local-first substrate. On web it uses
 * localStorage; on native, expo-secure-store. Credentials and owner replicas use
 * separate keys. Transactional SQLite/IndexedDB replica storage remains a documented
 * release follow-up; persistence failures are surfaced by the owner store.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const webStore: KVStore = {
  async get(key) {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  },
  async set(key, value) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  },
  async remove(key) {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

// SecureStore has a small per-value ceiling. It protects credentials, but larger owner
// replicas belong in the planned native database; callers must surface write failure.
const nativeStore: KVStore = {
  get: (key) => SecureStore.getItemAsync(sanitize(key)),
  set: (key, value) => SecureStore.setItemAsync(sanitize(key), value),
  remove: (key) => SecureStore.deleteItemAsync(sanitize(key)),
};

function sanitize(key: string): string {
  // SecureStore keys must be alphanumeric + ._- ; map anything else.
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export const storage: KVStore = Platform.OS === 'web' ? webStore : nativeStore;
