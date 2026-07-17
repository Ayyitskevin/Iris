/** Pure, unwired staging for a transactional Sync v2 owner root. */
import {
  SYNC_PUSH_LIMIT,
  SYNC_PUSH_MAX_BYTES,
  SYNC_V2_RESOURCE_SET,
  SyncV2PushRequest as SyncV2PushRequestSchema,
  syncV2PushRequestByteLength,
  type SyncV2Mutation,
  type SyncV2PushRequest,
} from '@iris/shared';

import {
  validatePersistedSyncV2Replica,
  type PersistedSyncV2Replica,
  type SyncV2Issue,
} from '../state/sync-v2-replica';

function issue(code: string, message: string, opIds: string[]): SyncV2Issue {
  return {
    code,
    message,
    affectedOpIds: [...new Set(opIds)],
    recoveryKind: 'restage',
  };
}

function request(deviceId: string, mutations: SyncV2Mutation[]): SyncV2PushRequest {
  return {
    resourceSet: SYNC_V2_RESOURCE_SET,
    deviceId,
    mutations,
  };
}

/**
 * Select and persist one exact full request envelope without consuming the outbox.
 *
 * Existing pending work is returned byte-equivalently after validation. A malformed
 * persisted root fails closed; the explicit request guards retain a durable issue if a
 * future request-level rule or widened field bound makes an otherwise valid mutation
 * unstaged. The caller must transactionally commit the returned whole root before it may
 * dispatch `pendingPush`.
 */
export function stageSyncV2PushRequest(value: unknown): PersistedSyncV2Replica {
  const replica = validatePersistedSyncV2Replica(value);
  if (replica.pendingPush || replica.syncIssue || replica.outbox.length === 0) {
    return replica;
  }

  const mutations: SyncV2Mutation[] = [];
  for (const mutation of replica.outbox) {
    if (mutations.length >= SYNC_PUSH_LIMIT) break;

    const single = request(replica.deviceId, [mutation]);
    if (syncV2PushRequestByteLength(single) > SYNC_PUSH_MAX_BYTES) {
      return validatePersistedSyncV2Replica({
        ...replica,
        syncIssue: issue(
          'sync_mutation_too_large',
          'One pending resource is too large to fit in a Sync v2 request.',
          [mutation.opId],
        ),
      });
    }

    const candidate = request(replica.deviceId, [...mutations, mutation]);
    if (syncV2PushRequestByteLength(candidate) > SYNC_PUSH_MAX_BYTES) break;

    const parsed = SyncV2PushRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      return validatePersistedSyncV2Replica({
        ...replica,
        syncIssue: issue(
          'invalid_local_sync_mutation',
          'The pending local resources do not satisfy the Sync v2 protocol.',
          candidate.mutations.map((item) => item.opId),
        ),
      });
    }
    mutations.push(mutation);
  }

  if (mutations.length === 0) {
    return validatePersistedSyncV2Replica({
      ...replica,
      syncIssue: issue(
        'invalid_local_sync_mutation',
        'The Sync v2 outbox could not be staged safely.',
        [replica.outbox[0]!.opId],
      ),
    });
  }

  const pendingPush = SyncV2PushRequestSchema.parse(request(replica.deviceId, mutations));
  return validatePersistedSyncV2Replica({ ...replica, pendingPush });
}
