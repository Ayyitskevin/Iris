/**
 * SQLite implementation of the revisioned owner-replica store (ADR-020) — the native
 * counterpart to `IndexedDbTransactionalReplicaStore` (ADR-017). Like that one, it is a
 * platform storage PRIMITIVE and is deliberately NOT selected by the runtime yet:
 * owner-specific promotion of the existing SecureStore/localStorage replica and the
 * `/v1`→`/v2` coordinator cutover are the later, explicitly fenced work (plan A3).
 *
 * The store depends only on a tiny async SQLite seam (`ReplicaSqliteDatabase`), which the
 * real app satisfies with an `expo-sqlite` database and tests satisfy with `node:sqlite`.
 * That keeps the compare-and-swap logic verifiable against real SQLite off-device; native
 * force-quit durability and true multi-connection concurrency remain device-acceptance
 * gates (as with the IndexedDB primitive's real-browser gate).
 */
import {
  assertTransactionalReplicaRecord,
  TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
  type CompareAndSwapResult,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';
import { assertSerializedReplicaOwner, ReplicaRepositoryError } from './replica-repository';

export type ReplicaSqliteParam = string | number | null;

/** The read/write subset used inside a transaction — satisfied by expo-sqlite + node:sqlite. */
export interface ReplicaSqliteRunner {
  getFirstAsync<T>(source: string, ...params: ReplicaSqliteParam[]): Promise<T | null>;
  runAsync(source: string, ...params: ReplicaSqliteParam[]): Promise<unknown>;
}

/** A database handle that can run DDL and exclusive (write-locked) transactions. */
export interface ReplicaSqliteDatabase extends ReplicaSqliteRunner {
  execAsync(source: string): Promise<void>;
  withExclusiveTransactionAsync(task: (txn: ReplicaSqliteRunner) => Promise<void>): Promise<void>;
}

const TABLE = 'owner_replicas';
const SELECT =
  `SELECT schema_version AS schemaVersion, owner_key AS ownerKey, revision AS revision, ` +
  `serialized_replica AS serializedReplica FROM ${TABLE} WHERE owner_key = ?`;

interface ReplicaRow {
  schemaVersion: number;
  ownerKey: string;
  revision: number;
  serializedReplica: string;
}

function toValidatedRecord(
  ownerKey: string,
  row: ReplicaRow | null,
): TransactionalReplicaRecord | null {
  if (!row) return null;
  const record: TransactionalReplicaRecord = {
    schemaVersion: row.schemaVersion as typeof TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
    ownerKey: row.ownerKey,
    revision: row.revision,
    serializedReplica: row.serializedReplica,
  };
  // Fail loud on a misrouted/corrupt row exactly like the IndexedDB store does.
  assertTransactionalReplicaRecord(ownerKey, record);
  return record;
}

export class ExpoSqliteTransactionalReplicaStore implements TransactionalReplicaStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly db: ReplicaSqliteDatabase) {}

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.db
        .execAsync(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
            `owner_key TEXT PRIMARY KEY NOT NULL, ` +
            `schema_version INTEGER NOT NULL, ` +
            `revision INTEGER NOT NULL, ` +
            `serialized_replica TEXT NOT NULL)`,
        )
        .catch((error: unknown) => {
          // Let a later call retry rather than caching a rejected schema promise forever.
          this.schemaReady = null;
          throw new ReplicaRepositoryError('SQLite owner replica schema could not be created', {
            cause: error,
          });
        });
    }
    return this.schemaReady;
  }

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    await this.ensureSchema();
    let row: ReplicaRow | null;
    try {
      row = await this.db.getFirstAsync<ReplicaRow>(SELECT, ownerKey);
    } catch (cause) {
      throw new ReplicaRepositoryError('SQLite owner replica read failed', { cause });
    }
    try {
      return toValidatedRecord(ownerKey, row);
    } catch (cause) {
      throw new ReplicaRepositoryError('SQLite owner replica record is invalid', { cause });
    }
  }

  async compareAndSwap(
    ownerKey: string,
    expectedRevision: number,
    serializedReplica: string,
  ): Promise<CompareAndSwapResult> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new ReplicaRepositoryError('SQLite owner replica expected revision is invalid');
    }
    assertSerializedReplicaOwner(ownerKey, serializedReplica);
    await this.ensureSchema();

    let result: CompareAndSwapResult | undefined;
    let validationError: unknown;

    try {
      // The exclusive (write-locked) transaction is what serializes concurrent swaps —
      // two connections cannot both read the same revision and both write revision+1.
      await this.db.withExclusiveTransactionAsync(async (txn) => {
        const row = await txn.getFirstAsync<ReplicaRow>(SELECT, ownerKey);
        let current: TransactionalReplicaRecord | null;
        try {
          current = toValidatedRecord(ownerKey, row);
        } catch (cause) {
          validationError = cause;
          throw cause; // roll back the transaction; never overwrite a corrupt row
        }

        if ((current?.revision ?? 0) !== expectedRevision) {
          result = { status: 'conflict', record: current };
          return; // commit an empty transaction — no write happened
        }

        const record: TransactionalReplicaRecord = {
          schemaVersion: TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
          ownerKey,
          revision: expectedRevision + 1,
          serializedReplica,
        };
        await txn.runAsync(
          `INSERT INTO ${TABLE} (owner_key, schema_version, revision, serialized_replica) ` +
            `VALUES (?, ?, ?, ?) ` +
            `ON CONFLICT(owner_key) DO UPDATE SET ` +
            `schema_version = excluded.schema_version, ` +
            `revision = excluded.revision, ` +
            `serialized_replica = excluded.serialized_replica`,
          ownerKey,
          record.schemaVersion,
          record.revision,
          record.serializedReplica,
        );
        result = { status: 'committed', record };
      });
    } catch (cause) {
      if (validationError) {
        throw new ReplicaRepositoryError('SQLite owner replica record is invalid', {
          cause: validationError,
        });
      }
      throw new ReplicaRepositoryError('SQLite owner replica transaction failed', { cause });
    }

    if (!result) {
      throw new ReplicaRepositoryError(
        'SQLite owner replica transaction completed without a result',
      );
    }
    return result;
  }

  async erase(ownerKey: string): Promise<void> {
    if (!ownerKey) {
      throw new ReplicaRepositoryError('SQLite owner replica erase requires an owner key');
    }
    await this.ensureSchema();
    try {
      await this.db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync(`DELETE FROM ${TABLE} WHERE owner_key = ?`, ownerKey);
      });
    } catch (cause) {
      throw new ReplicaRepositoryError('SQLite owner replica erase failed', { cause });
    }

    const remaining = await this.read(ownerKey);
    if (remaining !== null) {
      throw new ReplicaRepositoryError('SQLite owner replica erase did not clear durable storage');
    }
  }
}

// The `expo-sqlite`-backed opener lives in `open-expo-sqlite-store.native.ts` (with a web/Node
// stub in `open-expo-sqlite-store.ts`), so `expo-sqlite` is only ever pulled into a native
// bundle. This module stays free of any `expo-sqlite` reference so it loads under web + Node.
