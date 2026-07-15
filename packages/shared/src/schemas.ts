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

export const SubscriptionStatus = z.enum([
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

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
  /** Monotonic per-note version. Bumped on every save; matches the latest NoteVersion. */
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Soft-delete tombstone; sync propagates deletes without losing history. */
  deletedAt: z.string().nullable(),
});
export type Note = z.infer<typeof Note>;

export const NoteVersion = z.object({
  id: z.string(),
  noteId: z.string(),
  workspaceId: z.string(),
  version: z.number().int().nonnegative(),
  title: z.string(),
  bodyMd: z.string(),
  authorType: ActorType,
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
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

// ─────────────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────────────

export const CreateNoteRequest = z.object({
  title: z.string().max(500).default(''),
  bodyMd: z.string().default(''),
  folder: z.string().max(500).nullish(),
  /** Optional client-supplied id so local-first creates keep a stable identity. */
  id: z.string().optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;

export const UpdateNoteRequest = z.object({
  title: z.string().max(500).optional(),
  bodyMd: z.string().optional(),
  folder: z.string().max(500).nullish(),
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

export const NoteVersionListResponse = z.object({
  versions: z.array(NoteVersion),
});
export type NoteVersionListResponse = z.infer<typeof NoteVersionListResponse>;

export const RestoreVersionRequest = z.object({
  versionId: z.string(),
});
export type RestoreVersionRequest = z.infer<typeof RestoreVersionRequest>;

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
});
export type ActivityListResponse = z.infer<typeof ActivityListResponse>;

export const UndoResponse = z.object({
  /** The activity entry that recorded the undo (append-only compensation). */
  undo: ActivityEntry,
  /** The note as it stands after the undo. Null if the undo re-deleted the note. */
  note: Note.nullable(),
});
export type UndoResponse = z.infer<typeof UndoResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Sync (local-first change-feed; see ADR-005)
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque monotonic cursor; the client stores it and passes it back to pull deltas. */
export const SyncChangesResponse = z.object({
  changes: z.array(Note),
  cursor: z.string(),
  hasMore: z.boolean(),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponse>;

export const SyncMutation = z.object({
  /** Client-generated idempotency key so retries don't double-apply. */
  opId: z.string(),
  type: z.enum(['upsert', 'delete']),
  note: z.object({
    id: z.string(),
    title: z.string(),
    bodyMd: z.string(),
    folder: z.string().nullable(),
  }),
  /** The version this mutation was derived from (0 for a brand-new note). */
  baseVersion: z.number().int().nonnegative(),
});
export type SyncMutation = z.infer<typeof SyncMutation>;

export const SyncPushRequest = z.object({
  deviceId: z.string(),
  mutations: z.array(SyncMutation),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequest>;

export const SyncConflict = z.object({
  opId: z.string(),
  reason: z.literal('version_mismatch'),
  /** The authoritative server state the client must reconcile against. */
  serverNote: Note,
});
export type SyncConflict = z.infer<typeof SyncConflict>;

export const SyncPushResponse = z.object({
  // `note` is absent only for an idempotent delete of a note that never existed here.
  applied: z.array(z.object({ opId: z.string(), note: Note.optional() })),
  conflicts: z.array(SyncConflict),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Devices & billing
// ─────────────────────────────────────────────────────────────────────────────

export const RegisterDeviceRequest = z.object({
  id: z.string(),
  name: z.string().max(200).default('Unnamed device'),
  platform: z.string().max(50).default('unknown'),
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
    /** Present on 409 conflicts: the server state to reconcile against. */
    conflict: Note.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
