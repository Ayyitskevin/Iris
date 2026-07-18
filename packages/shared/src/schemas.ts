/**
 * The Iris API contract. These zod schemas are the single source of truth for
 * request/response shapes: the API validates against them and the client infers its
 * types from them. Change a shape here and both ends see it at compile time.
 *
 * Timestamps cross the wire as ISO-8601 strings.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Enums / constants
// ─────────────────────────────────────────────────────────────────────────────

/** Who performed an action. Agents are first-class actors alongside users (pillar #2). */
export const ActorType = z.enum(['user', 'agent']);
export type ActorType = z.infer<typeof ActorType>;

/** Scopes an agent token may carry. Deliberately coarse for the foundation. */
export const AgentScope = z.enum(['notes:read', 'notes:write']);
export type AgentScope = z.infer<typeof AgentScope>;

/** Every mutation is one of these; the activity log records them verbatim. */
export const ActivityAction = z.enum([
  'note.create',
  'note.update',
  'note.delete',
  'note.restore',
  'note.undo',
]);
export type ActivityAction = z.infer<typeof ActivityAction>;

/** Billing plans. `free` = local + single device; `sync` = the ~$5/mo multi-device plan. */
export const Plan = z.enum(['free', 'sync']);
export type Plan = z.infer<typeof Plan>;

export const SubscriptionStatus = z.enum(['none', 'trialing', 'active', 'past_due', 'canceled']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** Canonical hyphenated UUID shape, without RFC version/variant-bit restrictions. */
export const PostgresUuid = z.guid();
export type PostgresUuid = z.infer<typeof PostgresUuid>;

/**
 * Product-level transport bounds. Markdown remains the canonical stored format, but a
 * single note must fit comfortably inside the mobile sync request/response envelope.
 * Attachments and genuinely large documents belong in the object-storage seam rather
 * than an unbounded JSON transaction.
 */
export const MAX_NOTE_BODY_BYTES = 256 * 1024;
export const SYNC_HTTP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const SYNC_PUSH_MAX_BYTES = 1_900_000;
export const SYNC_PUSH_RESPONSE_MAX_BYTES = 1_900_000;
/**
 * Six worst-case bounded notes—including JSON escaping, metadata, and operation ids—
 * fit inside the push response envelope. Generic paged envelopes can raise this later.
 */
export const SYNC_PUSH_LIMIT = 6;
export const SYNC_PULL_PAGE_LIMIT = 50;
export const SYNC_PULL_PAGE_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Per-IP rate-limit bounds. The auth ceiling is deliberately tight: each sign-in attempt
 * runs an expensive scrypt derivation, so throttling it blocks both credential brute-force
 * and a CPU-exhaustion DoS on the shared process. Search and export are the two most
 * expensive authenticated reads.
 */
export const RATE_LIMIT_WINDOW = '1 minute';
export const GLOBAL_RATE_LIMIT_MAX = 300;
export const AUTH_RATE_LIMIT_MAX = 10;
export const SEARCH_RATE_LIMIT_MAX = 30;
export const EXPORT_RATE_LIMIT_MAX = 10;
/** Longest accepted full-text query; longer input is rejected before touching the DB. */
export const SEARCH_QUERY_MAX_LENGTH = 256;

/** UTF-8 byte length without relying on a platform-specific TextEncoder polyfill. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Serialized JSON-string content bytes, excluding the surrounding quote characters. */
export function jsonEncodedStringByteLength(value: string): number {
  return utf8ByteLength(JSON.stringify(value)) - 2;
}

const PostgreSqlText = z.string().refine((value) => !value.includes('\u0000'), {
  message: 'Text cannot contain NUL characters',
});
const NoteTitleInput = PostgreSqlText.pipe(z.string().max(500));
const NoteBodyInput = PostgreSqlText.refine(
  (value) => jsonEncodedStringByteLength(value) <= MAX_NOTE_BODY_BYTES,
  `Markdown body must be at most ${MAX_NOTE_BODY_BYTES} JSON-encoded UTF-8 bytes`,
);
const NoteFolderInput = PostgreSqlText.pipe(z.string().max(500));
const NoteTagsInput = z.array(PostgreSqlText.pipe(z.string().min(1).max(80))).max(50);

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const User = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
});
export type User = z.infer<typeof User>;

