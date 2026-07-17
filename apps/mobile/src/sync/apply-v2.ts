/** Pure, all-or-none Sync v2 push-result application for the candidate replica root. */
import {
  PostgresUuid,
  SyncV2Mutation as SyncV2MutationSchema,
  SyncV2NoteResource as SyncV2NoteResourceSchema,
  SyncV2PushRequest as SyncV2PushRequestSchema,
  SyncV2PushResponse as SyncV2PushResponseSchema,
  type SyncV2Mutation,
  type SyncV2NoteResource,
} from '@iris/shared';

import {
  validatePersistedSyncV2Replica,
  type PersistedSyncV2Replica,
  type SyncV2ConflictDraft,
} from '../state/sync-v2-replica';
import { correlateSyncV2PushResults } from './reconcile-v2';
import { SyncProtocolError } from './reconcile';

export interface SyncV2ApplicationContext {
  workspaceId: string;
  deviceId: string;
  detectedAt: string;
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function resourceKey(id: string): string {
  return `note:${id.toLowerCase()}`;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findResource(
  resources: Readonly<Record<string, SyncV2NoteResource>>,
  resourceId: string,
): SyncV2NoteResource | undefined {
  return Object.values(resources).find((resource) => sameUuid(resource.id, resourceId));
}

function removeResource(resources: Record<string, SyncV2NoteResource>, resourceId: string): void {
  for (const key of Object.keys(resources)) {
    if (sameUuid(key, resourceId) || sameUuid(resources[key]!.id, resourceId)) {
      delete resources[key];
    }
  }
}

function putResource(
  resources: Record<string, SyncV2NoteResource>,
  resource: SyncV2NoteResource,
): void {
  removeResource(resources, resource.id);
  resources[resource.id] = resource;
}

function removeConflict(conflicts: Record<string, SyncV2ConflictDraft>, resourceId: string): void {
  for (const key of Object.keys(conflicts)) {
    if (sameUuid(key, resourceId)) delete conflicts[key];
  }
}

function putConflict(
  conflicts: Record<string, SyncV2ConflictDraft>,
  resourceId: string,
  conflict: SyncV2ConflictDraft,
): void {
  removeConflict(conflicts, resourceId);
  conflicts[conflict.serverResource.id] = conflict;
}

function overlayLocalDraft(
  authoritative: SyncV2NoteResource,
  mutation: SyncV2Mutation,
  current: SyncV2NoteResource | undefined,
  detectedAt: string,
): SyncV2NoteResource {
  return SyncV2NoteResourceSchema.parse({
    type: authoritative.type,
    id: authoritative.id,
    data: {
      ...authoritative.data,
      ...mutation.resource.data,
      tags: [...mutation.resource.data.tags],
      // Preserve when the local edit actually occurred. The response timestamp is only
      // a fallback for an imported projection that lacks a current in-memory resource.
      updatedAt: current?.data.updatedAt ?? detectedAt,
      deletedAt: mutation.type === 'delete' ? (current?.data.deletedAt ?? detectedAt) : null,
    },
  });
}

function protocol(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SyncProtocolError(message);
}

/**
 * Apply one response against the exact envelope that was durably staged and dispatched.
 *
 * Every contextual and correlated result check completes before a detached root is
 * returned. A thrown error therefore cannot expose a partially applied root, and the
 * caller must commit the successful root (including `pendingPush: null`) in one CAS.
 */
export function applySyncV2PushResponse(
  current: unknown,
  dispatchedRequest: unknown,
  parsedResponse: unknown,
  context: SyncV2ApplicationContext,
): PersistedSyncV2Replica {
  const replica = validatePersistedSyncV2Replica(current);
  const dispatched = SyncV2PushRequestSchema.safeParse(dispatchedRequest);
  const response = SyncV2PushResponseSchema.safeParse(parsedResponse);
  protocol(dispatched.success, 'Dispatched Sync v2 request is invalid');
  protocol(response.success, 'Sync v2 push response is invalid');
  protocol(PostgresUuid.safeParse(context.workspaceId).success, 'Sync v2 workspace is invalid');
  protocol(
    typeof context.detectedAt === 'string' && context.detectedAt.length > 0,
    'Sync v2 application timestamp is empty',
  );
  protocol(replica.pendingPush !== null, 'Sync v2 response has no durable pending request');
  protocol(replica.syncIssue === null, 'Sync v2 response cannot apply while sync is held');
  protocol(
    sameUuid(replica.workspaceId, context.workspaceId),
    'Sync v2 application workspace does not own the replica',
  );
  protocol(
    replica.deviceId === context.deviceId && dispatched.data.deviceId === context.deviceId,
    'Sync v2 application device does not match the dispatched request',
  );
  protocol(
    structurallyEqual(replica.pendingPush, dispatched.data),
    'Sync v2 dispatched request does not match the durable pending envelope',
  );

  // Correlation validates the complete result set before any output root is constructed.
  const correlated = correlateSyncV2PushResults(
    context.workspaceId,
    dispatched.data,
    response.data,
  );
  for (const result of correlated) {
    const authoritative =
      result.kind === 'applied' ? result.result.resource : result.result.serverResource;
    if (authoritative?.data.version === 0) {
      throw new SyncProtocolError('Sync v2 server result returned a non-authoritative version');
    }
  }
  const stagedOperationIds = new Set(dispatched.data.mutations.map((item) => item.opId));
  let outbox = replica.outbox.filter((item) => !stagedOperationIds.has(item.opId));

  const newerByResource = new Map<string, SyncV2Mutation>();
  for (const mutation of outbox) {
    const key = resourceKey(mutation.resource.id);
    if (newerByResource.has(key)) {
      throw new SyncProtocolError(
        'Sync v2 replica contains multiple post-dispatch drafts for one resource',
      );
    }
    newerByResource.set(key, mutation);
  }

  // A request may intentionally contain repeated resource ids. The last server result
  // is the final authoritative head for that resource; applying intermediate heads can
  // otherwise consume a newer post-dispatch draft.
  const finalByResource = new Map<string, (typeof correlated)[number]>();
  for (const result of correlated) {
    finalByResource.set(resourceKey(result.operation.resource.id), result);
  }

  const resources = { ...replica.resources };
  const conflicts = { ...replica.conflicts };
  for (const result of finalByResource.values()) {
    const id = result.operation.resource.id;
    const key = resourceKey(id);
    const newer = newerByResource.get(key);

    if (result.kind === 'applied') {
      const authoritative = result.result.resource
        ? SyncV2NoteResourceSchema.parse(result.result.resource)
        : undefined;
      removeConflict(conflicts, id);
      if (!newer) {
        if (authoritative) putResource(resources, authoritative);
        else removeResource(resources, id);
        continue;
      }

      if (!authoritative) {
        // An idempotent delete of a resource absent on the server provides no version to
        // rebase onto. Preserve the later local draft and projection exactly.
        continue;
      }
      const rebased = SyncV2MutationSchema.parse({
        ...newer,
        resource: {
          ...newer.resource,
          data: { ...newer.resource.data, tags: [...newer.resource.data.tags] },
        },
        baseVersion: authoritative.data.version,
      });
      outbox = outbox.map((mutation) => (mutation.opId === newer.opId ? rebased : mutation));
      putResource(
        resources,
        overlayLocalDraft(authoritative, rebased, findResource(resources, id), context.detectedAt),
      );
      continue;
    }

    const serverResource = SyncV2NoteResourceSchema.parse(result.result.serverResource);
    if (newer?.type === 'delete' && serverResource.data.deletedAt !== null) {
      // A frozen receipt may replay this tombstone after a later server resurrection.
      // Rebase and retry the newer delete instead of treating the receipt as the current
      // head and silently consuming post-dispatch intent.
      const rebased = SyncV2MutationSchema.parse({
        ...newer,
        resource: {
          ...newer.resource,
          data: { ...newer.resource.data, tags: [...newer.resource.data.tags] },
        },
        baseVersion: serverResource.data.version,
      });
      outbox = outbox.map((mutation) => (mutation.opId === newer.opId ? rebased : mutation));
      removeConflict(conflicts, id);
      putResource(
        resources,
        overlayLocalDraft(serverResource, rebased, findResource(resources, id), context.detectedAt),
      );
      continue;
    }
    outbox = outbox.filter((mutation) => !sameUuid(mutation.resource.id, id));
    putResource(resources, serverResource);
    const localMutation = newer
      ? SyncV2MutationSchema.parse(newer)
      : SyncV2MutationSchema.parse(result.operation);
    putConflict(conflicts, id, {
      localMutation,
      serverResource,
      detectedAt: context.detectedAt,
    });
  }

  return validatePersistedSyncV2Replica({
    ...replica,
    resources,
    outbox,
    pendingPush: null,
    conflicts,
  });
}
