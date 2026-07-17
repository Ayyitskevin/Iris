/**
 * Native opener for the SQLite owner-replica store (ADR-020).
 *
 * Metro resolves this `.native.ts` file on iOS/Android; web and Node/test resolve the
 * `open-expo-sqlite-store.ts` stub, so `expo-sqlite` only ever enters a native bundle.
 * Even here `expo-sqlite` is imported lazily, so the binding loads only when durable
 * storage is actually selected.
 */
import {
  ExpoSqliteTransactionalReplicaStore,
  type ReplicaSqliteDatabase,
} from './expo-sqlite-replica-store';
import type { TransactionalReplicaStore } from './transactional-replica-repository';

export async function openExpoSqliteReplicaStore(
  databaseName = 'iris-owner-replicas.db',
): Promise<TransactionalReplicaStore> {
  const SQLite = await import('expo-sqlite');
  const database = await SQLite.openDatabaseAsync(databaseName);
  return new ExpoSqliteTransactionalReplicaStore(database as unknown as ReplicaSqliteDatabase);
}
