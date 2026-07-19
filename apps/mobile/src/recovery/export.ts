import {
  assertReplicaRecoverySnapshot,
  parseReplicaRecoveryEnvelope,
  REPLICA_RECOVERY_JOURNAL_VERSION,
  replicaRecoveryJournalOwnerKey,
  type ReplicaRecoveryEnvelope,
  type ReplicaRecoverySnapshot,
} from '../state/replica-recovery-journal';

export const REPLICA_RECOVERY_EXPORT_FORMAT = 'iris.local-recovery-export' as const;
export const REPLICA_RECOVERY_EXPORT_VERSION = 1 as const;

export type ReplicaRecoveryExportDisplayed =
  | {
      kind: 'journal-match';
      sequences: number[];
    }
  | {
      kind: 'embedded';
      serializedReplica: string;
    };

export interface ReplicaRecoveryExport {
  format: typeof REPLICA_RECOVERY_EXPORT_FORMAT;
  version: typeof REPLICA_RECOVERY_EXPORT_VERSION;
  exportedAt: string;
  sourceOwnerKey: string;
  journalVersion: typeof REPLICA_RECOVERY_JOURNAL_VERSION;
  snapshots: ReplicaRecoverySnapshot[];
  displayed: ReplicaRecoveryExportDisplayed;
}

export class ReplicaRecoveryExportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReplicaRecoveryExportError';
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function strictIsoTimestamp(value: unknown, description: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ReplicaRecoveryExportError(description + ' is invalid');
  }
  return value;
}

function freezeExport(value: ReplicaRecoveryExport): ReplicaRecoveryExport {
  const snapshots = value.snapshots.map((snapshot) => Object.freeze({ ...snapshot }));
  const displayed =
    value.displayed.kind === 'journal-match'
      ? Object.freeze({
          ...value.displayed,
          sequences: Object.freeze([...value.displayed.sequences]),
        })
      : Object.freeze({ ...value.displayed });
  return Object.freeze({
    ...value,
    snapshots: Object.freeze(snapshots),
    displayed,
  }) as ReplicaRecoveryExport;
}

export function createReplicaRecoveryExport(input: {
  envelope: ReplicaRecoveryEnvelope;
  displayedSerializedReplica: string;
  exportedAt: string;
}): string {
  const exportedAt = strictIsoTimestamp(input.exportedAt, 'Recovery export timestamp');
  const envelope = parseReplicaRecoveryEnvelope(
    JSON.stringify(input.envelope),
    input.envelope.sourceOwnerKey,
  );
  assertReplicaRecoverySnapshot(envelope.sourceOwnerKey, input.displayedSerializedReplica);
  const matchingSequences = envelope.snapshots
    .filter((snapshot) => snapshot.serializedReplica === input.displayedSerializedReplica)
    .map((snapshot) => snapshot.sequence);
  const displayed: ReplicaRecoveryExportDisplayed =
    matchingSequences.length > 0
      ? { kind: 'journal-match', sequences: matchingSequences }
      : { kind: 'embedded', serializedReplica: input.displayedSerializedReplica };
  const artifact = freezeExport({
    format: REPLICA_RECOVERY_EXPORT_FORMAT,
    version: REPLICA_RECOVERY_EXPORT_VERSION,
    exportedAt,
    sourceOwnerKey: envelope.sourceOwnerKey,
    journalVersion: REPLICA_RECOVERY_JOURNAL_VERSION,
    snapshots: envelope.snapshots,
    displayed,
  });
  return JSON.stringify(artifact);
}

export function parseReplicaRecoveryExport(
  raw: string,
  expectedSourceOwnerKey: string,
): ReplicaRecoveryExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ReplicaRecoveryExportError('Recovery export is not valid JSON', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReplicaRecoveryExportError('Recovery export envelope is invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, [
      'displayed',
      'exportedAt',
      'format',
      'journalVersion',
      'snapshots',
      'sourceOwnerKey',
      'version',
    ]) ||
    value.format !== REPLICA_RECOVERY_EXPORT_FORMAT ||
    value.version !== REPLICA_RECOVERY_EXPORT_VERSION ||
    value.journalVersion !== REPLICA_RECOVERY_JOURNAL_VERSION ||
    value.sourceOwnerKey !== expectedSourceOwnerKey ||
    !Array.isArray(value.snapshots)
  ) {
    throw new ReplicaRecoveryExportError('Recovery export ownership or shape is invalid');
  }
  const exportedAt = strictIsoTimestamp(value.exportedAt, 'Recovery export timestamp');
  const envelope = parseReplicaRecoveryEnvelope(
    JSON.stringify({
      version: value.journalVersion,
      ownerKey: replicaRecoveryJournalOwnerKey(expectedSourceOwnerKey),
      sourceOwnerKey: expectedSourceOwnerKey,
      snapshots: value.snapshots,
    }),
    expectedSourceOwnerKey,
  );

  if (!value.displayed || typeof value.displayed !== 'object' || Array.isArray(value.displayed)) {
    throw new ReplicaRecoveryExportError('Recovery export displayed projection is invalid');
  }
  const displayedValue = value.displayed as Record<string, unknown>;
  let displayed: ReplicaRecoveryExportDisplayed;
  if (
    displayedValue.kind === 'journal-match' &&
    exactKeys(displayedValue, ['kind', 'sequences']) &&
    Array.isArray(displayedValue.sequences) &&
    displayedValue.sequences.length === 1 &&
    displayedValue.sequences.every(
      (sequence) => Number.isSafeInteger(sequence) && (sequence as number) > 0,
    )
  ) {
    const sequences = displayedValue.sequences as number[];
    if (
      new Set(sequences).size !== sequences.length ||
      sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1]!)
    ) {
      throw new ReplicaRecoveryExportError('Recovery export displayed sequences are invalid');
    }
    if (envelope.snapshots[sequences[0]! - 1]?.serializedReplica === undefined) {
      throw new ReplicaRecoveryExportError('Recovery export displayed sequences do not match');
    }
    displayed = { kind: 'journal-match', sequences: [...sequences] };
  } else if (
    displayedValue.kind === 'embedded' &&
    exactKeys(displayedValue, ['kind', 'serializedReplica']) &&
    typeof displayedValue.serializedReplica === 'string'
  ) {
    assertReplicaRecoverySnapshot(expectedSourceOwnerKey, displayedValue.serializedReplica);
    if (
      envelope.snapshots.some(
        (snapshot) => snapshot.serializedReplica === displayedValue.serializedReplica,
      )
    ) {
      throw new ReplicaRecoveryExportError(
        'Recovery export duplicated an exact displayed journal projection',
      );
    }
    displayed = { kind: 'embedded', serializedReplica: displayedValue.serializedReplica };
  } else {
    throw new ReplicaRecoveryExportError('Recovery export displayed projection is invalid');
  }

  return freezeExport({
    format: REPLICA_RECOVERY_EXPORT_FORMAT,
    version: REPLICA_RECOVERY_EXPORT_VERSION,
    exportedAt,
    sourceOwnerKey: expectedSourceOwnerKey,
    journalVersion: REPLICA_RECOVERY_JOURNAL_VERSION,
    snapshots: envelope.snapshots,
    displayed,
  });
}

function randomSuffix(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

export function replicaRecoveryExportFileName(
  exportedAt: string,
  suffix: string = randomSuffix(),
): string {
  const timestamp = strictIsoTimestamp(exportedAt, 'Recovery export timestamp')
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (!safeSuffix) throw new ReplicaRecoveryExportError('Recovery export filename is invalid');
  return `iris-recovery-${timestamp}-${safeSuffix}.json`;
}
