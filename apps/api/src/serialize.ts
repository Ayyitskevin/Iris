/**
 * Row → API-shape mappers. The DB returns Date objects and internal columns (e.g.
 * token hashes); the wire types (from @iris/shared) use ISO strings and never leak
 * secrets. This is the one place that translation happens.
 */
import type {
  ActivityEntry,
  AgentToken,
  Note,
  NoteVersion,
  User,
  Workspace,
} from '@iris/shared';
import type {
  ActivityRow,
  AgentTokenRow,
  NoteRow,
  NoteVersionRow,
  UserRow,
  WorkspaceRow,
} from './db/schema';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function serializeNote(r: NoteRow): Note {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    title: r.title,
    bodyMd: r.bodyMd,
    folder: r.folder,
    tags: r.tags ?? [],
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: iso(r.deletedAt),
  };
}

export function serializeVersion(r: NoteVersionRow): NoteVersion {
  return {
    id: r.id,
    noteId: r.noteId,
    workspaceId: r.workspaceId,
    version: r.version,
    title: r.title,
    bodyMd: r.bodyMd,
    tags: r.tags ?? [],
    authorType: r.authorType as NoteVersion['authorType'],
    authorId: r.authorId,
    authorName: r.authorName,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeAgentToken(r: AgentTokenRow): AgentToken {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    agentName: r.agentName,
    scopes: r.scopes,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    revokedAt: iso(r.revokedAt),
  };
}

export function serializeActivity(r: ActivityRow, undone: boolean): ActivityEntry {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    actorType: r.actorType as ActivityEntry['actorType'],
    actorId: r.actorId,
    actorName: r.actorName,
    action: r.action as ActivityEntry['action'],
    noteId: r.noteId,
    noteVersionId: r.noteVersionId,
    resultingVersion: r.resultingVersion,
    createdAt: r.createdAt.toISOString(),
    undone,
    undoOfId: r.undoOfId,
  };
}

export function serializeUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
  };
}
