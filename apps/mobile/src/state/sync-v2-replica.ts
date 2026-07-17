/**
 * Strict candidate owner root for the future transactional Sync v2 runtime.
 *
 * This is deliberately separate from the production version-2 localStorage/SecureStore
 * root. Selecting it before owner promotion, stale-writer recovery, web leadership, and
 * native storage are proven would create two authorities or let a rolled-back binary
 * erase generic sync state. The revision-fenced repository may already preserve these
 * serialized bytes opaquely, but no deployed runtime chooses this root yet.
 */
import {
  PostgresUuid,
  SYNC_V2_RESOURCE_SET,
  SyncV2Mutation as SyncV2MutationSchema,
  SyncV2NoteResource as SyncV2NoteResourceSchema,
  SyncV2PushRequest as SyncV2PushRequestSchema,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
  type SyncV2ResourceSet,
} from '@iris/shared';

export const SYNC_V2_REPLICA_VERSION = 3 as const;

export type SyncV2RecoveryKind = 'rekey' | 'reset-cursor' | 'restage' | 'retry';

export interface SyncV2Issue {
  code: string;
  message: string;
  affectedOpIds: string[];
  recoveryKind: SyncV2RecoveryKind;
}

export interface SyncV2ConflictDraft {
  localMutation: SyncV2Mutation;
  serverResource: SyncV2NoteResource;
  detectedAt: string;
}

/**
 * One owner-scoped atomic document. A transactional CAS must commit the complete value,
 * so resources, outbox, cursor, pending request, issues, and conflicts cannot diverge.
 */
export interface PersistedSyncV2Replica {
  version: typeof SYNC_V2_REPLICA_VERSION;
  ownerKey: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
  resourceSet: SyncV2ResourceSet;
  cursor: string;
  resources: Record<string, SyncV2NoteResource>;
  outbox: SyncV2Mutation[];
  /** Exact full envelope selected for dispatch; never reconstructed from current drafts. */
  pendingPush: SyncV2PushRequest | null;
  syncIssue: SyncV2Issue | null;
  conflicts: Record<string, SyncV2ConflictDraft>;
}

const ROOT_KEYS = [
  'version',
  'ownerKey',
  'userId',
  'workspaceId',
  'deviceId',
  'resourceSet',
  'cursor',
  'resources',
  'outbox',
  'pendingPush',
  'syncIssue',
  'conflicts',
] as const;

const ISSUE_KEYS = ['code', 'message', 'affectedOpIds', 'recoveryKind'] as const;
const CONFLICT_KEYS = ['localMutation', 'serverResource', 'detectedAt'] as const;
const CURSOR_PATTERN = /^resource-v1:notes-v1:([^:]+):(0|[1-9][0-9]*)$/;

export class SyncV2ReplicaIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SyncV2ReplicaIntegrityError';
  }
}

function invalid(message: string): never {
  throw new SyncV2ReplicaIntegrityError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalResourceId(id: string): string {
  return id.toLowerCase();
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseUuid(value: unknown, label: string): string {
  const parsed = PostgresUuid.safeParse(value);
  if (!parsed.success) invalid(`${label} must be a PostgreSQL UUID`);
  return parsed.data;
}

function parseCanonicalOwnerUuid(value: unknown, label: string): string {
  const parsed = parseUuid(value, label);
  if (parsed !== parsed.toLowerCase()) {
    invalid(`${label} must use canonical lowercase UUID text`);
  }
  return parsed;
}

function parseDeviceId(value: unknown): string {
  const parsed = SyncV2PushRequestSchema.safeParse({
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId: value,
    mutations: [],
  });
  if (!parsed.success) invalid('Sync v2 replica device id is invalid');
  return parsed.data.deviceId;
}

function parseCursor(value: unknown, workspaceId: string): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 200) {
    invalid('Sync v2 replica cursor must be a bounded string');
  }
  const match = CURSOR_PATTERN.exec(value);
  if (!match || !PostgresUuid.safeParse(match[1]).success) {
    invalid('Sync v2 replica cursor is malformed');
  }
  if (!sameUuid(match[1]!, workspaceId)) {
    invalid('Sync v2 replica cursor belongs to another workspace');
  }
  return value;
}