export const Note = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  folder: z.string().nullable(),
  /** Free-form tags — an organizational primitive alongside folders (phase 2). */
  tags: z.array(z.string()),
  /** Monotonic per-note version. Bumped on every save; matches the latest NoteVersion. */
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Soft-delete tombstone; sync propagates deletes without losing history. */
  deletedAt: z.string().nullable(),
});
export type Note = z.infer<typeof Note>;

const NoteVersionBase = z.object({
  id: z.string(),
  noteId: z.string(),
  workspaceId: z.string(),
  version: z.number().int().nonnegative(),
  title: z.string(),
  bodyMd: z.string(),
  tags: z.array(z.string()).default([]),
  authorType: ActorType,
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});

/** Protocol 1 captured organization but not deleted/live state. */
const OrganizationNoteVersion = NoteVersionBase.extend({
  folder: z.string().nullable(),
  folderSnapshotKnown: z.boolean(),
  tags: z.array(z.string()),
});

/** Protocol 2 requires deletion state to be present; null means explicitly unknown. */
const CurrentNoteVersion = OrganizationNoteVersion.extend({
  isDeleted: z.boolean().nullable(),
});

export const RESTORE_PROTOCOL_VERSION = 2 as const;
export const UNDO_PROTOCOL_VERSION = 2 as const;

/**
 * Older servers omit one or both generations of snapshot metadata. Normalize omissions
 * to explicit unknowns, but reject partial pairs so a malformed payload cannot invent
 * authority. Current protocol responses use CurrentNoteVersion directly below.
 */
export const NoteVersion = z.union([
  CurrentNoteVersion,
  OrganizationNoteVersion.extend({
    isDeleted: z.undefined().optional(),
  }).transform((value) => ({
    ...value,
    isDeleted: null,
  })),
  NoteVersionBase.extend({
    folder: z.undefined().optional(),
    folderSnapshotKnown: z.undefined().optional(),
    isDeleted: z.undefined().optional(),
  }).transform((value) => ({
    ...value,
    folder: null,
    folderSnapshotKnown: false as const,
    isDeleted: null,
  })),
]);
export type NoteVersion = z.infer<typeof NoteVersion>;

/** Public metadata about an agent token. The secret itself is returned exactly once. */
export const AgentToken = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentName: z.string(),
  scopes: z.array(AgentScope),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type AgentToken = z.infer<typeof AgentToken>;

export const ActivityEntry = z.object({
  id: z.string(),
  workspaceId: z.string(),
  actorType: ActorType,
  actorId: z.string(),
  actorName: z.string(),
  action: ActivityAction,
  noteId: z.string().nullable(),
  noteVersionId: z.string().nullable(),
  /** The version number this action produced (for display / undo targeting). */
  resultingVersion: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  /** True once this action has been undone (append-only: we don't delete it). */
  undone: z.boolean(),
  /** If this entry IS an undo, the id of the activity it reversed. */
  undoOfId: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const Device = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  platform: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});
export type Device = z.infer<typeof Device>;

