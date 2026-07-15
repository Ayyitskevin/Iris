/**
 * Drizzle schema — the typed query surface. It mirrors `migrations/0001_init.sql`
 * (hand-authored so it can carry RLS policies). Keep the two in sync.
 *
 * Tenant rule (ADR-003): every tenant-owned table has a non-null `workspace_id`. There
 * is no query in this codebase that touches a tenant table without scoping to it.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
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
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    bodyMd: text('body_md').notNull().default(''),
    folder: text('folder'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  // Drives the sync change-feed cursor (updated_at, id). See ADR-005.
  (t) => [index('notes_sync_idx').on(t.workspaceId, t.updatedAt, t.id)],
);

export const noteVersions = pgTable(
  'note_versions',
  {
    id: uuid('id').primaryKey(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    authorType: text('author_type').notNull(),
    authorId: uuid('author_id').notNull(),
    authorName: text('author_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('note_versions_unique').on(t.noteId, t.version)],
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

export const devices = pgTable('devices', {
  // Client-generated (Expo installation id, etc.) — text, not necessarily a UUID.
  id: text('id').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  noteVersions,
  agentTokens,
  activityLog,
  devices,
  subscriptions,
};