function parseResources(value: unknown, workspaceId: string): Record<string, SyncV2NoteResource> {
  if (!isRecord(value)) invalid('Sync v2 replica resources must be an object');

  const resources: Record<string, SyncV2NoteResource> = {};
  const identities = new Set<string>();
  for (const [key, candidate] of Object.entries(value)) {
    parseUuid(key, 'Sync v2 resource key');
    const parsed = SyncV2NoteResourceSchema.safeParse(candidate);
    if (!parsed.success) invalid('Sync v2 replica contains an invalid resource');
    const resource = parsed.data;
    if (!sameUuid(key, resource.id)) {
      invalid('Sync v2 resource key does not match its embedded id');
    }
    if (!sameUuid(resource.data.workspaceId, workspaceId)) {
      invalid('Sync v2 replica contains a resource from another workspace');
    }
    const identity = canonicalResourceId(resource.id);
    if (identities.has(identity)) invalid('Sync v2 replica contains a duplicate resource');
    identities.add(identity);
    resources[key] = resource;
  }
  return resources;
}

function parseOutbox(value: unknown): SyncV2Mutation[] {
  if (!Array.isArray(value)) invalid('Sync v2 replica outbox must be an array');
  const outbox: SyncV2Mutation[] = [];
  const operationIds = new Set<string>();
  const resourceIds = new Set<string>();
  for (const candidate of value) {
    const parsed = SyncV2MutationSchema.safeParse(candidate);
    if (!parsed.success) invalid('Sync v2 replica contains an invalid outbox mutation');
    if (operationIds.has(parsed.data.opId)) {
      invalid('Sync v2 replica outbox contains a duplicate operation id');
    }
    const resourceId = canonicalResourceId(parsed.data.resource.id);
    if (resourceIds.has(resourceId)) {
      invalid('Sync v2 replica outbox contains multiple current drafts for one resource');
    }
    operationIds.add(parsed.data.opId);
    resourceIds.add(resourceId);
    outbox.push(parsed.data);
  }
  return outbox;
}

function parsePendingPush(value: unknown, deviceId: string): SyncV2PushRequest | null {
  if (value === null) return null;
  const parsed = SyncV2PushRequestSchema.safeParse(value);
  if (!parsed.success) invalid('Sync v2 replica pending request is invalid');
  if (parsed.data.mutations.length === 0) {
    invalid('Sync v2 replica pending request cannot be empty');
  }
  if (parsed.data.resourceSet !== SYNC_V2_RESOURCE_SET) {
    invalid('Sync v2 replica pending request has the wrong resource set');
  }
  if (parsed.data.deviceId !== deviceId) {
    invalid('Sync v2 replica pending request has the wrong device id');
  }
  return parsed.data;
}

function parseIssue(value: unknown): SyncV2Issue | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ISSUE_KEYS)) {
    invalid('Sync v2 replica issue is invalid');
  }
  const { code, message, affectedOpIds, recoveryKind } = value;
  if (typeof code !== 'string' || code.length === 0) {
    invalid('Sync v2 replica issue code is invalid');
  }
  if (typeof message !== 'string' || message.length === 0) {
    invalid('Sync v2 replica issue message is invalid');
  }
  if (!Array.isArray(affectedOpIds)) {
    invalid('Sync v2 replica issue operation ids are invalid');
  }
  const detachedOperationIds = [...affectedOpIds];
  if (
    detachedOperationIds.some(
      (opId) =>
        typeof opId !== 'string' ||
        opId.length === 0 ||
        opId.length > 200 ||
        opId.includes('\u0000'),
    )
  ) {
    invalid('Sync v2 replica issue operation ids are invalid');
  }
  if (new Set(detachedOperationIds).size !== detachedOperationIds.length) {
    invalid('Sync v2 replica issue repeats an operation id');
  }
  if (
    typeof recoveryKind !== 'string' ||
    !['rekey', 'reset-cursor', 'restage', 'retry'].includes(recoveryKind)
  ) {
    invalid('Sync v2 replica issue recovery kind is invalid');
  }
  return {
    code,
    message,
    affectedOpIds: detachedOperationIds,
    recoveryKind: recoveryKind as SyncV2RecoveryKind,
  };
}