export const DeviceListResponse = z.object({
  devices: z.array(Device),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

export const BillingStatus = z.object({
  plan: Plan,
  status: SubscriptionStatus,
  /** Max devices that may sync under the current plan. free = 1, sync = many. */
  deviceLimit: z.number().int().positive(),
  activeDevices: z.number().int().nonnegative(),
  /** Convenience flag the client uses to gate the "add another device" UI. */
  canSyncAnotherDevice: z.boolean(),
});
export type BillingStatus = z.infer<typeof BillingStatus>;

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export const SignUpRequest = z.object({
  email: z.email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(120),
});
export type SignUpRequest = z.infer<typeof SignUpRequest>;

export const SignInRequest = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const AuthResponse = z.object({
  token: z.string(),
  user: User,
  workspace: Workspace,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** Irreversible account deletion. `confirmEmail` must echo the caller's own email. */
export const DeleteAccountRequest = z.object({
  confirmEmail: z.string(),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

export const DeleteAccountResponse = z.object({
  deleted: z.literal(true),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────────────

export const CreateNoteRequest = z.object({
  title: NoteTitleInput.default(''),
  bodyMd: NoteBodyInput.default(''),
  folder: NoteFolderInput.nullish(),
  tags: NoteTagsInput.default([]),
  /** Optional client-supplied id so local-first creates keep a stable identity. */
  id: PostgresUuid.optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;

export const UpdateNoteRequest = z.object({
  title: NoteTitleInput.optional(),
  bodyMd: NoteBodyInput.optional(),
  folder: NoteFolderInput.nullish(),
  tags: NoteTagsInput.optional(),
  /**
   * The version the edit was based on. If it doesn't match the server's current
   * version, the update is a conflict (HTTP 409) and is surfaced, never dropped.
   */
  baseVersion: z.number().int().nonnegative(),
});
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;

export const NoteListResponse = z.object({
  notes: z.array(Note),
});
export type NoteListResponse = z.infer<typeof NoteListResponse>;

export const NoteVersionListResponse = z.union([
  z.object({
    versions: z.array(CurrentNoteVersion),
    restoreProtocolVersion: z.literal(RESTORE_PROTOCOL_VERSION),
    /** The authoritative server head against which every restore from this list is bound. */
    headVersion: z.number().int().nonnegative(),
  }),
  z.object({
    versions: z.array(NoteVersion),
    /** Unknown/non-current protocols remain readable, while mutation stays disabled. */
    restoreProtocolVersion: z
      .number()
      .int()
      .nonnegative()
      .refine((version) => version !== RESTORE_PROTOCOL_VERSION)
      .default(0),
    headVersion: z.number().int().nonnegative().optional(),
  }),
]);
export type NoteVersionListResponse = z.infer<typeof NoteVersionListResponse>;

export const RestoreVersionRequest = z.object({
  versionId: z.string(),
  /** The current note version the operator saw before choosing this restore. */
  baseVersion: z.number().int().nonnegative(),
  /** Explicit consent to preserve today's folder when legacy history never captured it. */
  preserveCurrentFolderIfUnknown: z.boolean().optional(),
  /** Explicit consent to preserve today's live/deleted state when history never captured it. */
  preserveCurrentDeletionStateIfUnknown: z.boolean().optional(),
});
export type RestoreVersionRequest = z.infer<typeof RestoreVersionRequest>;

export const RestoreVersionResponse = z.object({
  note: Note,
  /** False only when an explicitly accepted legacy restore kept the current folder. */
  folderRestored: z.boolean(),
  /** False only when an explicitly accepted legacy restore kept today's deletion state. */
  deletionStateRestored: z.boolean(),
});
export type RestoreVersionResponse = z.infer<typeof RestoreVersionResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Tags & search (phase 2)
// ─────────────────────────────────────────────────────────────────────────────

/** A tag plus how many live notes carry it, for the workspace's tag list. */
export const TagSummary = z.object({
  tag: z.string(),
  count: z.number().int().nonnegative(),
});
export type TagSummary = z.infer<typeof TagSummary>;

export const TagListResponse = z.object({
  tags: z.array(TagSummary),
});
export type TagListResponse = z.infer<typeof TagListResponse>;

/** A search hit: the note plus its relevance rank (higher = better). */
export const SearchHit = z.object({
  note: Note,
  rank: z.number(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(SearchHit),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────────────────────────

export const IssueAgentTokenRequest = z.object({
  agentName: z.string().min(1).max(120),
  scopes: z.array(AgentScope).min(1),
});
export type IssueAgentTokenRequest = z.infer<typeof IssueAgentTokenRequest>;

export const IssueAgentTokenResponse = z.object({
  /** The plaintext token. Shown exactly once; only its hash is stored. */
  token: z.string(),
  agentToken: AgentToken,
});
export type IssueAgentTokenResponse = z.infer<typeof IssueAgentTokenResponse>;

export const AgentTokenListResponse = z.object({
  tokens: z.array(AgentToken),
});
export type AgentTokenListResponse = z.infer<typeof AgentTokenListResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Activity
// ─────────────────────────────────────────────────────────────────────────────

export const ActivityListResponse = z.object({
  activity: z.array(ActivityEntry),
  /** Anything except the current capability is read-only in the client. */
  undoProtocolVersion: z.number().int().nonnegative().default(0),
});
export type ActivityListResponse = z.infer<typeof ActivityListResponse>;

export const UndoResponse = z.object({
  /** The activity entry that recorded the undo (append-only compensation). */
  undo: ActivityEntry,
  /** Authoritative head after undo, including a tombstone when the note was deleted. */
  note: Note,
  /** False when legacy history could not prove the pre-action folder and kept it. */
  folderRestored: z.boolean(),
  /** Successful protocol-2 undo always proves and restores the prior live/deleted state. */
  deletionStateRestored: z.literal(true),
});
export type UndoResponse = z.infer<typeof UndoResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Sync (local-first change-feed; see ADR-005)
// ─────────────────────────────────────────────────────────────────────────────

export const SyncChangesRequest = z.object({
  since: z.string().max(200).default(''),
  deviceId: PostgreSqlText.pipe(z.string().min(1).max(200)).default('default'),
});
export type SyncChangesRequest = z.infer<typeof SyncChangesRequest>;

/** Opaque database-monotonic cursor; clients must store and return it without parsing. */
export const SyncChangesResponse = z.object({
  changes: z.array(Note).max(SYNC_PULL_PAGE_LIMIT),
  cursor: z.string().max(200),
  hasMore: z.boolean(),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponse>;

export const SyncMutation = z.object({
  /** Durable idempotency key; one key is permanently bound to one actor/device/payload. */
  opId: PostgreSqlText.pipe(z.string().min(1).max(200)),
  /** `resurrect` is the only sync operation allowed to make a tombstone live again. */
  type: z.enum(['upsert', 'delete', 'resurrect']),
  note: z.object({
    id: PostgresUuid,
    title: NoteTitleInput,
    bodyMd: NoteBodyInput,
    folder: NoteFolderInput.nullable(),
    tags: NoteTagsInput.default([]),
  }),
  /** The version this mutation was derived from (0 for a brand-new note). */
  baseVersion: z.number().int().nonnegative(),
});
export type SyncMutation = z.infer<typeof SyncMutation>;

function validateUniqueOperationIds(
  request: { mutations: Array<{ opId: string }> },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  request.mutations.forEach((mutation, index) => {
    if (seen.has(mutation.opId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mutations', index, 'opId'],
        message: 'opId values must be unique within a push request',
      });
    }
    seen.add(mutation.opId);
  });
}

export function syncPushRequestByteLength(request: {
  deviceId: string;
  mutations: SyncMutation[];
}): number {
  return utf8ByteLength(JSON.stringify(request));
}

function validatePushByteEnvelope(
  request: { deviceId: string; mutations: SyncMutation[] },
  ctx: z.RefinementCtx,
): void {
  if (syncPushRequestByteLength(request) > SYNC_PUSH_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['mutations'],
      message: `Serialized sync request must be at most ${SYNC_PUSH_MAX_BYTES} UTF-8 bytes`,
    });
  }
}

export const SyncPushRequest = z
  .object({
    deviceId: PostgreSqlText.pipe(z.string().min(1).max(200)),
    mutations: z.array(SyncMutation).max(SYNC_PUSH_LIMIT),
  })
  .superRefine((request, ctx) => {
    validateUniqueOperationIds(request, ctx);
    validatePushByteEnvelope(request, ctx);
  });
export type SyncPushRequest = z.infer<typeof SyncPushRequest>;

/** Alias naming the exact request snapshot current clients persist before dispatch. */
export const SyncPushChunkRequest = SyncPushRequest;
export type SyncPushChunkRequest = z.infer<typeof SyncPushChunkRequest>;

export const SyncConflict = z.object({
  opId: z.string(),
  reason: z.literal('version_mismatch'),
  /** The authoritative server state the client must reconcile against. */
  serverNote: Note,
});
export type SyncConflict = z.infer<typeof SyncConflict>;

export const SyncApplied = z.object({ opId: z.string(), note: Note.optional() });
export type SyncApplied = z.infer<typeof SyncApplied>;

export const SyncPushResponse = z.object({
  // `note` is absent only for an idempotent delete of a note that never existed here.
  applied: z.array(SyncApplied),
  conflicts: z.array(SyncConflict),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Sync v2 resource envelope (additive note-backed boundary)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable membership for the first generic feed. A future notes+work feed must use
 * a new resource-set id and start from genesis; widening this set would let its cursor
 * skip resources that predate the capability.
 */
export const SYNC_V2_RESOURCE_SET = 'notes-v1' as const;
export const SyncV2ResourceSet = z.literal(SYNC_V2_RESOURCE_SET);
export type SyncV2ResourceSet = z.infer<typeof SyncV2ResourceSet>;

const SyncV2OperationId = PostgreSqlText.pipe(z.string().min(1).max(200));

export const SyncV2NoteWriteData = z.strictObject({
  title: NoteTitleInput,
  bodyMd: NoteBodyInput,
  folder: NoteFolderInput.nullable(),
  // Required rather than defaulted: every v2 receipt projection is explicit.
  tags: NoteTagsInput,
});
export type SyncV2NoteWriteData = z.infer<typeof SyncV2NoteWriteData>;

export const SyncV2NoteMutationResource = z.strictObject({
  type: z.literal('note'),
  id: PostgresUuid,
  data: SyncV2NoteWriteData,
});
export type SyncV2NoteMutationResource = z.infer<typeof SyncV2NoteMutationResource>;

export const SyncV2Mutation = z.strictObject({
  opId: SyncV2OperationId,
  type: z.enum(['upsert', 'delete', 'resurrect']),
  resource: SyncV2NoteMutationResource,
  baseVersion: z.number().int().nonnegative(),
});
export type SyncV2Mutation = z.infer<typeof SyncV2Mutation>;

/** Server-authoritative note data. Body size is intentionally unbounded on reads so a
 * recognized pre-limit note remains recoverable losslessly. */
export const SyncV2NoteResourceData = z.strictObject({
  workspaceId: PostgresUuid,
  title: z.string(),
  bodyMd: z.string(),
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type SyncV2NoteResourceData = z.infer<typeof SyncV2NoteResourceData>;

export const SyncV2NoteResource = z.strictObject({
  type: z.literal('note'),
  id: PostgresUuid,
  data: SyncV2NoteResourceData,
});
export type SyncV2NoteResource = z.infer<typeof SyncV2NoteResource>;

/** Input cursors stay opaque so the service can return the durable `invalid_sync_cursor`
 * recovery code for malformed, foreign, ahead, or route-mismatched values. */
export const SyncV2ChangesRequest = z.strictObject({
  resourceSet: SyncV2ResourceSet,
  cursor: z.string().max(200),
  deviceId: PostgreSqlText.pipe(z.string().min(1).max(200)),
});
export type SyncV2ChangesRequest = z.infer<typeof SyncV2ChangesRequest>;

const SyncV2ResourceCursor = z
  .string()
  .max(200)
  .refine((cursor) => {
    const match = /^resource-v1:notes-v1:([^:]+):(0|[1-9][0-9]*)$/.exec(cursor);
    return match !== null && PostgresUuid.safeParse(match[1]).success;
  }, 'Invalid notes-v1 resource cursor');

export const SyncV2ChangesResponse = z.strictObject({
  resourceSet: SyncV2ResourceSet,
  resources: z.array(SyncV2NoteResource).max(SYNC_PULL_PAGE_LIMIT),
  cursor: SyncV2ResourceCursor,
  hasMore: z.boolean(),
});
export type SyncV2ChangesResponse = z.infer<typeof SyncV2ChangesResponse>;

export function syncV2PushRequestByteLength(request: {
  resourceSet: SyncV2ResourceSet;
  deviceId: string;
  mutations: SyncV2Mutation[];
}): number {
  return utf8ByteLength(JSON.stringify(request));
}

function validateSyncV2PushByteEnvelope(
  request: {
    resourceSet: SyncV2ResourceSet;
    deviceId: string;
    mutations: SyncV2Mutation[];
  },
  ctx: z.RefinementCtx,
): void {
  if (syncV2PushRequestByteLength(request) > SYNC_PUSH_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['mutations'],
      message: `Serialized sync request must be at most ${SYNC_PUSH_MAX_BYTES} UTF-8 bytes`,
    });
  }
}

export const SyncV2PushRequest = z
  .strictObject({
    resourceSet: SyncV2ResourceSet,
    deviceId: PostgreSqlText.pipe(z.string().min(1).max(200)),
    mutations: z.array(SyncV2Mutation).max(SYNC_PUSH_LIMIT),
  })
  .superRefine((request, ctx) => {
    validateUniqueOperationIds(request, ctx);
    validateSyncV2PushByteEnvelope(request, ctx);
  });
export type SyncV2PushRequest = z.infer<typeof SyncV2PushRequest>;

export const SyncV2Applied = z.strictObject({
  opId: SyncV2OperationId,
  // Absent only for an idempotent delete of a note that never existed here.
  resource: SyncV2NoteResource.optional(),
});
export type SyncV2Applied = z.infer<typeof SyncV2Applied>;

export const SyncV2Conflict = z.strictObject({
  opId: SyncV2OperationId,
  reason: z.literal('version_mismatch'),
  serverResource: SyncV2NoteResource,
});
export type SyncV2Conflict = z.infer<typeof SyncV2Conflict>;

function validateSyncV2PushResults(
  response: { applied: SyncV2Applied[]; conflicts: SyncV2Conflict[] },
  ctx: z.RefinementCtx,
): void {
  const results = [...response.applied, ...response.conflicts];
  if (results.length > SYNC_PUSH_LIMIT) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: `Sync response must contain at most ${SYNC_PUSH_LIMIT} results`,
    });
  }
  const seen = new Set<string>();
  results.forEach((result, index) => {
    if (seen.has(result.opId)) {
      const inApplied = index < response.applied.length;
      ctx.addIssue({
        code: 'custom',
        path: [
          inApplied ? 'applied' : 'conflicts',
          inApplied ? index : index - response.applied.length,
          'opId',
        ],
        message: 'opId values must be unique across a sync response',
      });
    }
    seen.add(result.opId);
  });
}

export const SyncV2PushResponse = z
  .strictObject({
    resourceSet: SyncV2ResourceSet,
    applied: z.array(SyncV2Applied).max(SYNC_PUSH_LIMIT),
    conflicts: z.array(SyncV2Conflict).max(SYNC_PUSH_LIMIT),
  })
  .superRefine(validateSyncV2PushResults);
export type SyncV2PushResponse = z.infer<typeof SyncV2PushResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Devices & billing
// ─────────────────────────────────────────────────────────────────────────────

export const RegisterDeviceRequest = z.object({
  id: PostgreSqlText.pipe(z.string().min(1).max(200)),
  name: PostgreSqlText.pipe(z.string().max(200)).default('Unnamed device'),
  platform: PostgreSqlText.pipe(z.string().max(50)).default('unknown'),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

export const CreateCheckoutResponse = z.object({
  /** URL to send the user to (Stripe Checkout, or a stub URL when Stripe is faked). */
  url: z.string(),
});
export type CreateCheckoutResponse = z.infer<typeof CreateCheckoutResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Uniform error envelope every endpoint returns on failure. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present only for a single-note `version_conflict`. */
    conflict: Note.optional(),
    /** Present when a sync idempotency collision names the bound operation. */
    operationId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
