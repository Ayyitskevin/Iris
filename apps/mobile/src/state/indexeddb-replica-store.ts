/**
 * IndexedDB implementation of the revisioned owner-replica store.
 *
 * The adapter fails loud when IndexedDB is unavailable. Runtime selection and
 * localStorage promotion intentionally live in a later, explicitly fenced cutover.
 */
import {
  assertTransactionalReplicaRecord,
  TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
  type CompareAndSwapResult,
  type TransactionalReplicaRecord,
  type TransactionalReplicaStore,
} from './transactional-replica-repository';
import { assertSerializedReplicaOwner, ReplicaRepositoryError } from './replica-repository';

const DATABASE_VERSION = 1;
const REPLICA_STORE_NAME = 'owner_replicas';

function transactionError(message: string, error: unknown): ReplicaRepositoryError {
  return new ReplicaRepositoryError(message, { cause: error });
}

export class IndexedDbTransactionalReplicaStore implements TransactionalReplicaStore {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    private readonly databaseName = 'iris-owner-replicas',
  ) {}

  async read(ownerKey: string): Promise<TransactionalReplicaRecord | null> {
    const database = await this.open();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(REPLICA_STORE_NAME, 'readonly');
    } catch (cause) {
      throw transactionError('IndexedDB owner replica read could not start', cause);
    }
    const request = transaction.objectStore(REPLICA_STORE_NAME).get(ownerKey) as IDBRequest<
      TransactionalReplicaRecord | undefined
    >;

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        try {
          const record = request.result ?? null;
          if (record) assertTransactionalReplicaRecord(ownerKey, record);
          resolve(record);
        } catch (cause) {
          reject(transactionError('IndexedDB owner replica record is invalid', cause));
        }
      };
      transaction.onerror = () => {
        reject(transactionError('IndexedDB owner replica read failed', transaction.error));
      };
      transaction.onabort = () => {
        reject(transactionError('IndexedDB owner replica read was aborted', transaction.error));
      };
    });
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
      throw new ReplicaRepositoryError('IndexedDB owner replica expected revision is invalid');
    }
    assertSerializedReplicaOwner(ownerKey, serializedReplica);

    const database = await this.open();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(REPLICA_STORE_NAME, 'readwrite');
    } catch (cause) {
      throw transactionError('IndexedDB owner replica transaction could not start', cause);
    }
    const objectStore = transaction.objectStore(REPLICA_STORE_NAME);
    const request = objectStore.get(ownerKey) as IDBRequest<TransactionalReplicaRecord | undefined>;

    return new Promise((resolve, reject) => {
      let result: CompareAndSwapResult | undefined;
      let validationError: unknown;

      request.onsuccess = () => {
        try {
          const current = request.result ?? null;
          if (current) assertTransactionalReplicaRecord(ownerKey, current);
          if ((current?.revision ?? 0) !== expectedRevision) {
            result = { status: 'conflict', record: current };
            return;
          }

          const record: TransactionalReplicaRecord = {
            schemaVersion: TRANSACTIONAL_REPLICA_SCHEMA_VERSION,
            ownerKey,
            revision: expectedRevision + 1,
            serializedReplica,
          };
          objectStore.put(record);
          result = { status: 'committed', record };
        } catch (cause) {
          validationError = cause;
          transaction.abort();
        }
      };

      transaction.oncomplete = () => {
        if (!result) {
          reject(
            transactionError(
              'IndexedDB owner replica transaction completed without a result',
              validationError,
            ),
          );
          return;
        }
        resolve(result);
      };
      transaction.onerror = () => {
        reject(
          transactionError(
            'IndexedDB owner replica transaction failed',
            validationError ?? transaction.error,
          ),
        );
      };
      transaction.onabort = () => {
        reject(
          transactionError(
            'IndexedDB owner replica transaction was aborted',
            validationError ?? transaction.error,
          ),
        );
      };
    });
  }

  async erase(ownerKey: string): Promise<void> {
    if (!ownerKey) {
      throw new ReplicaRepositoryError('IndexedDB owner replica erase requires an owner key');
    }
    const database = await this.open();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(REPLICA_STORE_NAME, 'readwrite');
    } catch (cause) {
      throw transactionError('IndexedDB owner replica erase could not start', cause);
    }
    transaction.objectStore(REPLICA_STORE_NAME).delete(ownerKey);

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(transactionError('IndexedDB owner replica erase failed', transaction.error));
      };
      transaction.onabort = () => {
        reject(transactionError('IndexedDB owner replica erase was aborted', transaction.error));
      };
    });

    // Verify-after-delete: a partial delete must not be reported as success.
    const remaining = await this.read(ownerKey);
    if (remaining !== null) {
      throw new ReplicaRepositoryError('IndexedDB owner replica erase did not clear durable storage');
    }
  }

  async close(): Promise<void> {
    const opening = this.opening;
    if (!opening) return;
    try {
      const database = await opening;
      database.close();
      if (this.database === database) this.database = null;
      if (this.opening === opening) this.opening = null;
    } catch {
      // A failed open already reset its cached promise.
    }
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(
        new ReplicaRepositoryError('IndexedDB is unavailable for owner replica storage'),
      );
    }
    if (this.database) return Promise.resolve(this.database);
    if (this.opening) return this.opening;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(this.databaseName, DATABASE_VERSION);
      let rejected = false;

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(REPLICA_STORE_NAME)) {
          database.createObjectStore(REPLICA_STORE_NAME, { keyPath: 'ownerKey' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (rejected) {
          database.close();
          return;
        }
        this.database = database;
        database.onversionchange = () => {
          database.close();
          if (this.database === database) {
            this.database = null;
            this.opening = null;
          }
        };
        resolve(database);
      };
      request.onerror = () => {
        rejected = true;
        reject(transactionError('IndexedDB owner replica database could not open', request.error));
      };
      request.onblocked = () => {
        rejected = true;
        reject(new ReplicaRepositoryError('IndexedDB owner replica database upgrade was blocked'));
      };
    });

    const cachedOpening = opening.catch((error: unknown) => {
      if (this.opening === cachedOpening) this.opening = null;
      throw error;
    });
    this.opening = cachedOpening;
    return cachedOpening;
  }
}