function parseConflicts(
  value: unknown,
  workspaceId: string,
  resources: Readonly<Record<string, SyncV2NoteResource>>,
): Record<string, SyncV2ConflictDraft> {
  if (!isRecord(value)) invalid('Sync v2 replica conflicts must be an object');
  const conflicts: Record<string, SyncV2ConflictDraft> = {};
  const identities = new Set<string>();
  for (const [key, candidate] of Object.entries(value)) {
    parseUuid(key, 'Sync v2 conflict key');
    if (!isRecord(candidate) || !hasExactKeys(candidate, CONFLICT_KEYS)) {
      invalid('Sync v2 replica contains an invalid conflict');
    }
    const local = SyncV2MutationSchema.safeParse(candidate.localMutation);
    const server = SyncV2NoteResourceSchema.safeParse(candidate.serverResource);
    if (
      !local.success ||
      !server.success ||
      typeof candidate.detectedAt !== 'string' ||
      candidate.detectedAt.length === 0
    ) {
      invalid('Sync v2 replica contains an invalid conflict');
    }
    if (
      !sameUuid(key, local.data.resource.id) ||
      !sameUuid(key, server.data.id) ||
      !sameUuid(server.data.data.workspaceId, workspaceId)
    ) {
      invalid('Sync v2 conflict identity or workspace is invalid');
    }
    if (
      server.data.data.version === 0 ||
      (local.data.type === 'delete' && server.data.data.deletedAt !== null)
    ) {
      invalid('Sync v2 conflict authoritative lifecycle or version is invalid');
    }
    const identity = canonicalResourceId(key);
    if (identities.has(identity)) invalid('Sync v2 replica contains a duplicate conflict');
    identities.add(identity);
    const projected = Object.values(resources).find((resource) =>
      sameUuid(resource.id, server.data.id),
    );
    if (!projected || !structurallyEqual(projected, server.data)) {
      invalid('Sync v2 conflict server resource does not match the local projection');
    }
    conflicts[key] = {
      localMutation: local.data,
      serverResource: server.data,
      detectedAt: candidate.detectedAt,
    };
  }
  return conflicts;
}

function findResource(
  resources: Readonly<Record<string, SyncV2NoteResource>>,
  resourceId: string,
): SyncV2NoteResource | undefined {
  return Object.values(resources).find((resource) => sameUuid(resource.id, resourceId));
}

function assertCurrentDraftProjection(
  mutation: SyncV2Mutation,
  resources: Readonly<Record<string, SyncV2NoteResource>>,
): void {
  const projected = findResource(resources, mutation.resource.id);
  if (!projected) {
    invalid('Sync v2 outbox mutation has no local resource projection');
  }
  const projectedWriteData = {
    title: projected.data.title,
    bodyMd: projected.data.bodyMd,
    folder: projected.data.folder,
    tags: projected.data.tags,
  };
  if (
    projected.data.version !== mutation.baseVersion ||
    !structurallyEqual(projectedWriteData, mutation.resource.data)
  ) {
    invalid('Sync v2 outbox mutation does not match its local resource projection');
  }
  const shouldBeDeleted = mutation.type === 'delete';
  if ((projected.data.deletedAt !== null) !== shouldBeDeleted) {
    invalid('Sync v2 outbox mutation lifecycle does not match its local projection');
  }
}

