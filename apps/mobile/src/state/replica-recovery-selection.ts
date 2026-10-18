import { assertReplicaRecoverySnapshot } from './replica-recovery-journal';

export const REPLICA_RECOVERY_VIEW_VERSION = 1 as const;
const RECOVERY_VIEW_PREFIX = 'iris.recovery-view.v1.';
const RECOVERY_VIEW_KEYS = [
  'ownerKey',
  'sequence',
  'serializedReplica',
  'sourceOwnerKey',
  'version',
] as const;

const RECOVERY_CREDENTIAL_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'session',
  'token',
]);

export interface ReplicaRecoveryViewSelection {
  version: typeof REPLICA_RECOVERY_VIEW_VERSION;
  ownerKey: string;
  sourceOwnerKey: string;
  sequence: number;
  serializedReplica: string;
}

export class ReplicaRecoveryViewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplicaRecoveryViewError';
  }
}

/**
 * Domain-separate the view selection from the primary replica and the recovery journal.
 *
 * The owner identifier is already part of the primary replica key. Encoding it here avoids
 * delimiter ambiguity without treating the storage key as encryption.
 */
export function replicaRecoveryViewOwnerKey(sourceOwnerKey: string): string {
  if (!sourceOwnerKey) {
    throw new ReplicaRecoveryViewError('Recovery view source owner is required');
  }
  return RECOVERY_VIEW_PREFIX + encodeURIComponent(sourceOwnerKey);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertNoCredentialFields(value: unknown): void {
  const candidates: unknown[] = [value];
  while (candidates.length > 0) {
    const candidate = candidates.pop();
    if (!candidate || typeof candidate !== 'object') continue;
    if (Array.isArray(candidate)) {
      candidates.push(...candidate);
      continue;
    }
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (RECOVERY_CREDENTIAL_FIELD_NAMES.has(normalized)) {
        throw new ReplicaRecoveryViewError(
          'Recovery view selection contains a credential-like field',
        );
      }
      candidates.push(nested);
    }
  }
}

export function parseReplicaRecoveryView(
  raw: string,
  sourceOwnerKey: string,
): ReplicaRecoveryViewSelection {
  const ownerKey = replicaRecoveryViewOwnerKey(sourceOwnerKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ReplicaRecoveryViewError('Recovery view selection is not valid JSON', { cause });
  }
  assertNoCredentialFields(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReplicaRecoveryViewError('Recovery view selection envelope is invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, RECOVERY_VIEW_KEYS) ||
    value.version !== REPLICA_RECOVERY_VIEW_VERSION ||
    value.ownerKey !== ownerKey ||
    value.sourceOwnerKey !== sourceOwnerKey ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.serializedReplica !== 'string'
  ) {
    throw new ReplicaRecoveryViewError('Recovery view selection ownership or shape is invalid');
  }
  try {
    assertReplicaRecoverySnapshot(sourceOwnerKey, value.serializedReplica);
  } catch (cause) {
    throw new ReplicaRecoveryViewError('Recovery view selection replica is invalid', { cause });
  }
  return Object.freeze({
    version: REPLICA_RECOVERY_VIEW_VERSION,
    ownerKey,
    sourceOwnerKey,
    sequence: value.sequence as number,
    serializedReplica: value.serializedReplica,
  });
}

export function serializeReplicaRecoveryView(
  selection: Pick<
    ReplicaRecoveryViewSelection,
    'sourceOwnerKey' | 'sequence' | 'serializedReplica'
  >,
): string {
  const raw = JSON.stringify({
    version: REPLICA_RECOVERY_VIEW_VERSION,
    ownerKey: replicaRecoveryViewOwnerKey(selection.sourceOwnerKey),
    sourceOwnerKey: selection.sourceOwnerKey,
    sequence: selection.sequence,
    serializedReplica: selection.serializedReplica,
  });
  parseReplicaRecoveryView(raw, selection.sourceOwnerKey);
  return raw;
}
