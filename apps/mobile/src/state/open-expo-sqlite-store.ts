/**
 * Fallback opener for platforms without `expo-sqlite` — web and Node/test.
 *
 * The real native implementation lives in `open-expo-sqlite-store.native.ts`. Metro resolves
 * the `.native.ts` file for iOS/Android and this file for web, and vitest/tsc resolve this
 * file too, so `expo-sqlite` (and its web SQLite module chain) never enters the web or test
 * bundles. Native durable storage is only selected on a React Native runtime, where the
 * native file is what loads.
 */
import { ReplicaRepositoryError } from './replica-repository';
import type { TransactionalReplicaStore } from './transactional-replica-repository';

export function openExpoSqliteReplicaStore(
  _databaseName?: string,
): Promise<TransactionalReplicaStore> {
  return Promise.reject(
    new ReplicaRepositoryError('SQLite owner-replica storage is unavailable on this platform'),
  );
}