/** Validate and detach an in-memory candidate root. Unknown fields fail closed. */
export function validatePersistedSyncV2Replica(value: unknown): PersistedSyncV2Replica {
  if (!isRecord(value) || !hasExactKeys(value, ROOT_KEYS)) {
    invalid('Sync v2 replica root is invalid or contains unknown fields');
  }
  if (value.version !== SYNC_V2_REPLICA_VERSION) {
    invalid('Sync v2 replica version is unsupported');
  }
  const userId = parseCanonicalOwnerUuid(value.userId, 'Sync v2 replica user id');
  const workspaceId = parseCanonicalOwnerUuid(value.workspaceId, 'Sync v2 replica workspace id');
  const expectedOwnerKey = `${workspaceId}.${userId}`;
  if (value.ownerKey !== expectedOwnerKey) {
    invalid('Sync v2 replica owner key does not match its workspace and user');
  }
  if (value.resourceSet !== SYNC_V2_RESOURCE_SET) {
    invalid('Sync v2 replica resource set is unsupported');
  }
  const deviceId = parseDeviceId(value.deviceId);
  const cursor = parseCursor(value.cursor, workspaceId);
  const resources = parseResources(value.resources, workspaceId);
  const outbox = parseOutbox(value.outbox);
  const pendingPush = parsePendingPush(value.pendingPush, deviceId);
  const syncIssue = parseIssue(value.syncIssue);
  const conflicts = parseConflicts(value.conflicts, workspaceId, resources);

  for (const mutation of outbox) {
    assertCurrentDraftProjection(mutation, resources);
    if (Object.keys(conflicts).some((key) => sameUuid(key, mutation.resource.id))) {
      invalid('Sync v2 resource cannot be both queued and conflicted');
    }
  }
  for (const resource of Object.values(resources)) {
    if (
      resource.data.version === 0 &&
      !outbox.some((mutation) => sameUuid(mutation.resource.id, resource.id))
    ) {
      invalid('Sync v2 version-zero resource has no current queued draft');
    }
  }

  const operationIds = new Map(outbox.map((mutation) => [mutation.opId, mutation]));
  if (pendingPush) {
    const finalPendingByResource = new Map<string, SyncV2Mutation>();
    for (const mutation of pendingPush.mutations) {
      const sameOperation = operationIds.get(mutation.opId);
      if (sameOperation && !structurallyEqual(sameOperation, mutation)) {
        invalid('Sync v2 pending operation id has a different queued payload');
      }
      if (!outbox.some((queued) => sameUuid(queued.resource.id, mutation.resource.id))) {
        invalid('Sync v2 pending mutation has no queued operation for its resource');
      }
      operationIds.set(mutation.opId, mutation);
      finalPendingByResource.set(canonicalResourceId(mutation.resource.id), mutation);
    }
    for (const queued of outbox) {
      const finalPending = finalPendingByResource.get(canonicalResourceId(queued.resource.id));
      if (
        finalPending &&
        pendingPush.mutations.some((mutation) => mutation.opId === queued.opId) &&
        finalPending.opId !== queued.opId
      ) {
        invalid('Sync v2 queued projection does not reflect the final pending resource operation');
      }
    }
  }

  for (const conflict of Object.values(conflicts)) {
    if (operationIds.has(conflict.localMutation.opId)) {
      invalid('Sync v2 replica reuses an active operation id in a conflict');
    }
    operationIds.set(conflict.localMutation.opId, conflict.localMutation);
  }

  return {
    version: SYNC_V2_REPLICA_VERSION,
    ownerKey: expectedOwnerKey,
    userId,
    workspaceId,
    deviceId,
    resourceSet: SYNC_V2_RESOURCE_SET,
    cursor,
    resources,
    outbox,
    pendingPush,
    syncIssue,
    conflicts,
  };
}

export function parsePersistedSyncV2Replica(serialized: string): PersistedSyncV2Replica {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new SyncV2ReplicaIntegrityError('Sync v2 replica is not valid JSON', { cause });
  }
  return validatePersistedSyncV2Replica(value);
}

export function serializePersistedSyncV2Replica(value: unknown): string {
  return JSON.stringify(validatePersistedSyncV2Replica(value));
}

export function createEmptySyncV2Replica(owner: {
  userId: string;
  workspaceId: string;
  deviceId: string;
}): PersistedSyncV2Replica {
  return validatePersistedSyncV2Replica({
    version: SYNC_V2_REPLICA_VERSION,
    ownerKey: `${owner.workspaceId}.${owner.userId}`,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    deviceId: owner.deviceId,
    resourceSet: SYNC_V2_RESOURCE_SET,
    cursor: '',
    resources: {},
    outbox: [],
    pendingPush: null,
    syncIssue: null,
    conflicts: {},
  });
}
