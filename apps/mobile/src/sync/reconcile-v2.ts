/**
 * Pure request-aware Sync v2 result correlation.
 *
 * The standalone response schema validates shape. Given a strictly parsed request selected
 * for dispatch and a checked session workspace, this seam binds every result to the
 * operation it acknowledges. It is intentionally not wired into the v1 coordinator.
 */
import {
  SYNC_V2_RESOURCE_SET,
  type SyncV2Applied,
  type SyncV2Conflict,
  type SyncV2Mutation,
  type SyncV2NoteResource,
  type SyncV2PushRequest,
  type SyncV2PushResponse,
} from '@iris/shared';

import { SyncProtocolError } from './reconcile';

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CorrelatedSyncV2PushResult =
  | Readonly<{
      kind: 'applied';
      operationIndex: number;
      operation: DeepReadonly<SyncV2Mutation>;
      result: DeepReadonly<SyncV2Applied>;
    }>
  | Readonly<{
      kind: 'conflict';
      operationIndex: number;
      operation: DeepReadonly<SyncV2Mutation>;
      result: DeepReadonly<SyncV2Conflict>;
    }>;

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function detachedMutation(mutation: SyncV2Mutation): DeepReadonly<SyncV2Mutation> {
  const data = Object.freeze({
    ...mutation.resource.data,
    tags: Object.freeze([...mutation.resource.data.tags]),
  });
  const resource = Object.freeze({ ...mutation.resource, data });
  return Object.freeze({ ...mutation, resource });
}

function detachedResource(resource: SyncV2NoteResource): DeepReadonly<SyncV2NoteResource> {
  const data = Object.freeze({
    ...resource.data,
    tags: Object.freeze([...resource.data.tags]),
  });
  return Object.freeze({ ...resource, data });
}

function detachedApplied(result: SyncV2Applied): DeepReadonly<SyncV2Applied> {
  if (!result.resource) return Object.freeze({ opId: result.opId });
  return Object.freeze({ opId: result.opId, resource: detachedResource(result.resource) });
}

function detachedConflict(result: SyncV2Conflict): DeepReadonly<SyncV2Conflict> {
  return Object.freeze({
    opId: result.opId,
    reason: result.reason,
    serverResource: detachedResource(result.serverResource),
  });
}

function assertResourceBinding(
  expectedWorkspaceId: string,
  mutation: SyncV2Mutation,
  resource: SyncV2NoteResource,
): void {
  if (resource.type !== mutation.resource.type) {
    throw new SyncProtocolError('Sync v2 result resource type did not match its operation');
  }
  if (!sameUuid(resource.id, mutation.resource.id)) {
    throw new SyncProtocolError('Sync v2 result resource id did not match its operation');
  }
  if (!sameUuid(resource.data.workspaceId, expectedWorkspaceId)) {
    throw new SyncProtocolError('Sync v2 result resource belonged to another workspace');
  }
}

function assertAppliedResult(
  expectedWorkspaceId: string,
  mutation: SyncV2Mutation,
  result: SyncV2Applied,
): void {
  if (result.resource) {
    assertResourceBinding(expectedWorkspaceId, mutation, result.resource);
  }

  if (mutation.type === 'delete') {
    if (result.resource?.data.deletedAt === null) {
      throw new SyncProtocolError('Applied Sync v2 delete returned a live resource');
    }
    return;
  }

  if (!result.resource) {
    throw new SyncProtocolError('Applied Sync v2 live mutation omitted its resource');
  }
  if (result.resource.data.deletedAt !== null) {
    throw new SyncProtocolError('Applied Sync v2 live mutation returned a tombstone');
  }
}

function assertConflictResult(
  expectedWorkspaceId: string,
  mutation: SyncV2Mutation,
  result: SyncV2Conflict,
): void {
  assertResourceBinding(expectedWorkspaceId, mutation, result.serverResource);
  if (mutation.type === 'delete' && result.serverResource.data.deletedAt !== null) {
    throw new SyncProtocolError('Sync v2 delete conflict returned a tombstone');
  }
}

/**
 * Validate a complete response and return request-ordered bindings.
 *
 * Both inputs must first pass their strict shared wire schemas. This function adds the
 * request/workspace context those standalone parsers cannot know.
 *
 * Operation ids remain case-sensitive. UUID comparisons are case-insensitive because
 * PostgreSQL canonicalizes them, but the supplied request is never normalized, mutated,
 * or exposed through the returned operation metadata.
 */
export function correlateSyncV2PushResults(
  expectedWorkspaceId: string,
  request: Readonly<SyncV2PushRequest>,
  response: Readonly<SyncV2PushResponse>,
): readonly CorrelatedSyncV2PushResult[] {
  if (
    request.resourceSet !== SYNC_V2_RESOURCE_SET ||
    response.resourceSet !== request.resourceSet
  ) {
    throw new SyncProtocolError('Sync v2 response resource set did not match its request');
  }

  const sentByOperation = new Map<string, SyncV2Mutation>();
  for (const mutation of request.mutations) {
    if (sentByOperation.has(mutation.opId)) {
      throw new SyncProtocolError('Sync v2 request contained a duplicate operation id');
    }
    sentByOperation.set(mutation.opId, mutation);
  }

  const resultsByOperation = new Map<
    string,
    { kind: 'applied'; result: SyncV2Applied } | { kind: 'conflict'; result: SyncV2Conflict }
  >();
  const bindResult = (
    opId: string,
    result:
      { kind: 'applied'; result: SyncV2Applied } | { kind: 'conflict'; result: SyncV2Conflict },
  ): void => {
    if (!sentByOperation.has(opId)) {
      throw new SyncProtocolError('Sync v2 response referenced an unknown operation');
    }
    if (resultsByOperation.has(opId)) {
      throw new SyncProtocolError('Sync v2 response repeated an operation result');
    }
    resultsByOperation.set(opId, result);
  };

  for (const result of response.applied) {
    bindResult(result.opId, { kind: 'applied', result });
  }
  for (const result of response.conflicts) {
    bindResult(result.opId, { kind: 'conflict', result });
  }

  return request.mutations.map((mutation, operationIndex): CorrelatedSyncV2PushResult => {
    const correlated = resultsByOperation.get(mutation.opId);
    if (!correlated) {
      throw new SyncProtocolError('Sync v2 response omitted an operation result');
    }
    if (correlated.kind === 'applied') {
      assertAppliedResult(expectedWorkspaceId, mutation, correlated.result);
      return Object.freeze({
        kind: 'applied',
        operationIndex,
        operation: detachedMutation(mutation),
        result: detachedApplied(correlated.result),
      });
    }

    assertConflictResult(expectedWorkspaceId, mutation, correlated.result);
    return Object.freeze({
      kind: 'conflict',
      operationIndex,
      operation: detachedMutation(mutation),
      result: detachedConflict(correlated.result),
    });
  });
}
