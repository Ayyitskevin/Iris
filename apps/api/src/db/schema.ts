/**
 * Drizzle schema — the typed query surface. It mirrors `migrations/0001_init.sql`
 * (hand-authored so it can carry RLS policies). Keep the two in sync.
 *
 * Tenant rule (ADR-003): every tenant-owned table has a non-null `workspace_id`. There
 * is no query in this codebase that touches a tenant table without scoping to it.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AgentScope } from '@iris/shared';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  // Null when a managed auth provider owns the credential (ADR-004).
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Seam for teams/roles (ROADMAP). Foundation: always 'owner'.
    role: text('role').notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workspace_members_unique').on(t.workspaceId, t.userId)],
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    bodyMd: text('body_md').notNull().default(''),
    folder: text('folder'),
    // Organizational primitive alongside folders (phase 2). jsonb string array.
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    // Database-assigned workspace sequence used by Sync v2. A pair of database
    // triggers owns this value so transaction commit order cannot leave holes behind
    // an already-issued client cursor.
    // The zero default only makes DB-managed columns optional in Drizzle inserts.
    // iris_assign_note_sync_seq always replaces it before constraints are checked.
    syncSeq: bigint('sync_seq', { mode: 'bigint' }).notNull().default(0n),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // NOTE: a generated `search_vector tsvector` column also exists on this table
    // (migration 0002) for full-text search. It is DB-managed — never inserted or
    // selected through Drizzle — so it is deliberately not modeled here.
  },
  // Drives the Sync v2 change feed. sync_seq is unique within a workspace.
  (t) => [
    primaryKey({ name: 'notes_pkey', columns: [t.workspaceId, t.id] }),
    uniqueIndex('notes_sync_idx').on(t.workspaceId, t.syncSeq),
  ],
);

/**
 * One transactionally locked counter per workspace. The notes statement trigger locks
 * this row before PostgreSQL can lock note rows; the row trigger then increments it for
 * each changed note. That ordering makes sync_seq follow commit serialization instead
 * of sequence-allocation time.
 */
export const workspaceSyncCursors = pgTable(
  'workspace_sync_cursors',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull().default(0n),
  },
  (t) => [check('workspace_sync_cursors_last_seq_check', sql`${t.lastSeq} >= 0`)],
);

/**
 * Durable, exact sync-operation receipts. The request fingerprint binds an op id to
 * its actor, device, and payload; outcome is written in the same tenant transaction as
 * the note/version/activity mutation and replayed under its frozen receipt semantics.
 */
export const syncIdempotency = pgTable(
  'sync_idempotency',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    opId: text('op_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    deviceId: text('device_id').notNull(),
    // Freezes fingerprint/outcome interpretation for durable retries across releases.
    receiptVersion: smallint('receipt_version').notNull().default(1),
    requestFingerprint: text('request_fingerprint').notNull(),
    outcome: jsonb('outcome').$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.opId] }),
    check('sync_idempotency_receipt_version_check', sql`${t.receiptVersion} >= 1`),
  ],
);

export const noteVersions = pgTable(
  'note_versions',
  {
    id: uuid('id').primaryKey(),
    noteId: uuid('note_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    // false means this pre-0004 snapshot never recorded folder state. Keep the DB
    // default false so an older rolled-back server cannot manufacture a known root.
    folder: text('folder'),
    folderSnapshotKnown: boolean('folder_snapshot_known').notNull().default(false),
    // Tri-state: false = captured live, true = captured deleted, null = legacy
    // snapshot whose lifecycle state was never recorded. No default keeps old
    // binaries honest after a rolling migration.
    isDeleted: boolean('is_deleted'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    authorType: text('author_type').notNull(),
    authorId: uuid('author_id').notNull(),
    authorName: text('author_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'note_versions_note_id_fkey',
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }).onDelete('cascade'),
    uniqueIndex('note_versions_unique').on(t.workspaceId, t.noteId, t.version),
  ],
);

export const agentTokens = pgTable('agent_tokens', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentName: text('agent_name').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  scopes: jsonb('scopes').$type<AgentScope[]>().notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    noteId: uuid('note_id'),
    noteVersionId: uuid('note_version_id'),
    resultingVersion: integer('resulting_version'),
    // If this entry is an undo, the activity it reversed. Append-only: originals are
    // never mutated; "undone" is derived from the existence of such a row.
    undoOfId: uuid('undo_of_id'),
    createdAt: createdAt(),
  },
  (t) => [index('activity_feed_idx').on(t.workspaceId, t.createdAt)],
);

export const devices = pgTable(
  'devices',
  {
    // Client-generated (Expo installation id, etc.) — text, not necessarily a UUID.
    id: text('id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'devices_pkey', columns: [t.workspaceId, t.id] })],
);

export const subscriptions = pgTable('subscriptions', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull().default('free'),
  status: text('status').notNull().default('none'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type NoteRow = typeof notes.$inferSelect;
export type SyncIdempotencyRow = typeof syncIdempotency.$inferSelect;
export type NoteVersionRow = typeof noteVersions.$inferSelect;
export type AgentTokenRow = typeof agentTokens.$inferSelect;
export type ActivityRow = typeof activityLog.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;

export const schema = {
  workspaces,
  users,
  workspaceMembers,
  notes,
  workspaceSyncCursors,
  syncIdempotency,
  noteVersions,
  agentTokens,
  activityLog,
  devices,
  subscriptions,
};
